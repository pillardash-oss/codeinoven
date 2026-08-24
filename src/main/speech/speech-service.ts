import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  SpeechCapability,
  SpeechCapabilitySnapshot,
  SpeechCleanupMode,
  SpeechCleanupProvenance,
  SpeechCaptureSessionInfo,
  SpeechDownloadState,
  SpeechError,
  SpeechHistoryPage,
  SpeechInstalledArtifact,
  SpeechModelArtifact,
  SpeechModelCatalog,
  SpeechProgressEvent,
  SpeechRecordingAttempt,
  SpeechPreparedPlayback,
  SpeechSynthesizedSegment,
  SpeechConfirmation,
  SpeechDestructiveAction,
  SpeechResult,
  SpeechRuntime,
  SpeechRuntimeAvailability,
  SpeechScope,
  SpeechCorrectionObservation,
  SpeechCorrectionRule,
  SpeechTranscriptionResult
} from '../../lib/speech/types'
import {
  MAX_SPEECH_CHUNK_BYTES,
  recommendedSpeechRuntime,
  resolveSpeechRuntime
} from '../../lib/speech/types'
import { parseSpeechModelCatalog } from '../../lib/speech/model-catalog'
import { buildParsedIdentityForValidation, CAPABILITY_RUNTIMES, describeSupportedFormatsForCapability, normalizePastedPath } from '../../lib/speech/model-path-validation'
import type { ModelPathValidationResult } from '../../lib/speech/types'
import { SpeechJobQueue, SpeechQueueError } from './speech-job-queue'
import { SpeechStorage } from './speech-storage'
import type { SpeechBackend } from './speech-backend'
import { SherpaSpeechBackend } from './backends/sherpa-backend'
import { MlxSpeechBackend } from './backends/mlx-backend'
import { CoreMlSpeechBackend } from './backends/coreml-backend'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import { SpeechCleanupService } from './speech-cleanup-service'
import { SpeechLearningService } from './speech-learning-service'
import { normalizeSpeechMarkdown } from '../../lib/speech/tts-normalizer'
import { TtsPlaybackService } from './tts-playback-service'

interface InstalledArtifactIndex {
  version: 1
  artifacts: SpeechInstalledArtifact[]
}

interface SpeechServicePaths {
  catalogPath: string
  mlxWorkerPath: string
}

export interface SpeechRemoteCleanupInput {
  transcript: string
  scope: SpeechScope
  selection: 'fixed' | 'conversation'
  modelId?: string
}

export interface SpeechRemoteCleanupOutput {
  text: string
  modelId: string
}

export type SpeechRemoteCleanupExecutor = (
  input: SpeechRemoteCleanupInput
) => Promise<SpeechRemoteCleanupOutput>

export interface SpeechAudioTranscribeInput {
  audio: Uint8Array<ArrayBuffer>
  language: string | 'auto'
  scope: SpeechScope
}

export interface SpeechAudioTranscribeOutput {
  text: string
  modelId: string
}

export type SpeechAudioTranscribeExecutor = (
  input: SpeechAudioTranscribeInput
) => Promise<SpeechAudioTranscribeOutput>

type SpeechProgressListener = (event: SpeechProgressEvent) => void

const DOWNLOAD_CHUNK_BYTES = 256 * 1024

/** Main-process coordinator. Native inference is delegated to bounded workers. */
export class SpeechService {
  private readonly storage: SpeechStorage
  private readonly queue = new SpeechJobQueue()
  private readonly backends: Map<SpeechRuntime, SpeechBackend>
  private readonly listeners = new Set<SpeechProgressListener>()
  private readonly downloadControllers = new Map<string, AbortController>()
  private catalog: SpeechModelCatalog | null = null
  private installed: InstalledArtifactIndex = { version: 1, artifacts: [] }
  private readonly cleanup = new SpeechCleanupService()
  private readonly learning = new SpeechLearningService(
    join(getConfigRoot(), 'speech', 'corrections.json')
  )
  private readonly playback = new TtsPlaybackService()
  private readonly confirmations = new Map<string, SpeechConfirmation>()

  constructor(
    private readonly paths: SpeechServicePaths,
    storage?: SpeechStorage,
    private readonly remoteCleanup?: SpeechRemoteCleanupExecutor,
    private readonly transcribeAudio?: SpeechAudioTranscribeExecutor
  ) {
    this.storage = storage ?? new SpeechStorage()
    this.backends = new Map<SpeechRuntime, SpeechBackend>([
      ['sherpa-onnx', new SherpaSpeechBackend()],
      ['mlx', new MlxSpeechBackend(paths.mlxWorkerPath)],
      ['coreml', new CoreMlSpeechBackend()]
    ])
  }

  async initialize(): Promise<void> {
    await this.storage.initialize()
    await this.learning.initialize()
    this.catalog = parseSpeechModelCatalog(
      JSON.parse(await readFile(this.paths.catalogPath, 'utf8'))
    )
    await this.loadInstalledIndex()
  }

  onProgress(listener: SpeechProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async capabilities(): Promise<SpeechCapabilitySnapshot> {
    const target = this.platformTarget()
    const runtimes: SpeechRuntimeAvailability[] = await Promise.all(
      [...this.backends.entries()].map(async ([runtime, backend]) => {
        const capabilities = await backend.capabilities().catch(() => [])
        return {
          runtime,
          available: capabilities.length > 0,
          ...(capabilities.length === 0
            ? {
                reason:
                  runtime === 'mlx'
                    ? 'The packaged MLX worker is unavailable.'
                    : 'Runtime unavailable.'
              }
            : {})
        }
      })
    )
    const selected = resolveSpeechRuntime(target, runtimes)
    return {
      target,
      runtimes,
      recommendedRuntime: recommendedSpeechRuntime(target),
      ...(selected.ok ? { selectedRuntime: selected.value.runtime } : {}),
      installedArtifacts: this.installed.artifacts.map((artifact) => structuredClone(artifact))
    }
  }

  catalogSnapshot(): SpeechModelCatalog {
    return structuredClone(this.requireCatalog())
  }

  async beginCapture(scope: SpeechScope, mimeType: string): Promise<SpeechCaptureSessionInfo> {
    const started = await this.storage.beginCapture(scope, mimeType)
    const value = {
      sessionId: started.sessionId,
      attemptId: started.attempt.id,
      startedAt: started.attempt.createdAt
    }
    this.emit({
      kind: 'capture',
      capture: { state: 'recording', ...value }
    })
    return value
  }

  async recordPermissionFailure(
    scope: SpeechScope,
    message: string
  ): Promise<SpeechRecordingAttempt> {
    const attempt = await this.storage.recordPermissionFailure(scope, message)
    this.emit({ kind: 'history', attemptId: attempt.id, stage: 'failed' })
    return attempt
  }

  async appendCapture(sessionId: string, chunk: Uint8Array): Promise<number> {
    if (chunk.byteLength > MAX_SPEECH_CHUNK_BYTES) throw new RangeError('Audio chunk is too large.')
    return this.storage.appendCapture(sessionId, chunk)
  }

  async finishCapture(sessionId: string, durationMs: number): Promise<SpeechRecordingAttempt> {
    const attempt = await this.storage.finalizeCapture(sessionId, durationMs)
    this.emit({
      kind: 'capture',
      capture: { state: 'stopping', sessionId, attemptId: attempt.id }
    })
    return attempt
  }

  async failCapture(sessionId: string, message: string): Promise<SpeechRecordingAttempt> {
    const attempt = await this.storage.failCapture(sessionId, message)
    this.emit({ kind: 'history', attemptId: attempt.id, stage: 'failed' })
    return attempt
  }

  async markAttemptFailure(attemptId: string, message: string): Promise<SpeechRecordingAttempt> {
    const attempt = await this.storage.updateAttempt(attemptId, (current) => {
      if (
        current.stage === 'failed' &&
        current.errors.some(
          (failure) => failure.stage === 'transcribing' && failure.error.message === message
        )
      ) {
        return
      }
      current.stage = 'failed'
      current.errors.push({
        stage: 'transcribing',
        occurredAt: Date.now(),
        error: { code: 'transcription-failed', message, retryable: current.audioAvailable }
      })
    })
    this.emit({ kind: 'history', attemptId, stage: 'failed' })
    return attempt
  }

  async transcribe(
    attemptId: string,
    runtime: SpeechRuntime,
    artifactId: string,
    language: string | 'auto',
    cleanupMode: SpeechCleanupMode = { kind: 'local' }
  ): Promise<SpeechTranscriptionResult> {
    const artifact = this.requireSelectableArtifact(artifactId, runtime, 'asr')
    const backend = this.requireBackend(runtime)
    const queued = this.queue.enqueue({
      capability: 'asr',
      runtime,
      run: (signal) =>
        backend.transcribe(
          {
            artifact: { id: artifact.id, directory: this.artifactDirectory(artifact.id) },
            audioPath: this.storage.getAudioPath(attemptId),
            language
          },
          signal
        )
    })
    await this.storage.updateAttempt(attemptId, (attempt) => {
      attempt.stage = 'transcribing'
      attempt.runtime = runtime
      attempt.artifactId = artifactId
    })
    this.emit({
      kind: 'transcription',
      job: {
        id: queued.id,
        attemptId,
        runtime,
        artifactId,
        language,
        state: this.queue.state(queued.id) ?? { state: 'queued', position: 1 }
      }
    })
    try {
      const rawTranscript = await queued.result
      let finalTranscript = rawTranscript
      let cleanupProvenance: SpeechCleanupProvenance = {
        mode: 'none' as const,
        appliedRuleIds: [] as string[],
        failed: false
      }
      if (cleanupMode.kind === 'local') {
        try {
          const punctuated = await this.queue.enqueue({
            capability: 'cleanup',
            runtime,
            run: (signal) =>
              backend.cleanup(
                rawTranscript,
                {
                  id: artifact.id,
                  directory: this.storage.modelDirectory(artifact.id)
                },
                signal
              )
          }).result
          const cleaned = this.cleanup.applyRules(
            punctuated,
            this.learning.enabled(this.requireAttemptScope(attemptId))
          )
          finalTranscript = cleaned.text
          cleanupProvenance = {
            ...cleaned.provenance,
            runtime,
            artifactId: cleanupMode.artifactId
          }
        } catch (cause) {
          cleanupProvenance = this.cleanup.fallback(rawTranscript, cause).provenance
        }
      } else if (cleanupMode.kind === 'remote') {
        try {
          if (!this.remoteCleanup) throw new Error('Remote cleanup is unavailable.')
          const remote = await this.remoteCleanup({
            transcript: rawTranscript,
            scope: this.requireAttemptScope(attemptId),
            selection: cleanupMode.selection,
            ...(cleanupMode.modelId ? { modelId: cleanupMode.modelId } : {})
          })
          const cleaned = this.cleanup.applyRules(
            remote.text,
            this.learning.enabled(this.requireAttemptScope(attemptId))
          )
          finalTranscript = cleaned.text
          cleanupProvenance = {
            mode: 'remote',
            modelId: remote.modelId,
            appliedRuleIds: cleaned.provenance.appliedRuleIds,
            failed: false
          }
        } catch (cause) {
          cleanupProvenance = {
            ...this.cleanup.fallback(rawTranscript, cause).provenance,
            mode: 'remote'
          }
        }
      }
      await this.storage.updateAttempt(attemptId, (attempt) => {
        attempt.stage = 'completed'
        attempt.rawTranscript = rawTranscript
        attempt.cleanedTranscript = cleanupProvenance.failed ? undefined : finalTranscript
        attempt.finalTranscript = finalTranscript
        attempt.cleanupProvenance = cleanupProvenance
        if (cleanupProvenance.failed && cleanupProvenance.error) {
          attempt.errors.push({
            stage: 'cleaning',
            error: cleanupProvenance.error,
            occurredAt: Date.now()
          })
        }
      })
      this.emit({ kind: 'history', attemptId, stage: 'completed' })
      return { attemptId, jobId: queued.id, rawTranscript, finalTranscript }
    } catch (cause) {
      const error = this.asError(cause, 'transcription-failed')
      await this.storage.updateAttempt(attemptId, (attempt) => {
        attempt.stage = error.code === 'cancelled' ? 'cancelled' : 'failed'
        attempt.errors.push({ stage: 'transcribing', error, occurredAt: Date.now() })
      })
      throw cause
    }
  }

  async history(cursor?: string, limit?: number): Promise<SpeechHistoryPage> {
    return this.storage.listHistory(cursor, limit)
  }

  enforceHistoryLimit(limit: number): Promise<void> {
    return this.storage.enforceHistoryLimit(limit)
  }

  /**
   * Transcribe a finished recording by sending its audio to an audio-capable
   * conversation model. This path is only reachable when the user has opted in
   * via the default-`false` `voiceRecordingEnabled` setting; it never runs for
   * the local-ASR flow. The raw transcript then flows through cleanup as usual.
   */
  async transcribeAudioToLlm(
    attemptId: string,
    scope: SpeechScope,
    language: string | 'auto',
    cleanupMode: SpeechCleanupMode = { kind: 'local' }
  ): Promise<SpeechTranscriptionResult> {
    if (!this.transcribeAudio) {
      throw new Error('Audio-to-LLM transcription is unavailable.')
    }
    const attempt = this.storage.getAttempt(attemptId)
    if (!attempt?.audioAvailable) throw new Error('Recording audio is unavailable.')
    await this.storage.updateAttempt(attemptId, (current) => {
      current.stage = 'transcribing'
    })
    const audio = await this.storage.readAudio(attemptId)
    try {
      const remote = await this.transcribeAudio({ audio, language, scope })
      const rawTranscript = remote.text
      const finalized = await this.runCleanup(rawTranscript, cleanupMode, scope)
      await this.storage.updateAttempt(attemptId, (current) => {
        current.stage = 'completed'
        current.rawTranscript = rawTranscript
        current.cleanedTranscript = finalized.provenance.failed ? undefined : finalized.text
        current.finalTranscript = finalized.text
        current.cleanupProvenance = finalized.provenance
        if (finalized.provenance.failed && finalized.provenance.error) {
          current.errors.push({
            stage: 'cleaning',
            error: finalized.provenance.error,
            occurredAt: Date.now()
          })
        }
      })
      this.emit({ kind: 'history', attemptId, stage: 'completed' })
      return {
        attemptId,
        jobId: `audio-llm-${attemptId}`,
        rawTranscript,
        finalTranscript: finalized.text
      }
    } catch (cause) {
      const error = this.asError(cause, 'audio-llm-unavailable')
      await this.storage.updateAttempt(attemptId, (current) => {
        current.stage = error.code === 'cancelled' ? 'cancelled' : 'failed'
        current.errors.push({
          stage: 'transcribing',
          error: { code: error.code, message: error.message, retryable: true },
          occurredAt: Date.now()
        })
      })
      this.emit({ kind: 'history', attemptId, stage: 'failed' })
      throw cause
    }
  }

  requestConfirmation(action: SpeechDestructiveAction, targetId: string): SpeechConfirmation {
    const confirmation: SpeechConfirmation = {
      token: randomUUID(),
      action,
      targetId,
      expiresAt: Date.now() + 60_000
    }
    this.confirmations.set(confirmation.token, confirmation)
    return confirmation
  }

  async deleteHistory(attemptId: string, token: string): Promise<void> {
    this.consumeConfirmation(token, 'history-item', attemptId)
    await this.storage.deleteAttempt(attemptId, true)
  }

  async deleteAllHistory(token: string): Promise<void> {
    this.consumeConfirmation(token, 'all-history', 'all')
    await this.storage.deleteAllAttempts()
  }

  readAudio(attemptId: string): Promise<Uint8Array<ArrayBuffer>> {
    return this.storage.readAudio(attemptId)
  }

  async deleteArtifact(artifactId: string, token: string): Promise<void> {
    this.consumeConfirmation(token, 'model', artifactId)
    await rm(this.storage.modelDirectory(artifactId), { recursive: true, force: true })
    this.installed.artifacts = this.installed.artifacts.filter(
      (item) => item.artifactId !== artifactId
    )
    await this.persistInstalledIndex()
  }

  async deleteCorrectionRuleConfirmed(ruleId: string, token: string): Promise<void> {
    this.consumeConfirmation(token, 'rule', ruleId)
    await this.learning.delete(ruleId)
  }

  /**
   * Validate a pasted filesystem path without registering it.
   * Runs entirely in the main process (filesystem access) and returns a
   * structured validation result for inline UI feedback. Never logs raw paths.
   */
  async validateModelPath(rawPath: string, capability: SpeechCapability = 'asr'): Promise<ModelPathValidationResult> {
    const { normalized, wasNormalized } = normalizePastedPath(rawPath)
    const cap: SpeechCapability = capability === 'asr' || capability === 'tts' || capability === 'cleanup' ? capability : 'asr'
    const allowed = CAPABILITY_RUNTIMES[cap]
    const hint = describeSupportedFormatsForCapability(cap)
    const parsedFor = (runtime: import('../../lib/speech/types').SpeechRuntime | null) => buildParsedIdentityForValidation(normalized, runtime)
    if (normalized.length === 0) {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'empty',
        reason: hint,
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    if (normalized.length > 4_096) {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'unsupported-format',
        reason: 'Path is too long. Paste a local file or folder path.',
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    const lower = normalized.toLowerCase()
    const isMlx =
      lower.endsWith('.mlx') ||
      lower.endsWith('/.mlx') ||
      lower.endsWith('\\mlx')
    const isGgufFile = lower.endsWith('.gguf')
    const isCoreMlFile = lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')
    const isOnnxFile = lower.endsWith('.onnx')
    // Stat the path (batched, non-blocking) - avoid blocking renderer
    let stat: { isFile: boolean; isDirectory: boolean } | null
    try {
      const { stat: fsStat } = await import('node:fs/promises')
      const s = await fsStat(normalized)
      stat = { isFile: s.isFile(), isDirectory: s.isDirectory() }
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code ?? ''
      if (code === 'ENOENT') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'not-found',
          reason: 'No file or folder exists at that path. Check the path and try again.',
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'permission-denied',
          reason: 'Permission denied at that path. Check access and try again.',
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'not-found',
        reason: 'That path cannot be read. Verify it and try again.',
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }

    const forbid = (runtime: string, reason: string): ModelPathValidationResult => ({
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      runtime: runtime as SpeechRuntime,
      code: 'unsupported-format',
      reason,
      detectedExtension: runtime === 'gguf' ? '.gguf' : runtime === 'mlx' ? '.mlx' : runtime === 'coreml' ? '.mlmodelc' : '.onnx',
      parsedIdentity: parsedFor(runtime as import('../../lib/speech/types').SpeechRuntime)
    })

    // Direct file hits - check capability before accepting
    if (isMlx) {
      if (!allowed.includes('mlx')) {
        return forbid('mlx', `MLX models cannot run as ${cap.toUpperCase()}. ${hint}`)
      }
      const target = this.platformTarget()
      if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'mlx',
          code: 'platform-unsupported',
          reason: 'MLX models are only supported on Apple Silicon.',
          detectedExtension: '.mlx'
        ,
      parsedIdentity: parsedFor('mlx' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'mlx',
        code: 'valid',
        reason: `Supported model found — MLX ${cap.toUpperCase()} — ready to import.`,
        detectedExtension: '.mlx'
      ,
      parsedIdentity: parsedFor('mlx' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    if (isGgufFile) {
      if (!allowed.includes('gguf')) {
        return forbid('gguf', `GGUF models only run as LLM / Cleanup, not as ${cap.toUpperCase()}. ${hint}`)
      }
      if (stat?.isDirectory) {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'unsupported-format',
          reason: 'That .gguf path is a directory. Paste the file path to the .gguf.',
          detectedExtension: '.gguf'
        ,
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'gguf',
        code: 'valid',
        reason: 'Supported model found — GGUF (LLM / Cleanup) — ready to import.',
        detectedExtension: '.gguf'
      ,
      parsedIdentity: parsedFor('gguf' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    if (isCoreMlFile) {
      if (!allowed.includes('coreml')) {
        return forbid('coreml', `Core ML bundles only run as ASR, not as ${cap.toUpperCase()}. ${hint}`)
      }
      const target = this.platformTarget()
      if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'coreml',
          code: 'platform-unsupported',
          reason: 'Core ML models are only supported on Apple Silicon.',
          detectedExtension: '.mlmodelc'
        ,
      parsedIdentity: parsedFor('coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'coreml',
        code: 'valid',
        reason: 'Supported model found — Core ML ASR bundle — ready to import.',
        detectedExtension: lower.endsWith('.mlpackage') ? '.mlpackage' : '.mlmodelc'
      ,
      parsedIdentity: parsedFor('coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    if (isOnnxFile) {
      if (!allowed.includes('sherpa-onnx')) {
        return forbid('sherpa-onnx', `ONNX models cannot run as ${cap.toUpperCase()} in this context. ${hint}`)
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'sherpa-onnx',
        code: 'valid',
        reason: 'Supported model found — sherpa-onnx (.onnx) — ready to import.',
        detectedExtension: '.onnx'
      ,
      parsedIdentity: parsedFor('sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }

    // Directory scans - contextual per capability
    if (stat?.isDirectory) {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(normalized, { withFileTypes: true })
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code ?? ''
        if (code === 'EACCES' || code === 'EPERM') {
          return {
            ok: false,
            capability: cap,
            normalizedPath: normalized,
            wasNormalized,
            code: 'permission-denied',
            reason: 'Permission denied reading that folder.',
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
        }
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'unsupported-format',
          reason: hint,
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      const lowerNames = entries.map((e) => e.name.toLowerCase())
      const hasGguf = lowerNames.some((n) => n.endsWith('.gguf'))
      const hasOnnx = lowerNames.some((n) => n.endsWith('.onnx'))
      const hasCoreMl = entries.some((e) => e.isDirectory() && (e.name.toLowerCase().endsWith('.mlmodelc') || e.name.toLowerCase().endsWith('.mlpackage')))
      const hasTokens = lowerNames.includes('tokens.txt')

      // Core ML bundle folder (e.g. FluidAudio parakeet-tdt-0.6b-v2)
      if (hasCoreMl) {
        if (!allowed.includes('coreml')) {
          return forbid('coreml', `That folder contains a Core ML bundle — only valid for ASR, not ${cap.toUpperCase()}. ${hint}`)
        }
        const target = this.platformTarget()
        if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
          return {
            ok: false,
            capability: cap,
            normalizedPath: normalized,
            wasNormalized,
            runtime: 'coreml',
            code: 'platform-unsupported',
            reason: 'Core ML models are only supported on Apple Silicon.',
            detectedExtension: '.mlmodelc'
          ,
      parsedIdentity: parsedFor('coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
        }
        return {
          ok: true,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'coreml',
          code: 'valid',
          reason: 'Supported model found — folder containing Core ML ASR bundle — ready to import.',
          detectedExtension: '.mlmodelc'
        ,
      parsedIdentity: parsedFor('coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      if (hasGguf) {
        if (!allowed.includes('gguf')) {
          return forbid('gguf', `That folder contains .gguf — only valid for LLM / Cleanup, not ${cap.toUpperCase()}. ${hint}`)
        }
        return {
          ok: true,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'gguf',
          code: 'valid',
          reason: 'Supported model found — folder containing .gguf — ready to import.',
          detectedExtension: '.gguf'
        ,
      parsedIdentity: parsedFor('gguf' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      if (hasOnnx) {
        if (!allowed.includes('sherpa-onnx')) {
          return forbid('sherpa-onnx', `That folder contains .onnx — not valid for ${cap.toUpperCase()}. ${hint}`)
        }
        // Heuristic: sherpa-onnx ASR/TTS expects tokens.txt sibling; warn but still accept
        if (cap === 'asr' && !hasTokens) {
          return {
            ok: true,
            capability: cap,
            normalizedPath: normalized,
            wasNormalized,
            runtime: 'sherpa-onnx',
            code: 'valid',
            reason: 'Found sherpa-onnx model (.onnx) — missing tokens.txt; may still import but verify the directory is a full sherpa model.',
            detectedExtension: '.onnx'
          ,
      parsedIdentity: parsedFor('sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
        }
        return {
          ok: true,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'sherpa-onnx',
          code: 'valid',
          reason: `Supported model found — sherpa-onnx ${cap.toUpperCase()} folder — ready to import.`,
          detectedExtension: '.onnx'
        ,
      parsedIdentity: parsedFor('sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
      }
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'unsupported-format',
        reason: hint,
        detectedExtension: undefined
      ,
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
    }
    // File with unsupported extension
    return {
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      code: 'unsupported-format',
      reason: hint,
      detectedExtension: undefined
    ,
      parsedIdentity: parsedFor(null as unknown as import('../../lib/speech/types').SpeechRuntime | null)
    }
  }

  async registerImportedModel(path: string, capability?: SpeechCapability): Promise<SpeechInstalledArtifact> {
    const normalized = path.trim()
    const lower = normalized.toLowerCase()
    const target = this.platformTarget()
    let runtime: SpeechRuntime
    if (lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')) {
      if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
        throw new Error('MLX models are only supported on Apple Silicon.')
      }
      runtime = 'mlx'
    } else if (lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')) {
      if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
        throw new Error('Core ML models are only supported on Apple Silicon.')
      }
      runtime = 'coreml'
    } else if (lower.endsWith('.onnx')) {
      runtime = 'sherpa-onnx'
    } else if (lower.endsWith('.gguf')) {
      runtime = 'gguf'
    } else {
      // Directory scan: detect GGUF / ONNX / Core ML bundle
      let hasGguf: boolean
      let hasOnnx: boolean
      let hasCoreMl: boolean
      try {
        const entries = await readdir(normalized, { withFileTypes: true })
        const lowerNames = entries.map((e) => e.name.toLowerCase())
        hasGguf = lowerNames.some((n) => n.endsWith('.gguf'))
        hasOnnx = lowerNames.some((n) => n.endsWith('.onnx'))
        hasCoreMl = entries.some((e) => e.isDirectory() && (e.name.toLowerCase().endsWith('.mlmodelc') || e.name.toLowerCase().endsWith('.mlpackage')))
      } catch {
        hasGguf = false
        hasOnnx = false
        hasCoreMl = false
      }
      if (hasCoreMl) {
        if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
          throw new Error('Core ML models are only supported on Apple Silicon.')
        }
        runtime = 'coreml'
      } else if (hasGguf) {
        runtime = 'gguf'
      } else if (hasOnnx) {
        runtime = 'sherpa-onnx'
      } else {
        throw new Error('Unsupported model format. Import a .mlx, .onnx, .mlmodelc/.mlpackage, or .gguf model.')
      }
    }
    try {
      await access(normalized)
    } catch {
      throw new Error('The model path does not exist.')
    }
    const artifactId = `imported-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
    const existing = this.installed.artifacts.find((item) => item.artifactId === artifactId)
    if (existing) {
      existing.importPath = normalized
      existing.available = true
      if (capability) existing.capability = capability
      await this.persistInstalledIndex()
      this.emit({ kind: 'history', attemptId: existing.artifactId, stage: 'completed' })
      return structuredClone(existing)
    }
    const artifact: SpeechInstalledArtifact = {
      artifactId,
      runtime,
      installedAt: Date.now(),
      source: 'import',
      externalReference: true,
      available: true,
      importPath: normalized,
      ...(capability ? { capability } : {})
    }
    this.installed.artifacts.push(artifact)
    await this.persistInstalledIndex()
    this.emit({ kind: 'history', attemptId: artifact.artifactId, stage: 'completed' })
    return structuredClone(artifact)
  }

  async unregisterImportedModel(artifactId: string, token: string): Promise<void> {
    this.consumeConfirmation(token, 'model', artifactId)
    const artifact = this.installed.artifacts.find(
      (item) => item.artifactId === artifactId && item.source === 'import'
    )
    if (!artifact) throw new Error('Imported model was not found.')
    this.installed.artifacts = this.installed.artifacts.filter(
      (item) => item.artifactId !== artifactId
    )
    await this.persistInstalledIndex()
    this.emit({ kind: 'history', attemptId: artifactId, stage: 'completed' })
  }

  async retryTranscription(
    attemptId: string,
    runtime: SpeechRuntime,
    artifactId: string,
    language: string | 'auto'
  ): Promise<SpeechTranscriptionResult> {
    const attempt = this.storage.getAttempt(attemptId)
    if (!attempt?.audioAvailable) throw new Error('Recording audio is unavailable.')
    const retryId = randomUUID()
    await this.storage.updateAttempt(attemptId, (current) => {
      current.retries.push({
        id: retryId,
        createdAt: Date.now(),
        runtime,
        artifactId,
        state: 'running'
      })
    })
    try {
      const result = await this.transcribe(attemptId, runtime, artifactId, language)
      await this.storage.updateAttempt(attemptId, (current) => {
        const retry = current.retries.find((item) => item.id === retryId)
        if (!retry) return
        retry.state = 'succeeded'
        retry.completedAt = Date.now()
        retry.rawTranscript = result.rawTranscript
        retry.cleanedTranscript = result.finalTranscript
      })
      return result
    } catch (cause) {
      await this.storage.updateAttempt(attemptId, (current) => {
        const retry = current.retries.find((item) => item.id === retryId)
        if (!retry) return
        retry.state = 'failed'
        retry.completedAt = Date.now()
        retry.error = this.asError(cause, 'transcription-failed')
      })
      throw cause
    }
  }

  correctionRules(scope?: SpeechScope): SpeechCorrectionRule[] {
    return this.learning.list(scope)
  }

  observeCorrection(
    observation: SpeechCorrectionObservation
  ): Promise<SpeechCorrectionRule | null> {
    return this.learning.observe(observation)
  }

  setCorrectionRuleEnabled(ruleId: string, enabled: boolean): Promise<SpeechCorrectionRule> {
    return this.learning.setEnabled(ruleId, enabled)
  }

  deleteCorrectionRule(ruleId: string, token: string): Promise<void> {
    return this.deleteCorrectionRuleConfirmed(ruleId, token)
  }

  preparePlayback(
    messageId: string,
    markdown: string,
    includeCodeBlocks: boolean
  ): SpeechPreparedPlayback {
    const segments = normalizeSpeechMarkdown(markdown, includeCodeBlocks)
    if (segments.length === 0) throw new Error('This response has no readable text.')
    const prepared = this.playback.prepare(messageId, segments)
    this.emit({
      kind: 'playback',
      playback: {
        state: 'preparing',
        sessionId: prepared.sessionId,
        messageId: prepared.messageId
      }
    })
    return prepared
  }

  async synthesizePlaybackSegment(
    sessionId: string,
    segmentIndex: number,
    runtime: SpeechRuntime,
    artifactId: string,
    voiceId: string
  ): Promise<SpeechSynthesizedSegment> {
    this.playback.assertActive(sessionId)
    const artifact = this.requireSelectableArtifact(artifactId, runtime, 'tts')
    const backend = this.requireBackend(runtime)
    const outputPath = this.storage.stagingFile(`${sessionId}.${segmentIndex}.${randomUUID()}.wav`)
    const prepared = this.playback.segment(sessionId, segmentIndex)
    const queued = this.queue.enqueue({
      capability: 'tts',
      runtime,
      run: (signal) =>
        backend.synthesize(
          {
            artifact: { id: artifact.id, directory: this.artifactDirectory(artifact.id) },
            text: prepared.text,
            voiceId,
            outputPath
          },
          signal
        )
    })
    try {
      await queued.result
      this.playback.assertActive(sessionId)
      return {
        sessionId,
        segmentIndex,
        audio: await this.playback.consumeAudio(outputPath)
      }
    } catch (cause) {
      await rm(outputPath, { force: true })
      throw cause
    }
  }

  cancelPlayback(sessionId?: string): boolean {
    return this.playback.cancel(sessionId)
  }

  async downloadArtifact(artifactId: string): Promise<void> {
    if (this.downloadControllers.has(artifactId))
      throw new Error('Model download is already active.')
    const artifact = this.requireCatalog().artifacts.find((item) => item.id === artifactId)
    if (!artifact) throw new Error('Model artifact was not found.')
    if (artifact.qualification.status !== 'qualified') {
      throw new Error('Model artifact has not passed qualification and cannot be downloaded.')
    }
    const controller = new AbortController()
    this.downloadControllers.set(artifactId, controller)
    const staging = this.storage.stagingFile(`${artifactId}.${randomUUID()}.download`)
    const destination = this.storage.modelDirectory(artifactId)
    let received = 0
    try {
      await mkdir(staging, { recursive: true })
      this.emitDownload(artifact, {
        state: 'downloading',
        bytesReceived: 0,
        totalBytes: artifact.byteSize
      })
      let lastEmitAt = 0
      for (const file of artifact.files) {
        const target = join(staging, file.path)
        await mkdir(dirname(target), { recursive: true })
        received += await this.downloadFile(
          file.sourceUrl,
          target,
          file.byteSize,
          file.sha256,
          controller.signal,
          (fileReceivedSoFar) => {
            const now = Date.now()
            if (now - lastEmitAt < 120) return
            lastEmitAt = now
            this.emitDownload(artifact, {
              state: 'downloading',
              bytesReceived: received + fileReceivedSoFar,
              totalBytes: artifact.byteSize
            })
          }
        )
        this.emitDownload(artifact, {
          state: 'downloading',
          bytesReceived: received,
          totalBytes: artifact.byteSize
        })
      }
      this.emitDownload(artifact, {
        state: 'verifying',
        bytesReceived: received,
        totalBytes: artifact.byteSize
      })
      const previous = `${destination}.${randomUUID()}.previous`
      const hadPrevious = await access(destination)
        .then(() => true)
        .catch(() => false)
      if (hadPrevious) await rename(destination, previous)
      try {
        await rename(staging, destination)
      } catch (cause) {
        if (hadPrevious) await rename(previous, destination).catch(() => undefined)
        throw cause
      }
      if (hadPrevious) await rm(previous, { recursive: true, force: true })
      const installedAt = Date.now()
      this.installed.artifacts = this.installed.artifacts.filter(
        (item) => item.artifactId !== artifactId
      )
      this.installed.artifacts.push({
        artifactId,
        runtime: artifact.runtime,
        revision: artifact.repositoryRevision,
        installedAt,
        byteSize: artifact.byteSize,
        source: 'download',
        externalReference: false,
        available: true
      })
      await this.persistInstalledIndex()
      this.emitDownload(artifact, { state: 'installed', installedAt })
    } catch (cause) {
      await rm(staging, { recursive: true, force: true })
      const cancelled = controller.signal.aborted
      this.emitDownload(
        artifact,
        cancelled
          ? { state: 'cancelled', cancelledAt: Date.now() }
          : { state: 'failed', failedAt: Date.now(), error: this.asError(cause, 'download-failed') }
      )
      throw cause
    } finally {
      this.downloadControllers.delete(artifactId)
    }
  }

  cancelDownload(artifactId: string): boolean {
    const controller = this.downloadControllers.get(artifactId)
    if (!controller) return false
    controller.abort()
    return true
  }

  cancelJob(jobId: string): boolean {
    return this.queue.cancel(jobId)
  }

  async dispose(): Promise<void> {
    for (const controller of this.downloadControllers.values()) controller.abort()
    this.downloadControllers.clear()
    await this.queue.dispose()
    await Promise.all([...this.backends.values()].map((backend) => backend.dispose()))
    await this.storage.dispose()
  }

  private async downloadFile(
    url: string,
    destination: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
    onProgress?: (receivedSoFar: number) => void
  ): Promise<number> {
    const response = await fetch(url, { signal, redirect: 'follow' })
    if (!response.ok || !response.body)
      throw new Error(`Download failed with HTTP ${response.status}.`)
    const stream = createWriteStream(destination, { flags: 'wx', mode: 0o600 })
    const streamError = new Promise<never>((_resolve, reject) => stream.once('error', reject))
    const hash = createHash('sha256')
    let received = 0
    try {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (let offset = 0; offset < value.byteLength; offset += DOWNLOAD_CHUNK_BYTES) {
          const chunk = value.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES)
          received += chunk.byteLength
          if (received > expectedBytes) {
            throw new Error('Downloaded model exceeds its catalog byte count.')
          }
          hash.update(chunk)
          onProgress?.(received)
          if (!stream.write(chunk)) {
            await Promise.race([
              new Promise<void>((resolve) => stream.once('drain', resolve)),
              streamError
            ])
          }
        }
      }
      await Promise.race([new Promise<void>((resolve) => stream.end(resolve)), streamError])
    } catch (cause) {
      stream.destroy()
      throw cause
    }
    if (received !== expectedBytes)
      throw new Error(`Downloaded ${received} bytes; expected ${expectedBytes}.`)
    const digest = hash.digest('hex')
    if (digest !== expectedSha256)
      throw new Error('Downloaded model checksum does not match the catalog.')
    return received
  }

  private requireSelectableArtifact(
    artifactId: string,
    runtime: SpeechRuntime,
    capability: SpeechModelArtifact['capability']
  ): SpeechModelArtifact {
    const catalogArtifact = this.requireCatalog().artifacts.find((item) => item.id === artifactId)
    if (catalogArtifact) {
      if (catalogArtifact.runtime !== runtime || catalogArtifact.capability !== capability) {
        throw new Error('The selected model is incompatible with this operation.')
      }
      if (catalogArtifact.qualification.status !== 'qualified')
        throw new Error('The selected model is not qualified.')
      const installed = this.installed.artifacts.find(
        (item) => item.artifactId === artifactId && item.available
      )
      if (!installed) throw new Error('The selected model is not installed.')
      return catalogArtifact
    }
    // Imported model: not in catalog but in installed index
    const imported = this.installed.artifacts.find(
      (item) => item.artifactId === artifactId && item.available && item.source === 'import'
    )
    if (imported) {
      if (imported.runtime !== runtime) {
        throw new Error('The selected model is incompatible with this operation.')
      }
      if (imported.capability && imported.capability !== capability) {
        throw new Error('The selected model is incompatible with this operation.')
      }
      // Synthesize a minimal qualified artifact for imported models
      return {
        id: imported.artifactId,
        familyId: 'whisper',
        capability,
        runtime: imported.runtime,
        label: imported.importPath?.split('/').pop()?.split('\\').pop() ?? imported.artifactId,
        description: `Imported model at ${imported.importPath ?? ''}`.trim(),
        tier: 'balanced',
        version: 'imported',
        repositoryRevision: 'imported',
        platforms: ['darwin', 'win32', 'linux'] as unknown as SpeechModelArtifact['platforms'],
        architectures: ['arm64', 'x64'] as unknown as SpeechModelArtifact['architectures'],
        languages: [],
        voices: [],
        files: [],
        byteSize: 0,
        license: 'user-provided',
        attribution: '',
        sourcePageUrl: '',
        minimumMemoryBytes: 0,
        qualification: {
          status: 'qualified' as const,
          licenseReviewed: true,
          compatibilityReviewed: true,
          checksumReviewed: true,
          benchmark: { status: 'passed' as const }
        }
      } as SpeechModelArtifact
    }
    throw new Error('The selected model is not installed.')
  }

  private artifactDirectory(artifactId: string): string {
    const installed = this.installed.artifacts.find((item) => item.artifactId === artifactId)
    if (installed?.source === 'import' && installed.importPath) return installed.importPath
    return this.storage.modelDirectory(artifactId)
  }

  private consumeConfirmation(
    token: string,
    action: SpeechDestructiveAction,
    targetId: string
  ): void {
    const confirmation = this.confirmations.get(token)
    this.confirmations.delete(token)
    if (
      !confirmation ||
      confirmation.action !== action ||
      confirmation.targetId !== targetId ||
      confirmation.expiresAt < Date.now()
    ) {
      throw new Error('Destructive confirmation is stale or invalid.')
    }
  }

  private requireAttemptScope(attemptId: string): SpeechScope {
    const attempt = this.storage.getAttempt(attemptId)
    if (!attempt) throw new Error('Recording attempt was not found.')
    return attempt.scope
  }

  private requireBackend(runtime: SpeechRuntime): SpeechBackend {
    const backend = this.backends.get(runtime)
    if (!backend) throw new Error(`Unsupported speech runtime: ${runtime}`)
    return backend
  }

  /** Resolve an installed, qualified cleanup artifact for a runtime, if any. */
  private installedCleanupArtifact(runtime: SpeechRuntime): SpeechModelArtifact | null {
    const artifact = this.requireCatalog().artifacts.find(
      (candidate) =>
        candidate.capability === 'cleanup' &&
        candidate.runtime === runtime &&
        candidate.qualification.status === 'qualified'
    )
    if (!artifact) return null
    const installed = this.installed.artifacts.find(
      (item) => item.artifactId === artifact.id && item.available && item.runtime === runtime
    )
    return installed ? artifact : null
  }

  /**
   * Apply cleanup to a transcript for the local-LLM / audio-to-LLM path. Prefers
   * an installed local cleanup model when present, otherwise applies learned
   * correction rules with no model, and never switches path silently on failure
   * (raw transcript is returned).
   */
  private async runCleanup(
    rawTranscript: string,
    mode: SpeechCleanupMode,
    scope: SpeechScope
  ): Promise<{
    text: string
    provenance: {
      mode: 'none' | 'local' | 'remote'
      runtime?: SpeechRuntime
      artifactId?: string
      modelId?: string
      appliedRuleIds: string[]
      failed: boolean
      error?: SpeechError
    }
  }> {
    if (mode.kind === 'disabled') {
      return { text: rawTranscript, provenance: { mode: 'none', appliedRuleIds: [], failed: false } }
    }
    if (mode.kind === 'remote') {
      try {
        if (!this.remoteCleanup) throw new Error('Remote cleanup is unavailable.')
        const remote = await this.remoteCleanup({
          transcript: rawTranscript,
          scope,
          selection: mode.selection,
          ...(mode.modelId ? { modelId: mode.modelId } : {})
        })
        const cleaned = this.cleanup.applyRules(remote.text, this.learning.enabled(scope))
        return {
          text: cleaned.text,
          provenance: {
            mode: 'remote',
            modelId: remote.modelId,
            appliedRuleIds: cleaned.provenance.appliedRuleIds,
            failed: false
          }
        }
      } catch (cause) {
        const fallback = this.cleanup.fallback(rawTranscript, cause)
        return { text: fallback.text, provenance: { ...fallback.provenance, mode: 'remote' } }
      }
    }
    try {
      const runtime = this.currentRuntime()
      const artifact = this.installedCleanupArtifact(runtime)
      const punctuated = artifact
        ? await this.queue
            .enqueue({
              capability: 'cleanup',
              runtime,
              run: (signal) =>
                this.requireBackend(runtime).cleanup(
                  rawTranscript,
                  { id: artifact.id, directory: this.artifactDirectory(artifact.id) },
                  signal
                )
            })
            .result.catch(() => rawTranscript)
        : rawTranscript
      const cleaned = this.cleanup.applyRules(punctuated, this.learning.enabled(scope))
      return {
        text: cleaned.text,
        provenance: {
          ...cleaned.provenance,
          mode: 'local',
          ...(artifact ? { runtime, artifactId: artifact.id } : {})
        }
      }
    } catch (cause) {
      const fallback = this.cleanup.fallback(rawTranscript, cause)
      return { text: fallback.text, provenance: { ...fallback.provenance, mode: 'local' } }
    }
  }

  private currentRuntime(): SpeechRuntime {
    return recommendedSpeechRuntime(this.platformTarget())
  }

  private requireCatalog(): SpeechModelCatalog {
    if (!this.catalog) throw new Error('Speech service is not initialized.')
    return this.catalog
  }

  private platformTarget(): SpeechCapabilitySnapshot['target'] {
    const platform = process.platform
    const architecture = process.arch
    if (!['darwin', 'win32', 'linux'].includes(platform)) {
      return { platform: 'linux', architecture: architecture === 'arm64' ? 'arm64' : 'x64' }
    }
    return {
      platform: platform as SpeechCapabilitySnapshot['target']['platform'],
      architecture: architecture === 'arm64' ? 'arm64' : 'x64'
    }
  }

  private emit(event: SpeechProgressEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private emitDownload(artifact: SpeechModelArtifact, download: SpeechDownloadState): void {
    this.emit({ kind: 'download', artifactId: artifact.id, download })
  }

  private installedIndexPath(): string {
    return join(this.storage.modelDirectory('artifact-index'), 'installed.json')
  }

  private async loadInstalledIndex(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.installedIndexPath(), 'utf8'))
      if (typeof raw === 'object' && raw !== null) {
        const candidate = raw as Record<string, unknown>
        if (candidate['version'] === 1 && Array.isArray(candidate['artifacts'])) {
          this.installed = candidate as unknown as InstalledArtifactIndex
        }
      }
    } catch (cause) {
      const code = cause instanceof Error && 'code' in cause ? String(cause.code) : ''
      if (code !== 'ENOENT') Logger.error('Could not load speech model index', cause)
    }
    for (const artifact of this.installed.artifacts) {
      artifact.available = await access(this.storage.modelDirectory(artifact.artifactId))
        .then(() => true)
        .catch(() => false)
    }
  }

  private async persistInstalledIndex(): Promise<void> {
    const path = this.installedIndexPath()
    await mkdir(dirname(path), { recursive: true })
    const staging = `${path}.${randomUUID()}.tmp`
    await writeFile(staging, `${JSON.stringify(this.installed, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(staging, path)
  }

  private asError(cause: unknown, fallback: SpeechError['code']): SpeechError {
    if (cause instanceof SpeechQueueError) return cause.speechError
    return {
      code: fallback,
      message: cause instanceof Error ? cause.message : String(cause),
      retryable: true
    }
  }
}

export function speechResult<T>(operation: () => Promise<T>): Promise<SpeechResult<T>> {
  return operation().then(
    (value) => ({ ok: true, value }),
    (cause: unknown) => ({
      ok: false,
      error: speechIpcError(cause)
    })
  )
}

function speechIpcError(cause: unknown): SpeechError {
  if (cause instanceof SpeechQueueError) return cause.speechError
  const message = cause instanceof Error ? cause.message : String(cause)
  const normalized = message.toLowerCase()
  const code: SpeechError['code'] =
    cause instanceof RangeError
      ? 'invalid-request'
      : normalized.includes('stale')
        ? 'capture-session-stale'
        : normalized.includes('disk space')
          ? 'insufficient-disk'
          : normalized.includes('checksum')
            ? 'checksum-mismatch'
            : normalized.includes('not qualified')
              ? 'model-not-qualified'
              : normalized.includes('not installed')
                ? 'model-unavailable'
                : normalized.includes('incompatible')
                  ? 'model-incompatible'
                  : normalized.includes('not found')
                    ? 'not-found'
                    : normalized.includes('cancel')
                      ? 'cancelled'
                      : normalized.includes('download')
                        ? 'download-failed'
                        : 'backend-failed'
  return { code, message, retryable: code !== 'invalid-request' && code !== 'model-incompatible' }
}
