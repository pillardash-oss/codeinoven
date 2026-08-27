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
  SpeechLesson,
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
  SpeechLearningObservation,
  SpeechTranscriptionResult
} from '../../lib/speech/types'
import {
  DEFAULT_SPEECH_SETTINGS,
  MAX_SPEECH_CHUNK_BYTES,
  recommendedSpeechRuntime,
  resolveSpeechRuntime
} from '../../lib/speech/types'
import type { SpeechUnloadOption } from '../../lib/speech/types'
import { parseSpeechModelCatalog } from '../../lib/speech/model-catalog'
import {
  buildParsedIdentityForValidation,
  CAPABILITY_RUNTIMES,
  describeSupportedFormatsForCapability,
  normalizePastedPath
} from '../../lib/speech/model-path-validation'
import type { ModelPathValidationResult } from '../../lib/speech/types'
import { SpeechJobQueue, SpeechQueueError } from './speech-job-queue'
import { SpeechStorage } from './speech-storage'
import type { SpeechBackend } from './speech-backend'
import { SherpaSpeechBackend } from './backends/sherpa-backend'
import { MlxSpeechBackend } from './backends/mlx-backend'
import { CoreMlSpeechBackend } from './backends/coreml-backend'
import {
  LlamaServerSpeechBackend,
  setLlamaServerBinary
} from './backends/llama-backend'
import { LlamaRuntimeService } from './llama-runtime-service'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import { SpeechCleanupService } from './speech-cleanup-service'
import { SpeechLearningService } from './speech-learning-service'
import { normalizeSpeechMarkdown } from '../../lib/speech/tts-normalizer'
import { TtsPlaybackService } from './tts-playback-service'
import { NativeSpeechCapture } from './native-speech-capture'

interface InstalledArtifactIndex {
  version: 1
  artifacts: SpeechInstalledArtifact[]
}

interface SpeechServicePaths {
  catalogPath: string
  mlxWorkerPath: string
  coremlWorkerPath: string
  nativeCaptureWorkerPath: string
}

const UNLOAD_MS: Record<Exclude<SpeechUnloadOption, 'keep'>, number> = {
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '20m': 20 * 60_000,
  '30m': 30 * 60_000
}

const CAPABILITY_RUNTIME_MAP: Record<SpeechCapability, SpeechRuntime[]> = {
  asr: ['sherpa-onnx', 'mlx', 'coreml'],
  cleanup: ['gguf'],
  tts: ['sherpa-onnx', 'mlx']
}

function unloadMs(option: SpeechUnloadOption): number | null {
  if (option === 'keep') return null
  return UNLOAD_MS[option]
}

/** Cleanup prompt protocol required by the artifact's model family. */
function cleanupProfileFor(artifact: SpeechModelArtifact): 'instruct' | 'normalizer' {
  return artifact.familyId === 's1-cleanup' ? 'normalizer' : 'instruct'
}

export interface SpeechRemoteCleanupInput {
  transcript: string
  scope: SpeechScope
  selection: 'fixed' | 'conversation'
  modelId?: string
  /** Lessons the remote cleanup prompt should apply as style constraints. */
  lessons?: SpeechLesson[]
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
  private readonly learning: SpeechLearningService
  private readonly llamaRuntime = new LlamaRuntimeService()
  private readonly playback = new TtsPlaybackService()
  private readonly nativeCapture: NativeSpeechCapture
  private readonly confirmations = new Map<string, SpeechConfirmation>()
  private unloadOptions: Record<SpeechCapability, SpeechUnloadOption> = {
    asr: DEFAULT_SPEECH_SETTINGS.asrUnload,
    cleanup: DEFAULT_SPEECH_SETTINGS.cleanupUnload,
    tts: DEFAULT_SPEECH_SETTINGS.ttsUnload
  }
  private readonly unloadTimers = new Map<SpeechCapability, NodeJS.Timeout>()
  private readonly lastUsed = new Map<SpeechCapability, number>()

  constructor(
    private readonly paths: SpeechServicePaths,
    storage?: SpeechStorage,
    private readonly remoteCleanup?: SpeechRemoteCleanupExecutor,
    private readonly transcribeAudio?: SpeechAudioTranscribeExecutor
  ) {
    this.nativeCapture = new NativeSpeechCapture(paths.nativeCaptureWorkerPath)
    this.storage = storage ?? new SpeechStorage()
    this.learning = new SpeechLearningService(
      join(getConfigRoot(), 'speech', 'lessons.json'),
      (insertedText, sentText, mode) =>
        this.learnLessonsFromCorrection(insertedText, sentText, mode)
    )
    this.backends = new Map<SpeechRuntime, SpeechBackend>([
      ['sherpa-onnx', new SherpaSpeechBackend()],
      ['mlx', new MlxSpeechBackend(paths.mlxWorkerPath)],
      ['coreml', new CoreMlSpeechBackend(paths.coremlWorkerPath)],
      ['gguf', new LlamaServerSpeechBackend()]
    ])
  }

  async initialize(): Promise<void> {
    await this.storage.initialize()
    await this.learning.initialize()
    await this.refreshLlamaRuntime()
    this.catalog = parseSpeechModelCatalog(
      JSON.parse(await readFile(this.paths.catalogPath, 'utf8'))
    )
    await this.loadInstalledIndex()
  }

  /** Resolve the discover-or-download llama.cpp runtime for cleanup inference. */
  async refreshLlamaRuntime(): Promise<void> {
    const status = await this.llamaRuntime.status(true)
    if (status.selectedPath) {
      setLlamaServerBinary(status.selectedPath)
    } else {
      setLlamaServerBinary(null)
    }
  }

  async downloadLlamaRuntime(signal?: AbortSignal): Promise<void> {
    await this.llamaRuntime.download(signal)
    await this.refreshLlamaRuntime()
  }

  llamaRuntimeStatus(): ReturnType<LlamaRuntimeService['status']> {
    return this.llamaRuntime.status()
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
                    : runtime === 'coreml'
                      ? 'The packaged Core ML worker or audio decoder is unavailable.'
                      : 'Runtime unavailable.'
              }
            : {})
        }
      })
    )
    const runtimeAvailability = new Map(runtimes.map((runtime) => [runtime.runtime, runtime]))
    const selected = resolveSpeechRuntime(target, runtimes)
    return {
      target,
      runtimes,
      recommendedRuntime: recommendedSpeechRuntime(target),
      ...(selected.ok ? { selectedRuntime: selected.value.runtime } : {}),
      installedArtifacts: this.installed.artifacts.map((artifact) => {
        const runtime = runtimeAvailability.get(artifact.runtime)
        if (artifact.available && runtime && !runtime.available) {
          return structuredClone({
            ...artifact,
            available: false,
            unavailableReason: runtime.reason ?? 'Runtime unavailable.'
          })
        }
        return structuredClone(artifact)
      })
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

  async beginNativeCapture(scope: SpeechScope): Promise<SpeechCaptureSessionInfo> {
    if (!(await this.nativeCapture.available())) {
      throw new Error('Native microphone recording is unavailable on this device.')
    }
    const started = await this.storage.beginNativeCapture(scope)
    try {
      await this.nativeCapture.start(started.sessionId, started.stagingPath)
    } catch (cause) {
      await this.storage.failCapture(
        started.sessionId,
        this.asError(cause, 'capture-device-lost').message
      )
      throw cause
    }
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

  async finishNativeCapture(
    sessionId: string,
    durationMs: number
  ): Promise<SpeechRecordingAttempt> {
    await this.nativeCapture.stop(sessionId)
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

  async failNativeCapture(sessionId: string, message: string): Promise<SpeechRecordingAttempt> {
    await this.nativeCapture.stop(sessionId).catch(() => undefined)
    return this.failCapture(sessionId, message)
  }

  async markAttemptFailure(attemptId: string, message: string): Promise<SpeechRecordingAttempt> {
    Logger.error('Speech attempt failed', { attemptId, error: message })
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
    this.clearEvict('asr')
    if (cleanupMode.kind === 'local') this.clearEvict('cleanup')
    const artifact = this.requireSelectableArtifact(artifactId, runtime, 'asr')
    const backend = this.requireBackend(runtime)
    const modelFamily =
      artifact.files.length > 0 &&
      (artifact.familyId === 'whisper' || artifact.familyId === 'parakeet')
        ? artifact.familyId
        : undefined
    const queued = this.queue.enqueue({
      capability: 'asr',
      runtime,
      run: (signal) =>
        backend.transcribe(
          {
            artifact: {
              id: artifact.id,
              directory: this.artifactDirectory(artifact.id),
              ...(modelFamily ? { modelFamily } : {})
            },
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
      const rawTranscript = (await queued.result).trim()
      if (rawTranscript.length === 0) {
        throw new Error('The speech runtime returned an empty transcript.')
      }
      let finalTranscript = rawTranscript
      let cleanupProvenance: SpeechCleanupProvenance = {
        mode: 'none' as const,
        appliedLessonIds: [],
        failed: false
      }
      if (cleanupMode.kind !== 'disabled') {
        const cleaned = await this.runCleanup(
          rawTranscript,
          cleanupMode,
          this.requireAttemptScope(attemptId)
        )
        finalTranscript = cleaned.text
        cleanupProvenance = cleaned.provenance
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
      this.touch('asr')
      // Cleanup provenance may have touched cleanup model — also refresh cleanup timer if local cleanup used
      if (cleanupMode.kind === 'local' && cleanupProvenance.mode === 'local' && !cleanupProvenance.failed) {
        this.touch('cleanup')
      }
      return { attemptId, jobId: queued.id, rawTranscript, finalTranscript }
    } catch (cause) {
      const error = this.asError(cause, 'transcription-failed')
      Logger.error('Speech transcription failed', {
        attemptId,
        runtime,
        artifactId,
        jobId: queued.id,
        error: error.message
      })
      await this.storage.updateAttempt(attemptId, (attempt) => {
        attempt.stage = error.code === 'cancelled' ? 'cancelled' : 'failed'
        attempt.errors.push({ stage: 'transcribing', error, occurredAt: Date.now() })
      })
      throw cause
    }
  }

  async preloadAsr(runtime: SpeechRuntime, artifactId: string): Promise<void> {
    const artifact = this.requireSelectableArtifact(artifactId, runtime, 'asr')
    const backend = this.requireBackend(runtime)
    if (backend.warmup) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 15_000)
      try {
        await backend.warmup(
          {
            id: artifact.id,
            directory: this.artifactDirectory(artifact.id),
            ...(artifact.familyId === 'whisper' || artifact.familyId === 'parakeet'
              ? { modelFamily: artifact.familyId as 'whisper' | 'parakeet' }
              : {})
          },
          ac.signal
        )
        this.touch('asr')
      } catch {
        // Warmup is best-effort; transcription will surface real errors.
      } finally {
        clearTimeout(timer)
      }
    } else {
      this.touch('asr')
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

  /**
   * Validate a pasted filesystem path without registering it.
   * Runs entirely in the main process (filesystem access) and returns a
   * structured validation result for inline UI feedback. Never logs raw paths.
   */
  async validateModelPath(
    rawPath: string,
    capability: SpeechCapability = 'asr'
  ): Promise<ModelPathValidationResult> {
    const { normalized, wasNormalized } = normalizePastedPath(rawPath)
    const cap: SpeechCapability =
      capability === 'asr' || capability === 'tts' || capability === 'cleanup' ? capability : 'asr'
    const allowed = CAPABILITY_RUNTIMES[cap]
    const hint = describeSupportedFormatsForCapability(cap)
    const parsedFor = (runtime: import('../../lib/speech/types').SpeechRuntime | null) =>
      buildParsedIdentityForValidation(normalized, runtime)
    if (normalized.length === 0) {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'empty',
        reason: hint,
        parsedIdentity: parsedFor(
          null as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
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
        parsedIdentity: parsedFor(
          null as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    const lower = normalized.toLowerCase()
    const isMlx = lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')
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
          parsedIdentity: parsedFor(
            null as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
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
          parsedIdentity: parsedFor(
            null as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'not-found',
        reason: 'That path cannot be read. Verify it and try again.',
        parsedIdentity: parsedFor(
          null as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
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
      detectedExtension:
        runtime === 'gguf'
          ? '.gguf'
          : runtime === 'mlx'
            ? '.mlx'
            : runtime === 'coreml'
              ? '.mlmodelc'
              : '.onnx',
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
          detectedExtension: '.mlx',
          parsedIdentity: parsedFor(
            'mlx' as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
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
        detectedExtension: '.mlx',
        parsedIdentity: parsedFor(
          'mlx' as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (isGgufFile) {
      if (!allowed.includes('gguf')) {
        return forbid(
          'gguf',
          `GGUF models only run as LLM / Cleanup, not as ${cap.toUpperCase()}. ${hint}`
        )
      }
      if (stat?.isDirectory) {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'unsupported-format',
          reason: 'That .gguf path is a directory. Paste the file path to the .gguf.',
          detectedExtension: '.gguf',
          parsedIdentity: parsedFor(
            null as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
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
        detectedExtension: '.gguf',
        parsedIdentity: parsedFor(
          'gguf' as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (isCoreMlFile) {
      if (!allowed.includes('coreml')) {
        return forbid(
          'coreml',
          `Core ML bundles only run as ASR, not as ${cap.toUpperCase()}. ${hint}`
        )
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
          detectedExtension: '.mlmodelc',
          parsedIdentity: parsedFor(
            'coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
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
        detectedExtension: lower.endsWith('.mlpackage') ? '.mlpackage' : '.mlmodelc',
        parsedIdentity: parsedFor(
          'coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (isOnnxFile) {
      if (!allowed.includes('sherpa-onnx')) {
        return forbid(
          'sherpa-onnx',
          `ONNX models cannot run as ${cap.toUpperCase()} in this context. ${hint}`
        )
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'sherpa-onnx',
        code: 'valid',
        reason: 'Supported model found — sherpa-onnx (.onnx) — ready to import.',
        detectedExtension: '.onnx',
        parsedIdentity: parsedFor(
          'sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
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
            parsedIdentity: parsedFor(
              null as unknown as import('../../lib/speech/types').SpeechRuntime | null
            )
          }
        }
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'unsupported-format',
          reason: hint,
          parsedIdentity: parsedFor(
            null as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      const lowerNames = entries.map((e) => e.name.toLowerCase())
      const hasGguf = lowerNames.some((n) => n.endsWith('.gguf'))
      const hasOnnx = lowerNames.some((n) => n.endsWith('.onnx'))
      const hasCoreMl = entries.some(
        (e) =>
          e.isDirectory() &&
          (e.name.toLowerCase().endsWith('.mlmodelc') ||
            e.name.toLowerCase().endsWith('.mlpackage'))
      )
      const hasTokens = lowerNames.includes('tokens.txt')

      // Core ML bundle folder (e.g. FluidAudio parakeet-tdt-0.6b-v2)
      if (hasCoreMl) {
        if (!allowed.includes('coreml')) {
          return forbid(
            'coreml',
            `That folder contains a Core ML bundle — only valid for ASR, not ${cap.toUpperCase()}. ${hint}`
          )
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
            detectedExtension: '.mlmodelc',
            parsedIdentity: parsedFor(
              'coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null
            )
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
          detectedExtension: '.mlmodelc',
          parsedIdentity: parsedFor(
            'coreml' as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      if (hasGguf) {
        if (!allowed.includes('gguf')) {
          return forbid(
            'gguf',
            `That folder contains .gguf — only valid for LLM / Cleanup, not ${cap.toUpperCase()}. ${hint}`
          )
        }
        return {
          ok: true,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'gguf',
          code: 'valid',
          reason: 'Supported model found — folder containing .gguf — ready to import.',
          detectedExtension: '.gguf',
          parsedIdentity: parsedFor(
            'gguf' as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      if (hasOnnx) {
        if (!allowed.includes('sherpa-onnx')) {
          return forbid(
            'sherpa-onnx',
            `That folder contains .onnx — not valid for ${cap.toUpperCase()}. ${hint}`
          )
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
            reason:
              'Found sherpa-onnx model (.onnx) — missing tokens.txt; may still import but verify the directory is a full sherpa model.',
            detectedExtension: '.onnx',
            parsedIdentity: parsedFor(
              'sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null
            )
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
          detectedExtension: '.onnx',
          parsedIdentity: parsedFor(
            'sherpa-onnx' as unknown as import('../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'unsupported-format',
        reason: hint,
        detectedExtension: undefined,
        parsedIdentity: parsedFor(
          null as unknown as import('../../lib/speech/types').SpeechRuntime | null
        )
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
      detectedExtension: undefined,
      parsedIdentity: parsedFor(
        null as unknown as import('../../lib/speech/types').SpeechRuntime | null
      )
    }
  }

  async registerImportedModel(
    path: string,
    capability?: SpeechCapability
  ): Promise<SpeechInstalledArtifact> {
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
        hasCoreMl = entries.some(
          (e) =>
            e.isDirectory() &&
            (e.name.toLowerCase().endsWith('.mlmodelc') ||
              e.name.toLowerCase().endsWith('.mlpackage'))
        )
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
        throw new Error(
          'Unsupported model format. Import a .mlx, .onnx, .mlmodelc/.mlpackage, or .gguf model.'
        )
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

  lessons(scope?: SpeechScope): SpeechLesson[] {
    return this.learning.list(scope)
  }

  observeCorrection(observation: SpeechLearningObservation): Promise<SpeechLesson[]> {
    return this.learning.observe(observation)
  }

  setLessonEnabled(lessonId: string, enabled: boolean): Promise<SpeechLesson> {
    return this.learning.setEnabled(lessonId, enabled)
  }

  async deleteLesson(lessonId: string, token: string): Promise<void> {
    await this.consumeConfirmation(token, 'lesson', lessonId)
    return this.learning.delete(lessonId)
  }

  /**
   * Ask the local instruct cleanup model what the user's edit teaches us.
   * Called through the job queue so learning never overlaps cleanup inference.
   */
  private async learnLessonsFromCorrection(
    insertedText: string,
    sentText: string,
    mode: 'project' | 'chat'
  ): Promise<import('../../lib/speech/types').SpeechExtractedLesson[]> {
    const resolved = this.selectInstalledCleanupArtifact()
    if (!resolved) return []
    // Only instruct models can follow the lesson-extraction prompt. Specialized
    // normalizers like S1 mini are never asked to learn.
    if (cleanupProfileFor(resolved.artifact) !== 'instruct') return []
    if (resolved.artifact.familyId !== 'qwen-cleanup') return []
    const backend = this.requireBackend(resolved.runtime)
    if (!(backend instanceof LlamaServerSpeechBackend)) return []
    const extracted = await this.queue
      .enqueue({
        capability: 'cleanup',
        runtime: resolved.runtime,
        run: (signal) =>
          backend.learnFromCorrection(insertedText, sentText, mode, signal).then((value) => value ?? [])
      })
      .result
      .catch(() => [])
    return extracted
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
    // Cancel any pending idle evict while synthesis is in-flight
    this.clearEvict('tts')
    Logger.dev('Speech synthesis started', {
      sessionId,
      segmentIndex,
      runtime,
      artifactId,
      characters: prepared.text.length
    })
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
    // A misresolved local model path (e.g. an imported MLX model directory
    // that doesn't satisfy the native loader's local-model check) can make the
    // worker silently fall back to a network model-repo lookup with no
    // timeout of its own, hanging the request forever. Bound it here so the
    // UI always settles instead of spinning indefinitely.
    const timeout = setTimeout(() => this.queue.cancel(queued.id), 45_000)
    try {
      await queued.result
      this.playback.assertActive(sessionId)
      const audio = await this.playback.consumeAudio(outputPath)
      this.touch('tts')
      return {
        sessionId,
        segmentIndex,
        audio
      }
    } catch (cause) {
      await rm(outputPath, { force: true })
      Logger.error('Speech synthesis failed', {
        sessionId,
        segmentIndex,
        runtime,
        artifactId,
        jobId: queued.id,
        error: cause instanceof Error ? cause.message : String(cause)
      })
      throw cause
    } finally {
      clearTimeout(timeout)
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
    if (artifact.qualification.status === 'retired') {
      throw new Error('Retired model artifacts cannot be downloaded.')
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

  updateUnloadOptions(options: Partial<Record<SpeechCapability, SpeechUnloadOption>>): void {
    let changed = false
    for (const capability of ['asr', 'cleanup', 'tts'] as const) {
      const next = options[capability]
      if (next && next !== this.unloadOptions[capability]) {
        this.unloadOptions[capability] = next
        changed = true
        // reschedule with new delay based on last activity
        if (this.lastUsed.has(capability)) {
          this.scheduleEvict(capability)
        } else if (next === 'keep') {
          this.clearEvict(capability)
        }
      }
    }
    if (changed) {
      Logger.dev('Speech unload options updated', { ...this.unloadOptions })
    }
  }

  private touch(capability: SpeechCapability): void {
    this.lastUsed.set(capability, Date.now())
    // While work is active, ensure no pending evict races; reschedule after current work settles
    this.clearEvict(capability)
    // Don't schedule while a job is actively running for this capability
    if (this.isCapabilityBusy(capability)) return
    this.scheduleEvict(capability)
  }

  private clearEvict(capability: SpeechCapability): void {
    const timer = this.unloadTimers.get(capability)
    if (timer) {
      clearTimeout(timer)
      this.unloadTimers.delete(capability)
    }
  }

  private scheduleEvict(capability: SpeechCapability): void {
    this.clearEvict(capability)
    const option = this.unloadOptions[capability]
    const delay = unloadMs(option)
    if (delay === null) return
    const last = this.lastUsed.get(capability) ?? Date.now()
    // If we already have elapsed time, shorten first delay
    const elapsed = Date.now() - last
    const remaining = Math.max(500, delay - elapsed)
    const timer = setTimeout(() => {
      void this.evictCapability(capability)
    }, remaining)
    // Don't prevent app quit
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref?.()
    }
    this.unloadTimers.set(capability, timer)
  }

  private isCapabilityBusy(capability: SpeechCapability): boolean {
    for (const runtime of CAPABILITY_RUNTIME_MAP[capability]) {
      if (this.queue.hasActive(runtime) || this.queue.hasPending(runtime)) return true
    }
    return false
  }

  private async evictCapability(capability: SpeechCapability): Promise<void> {
    this.unloadTimers.delete(capability)
    const last = this.lastUsed.get(capability)
    const option = this.unloadOptions[capability]
    const delay = unloadMs(option)
    if (delay === null) return
    if (last !== undefined && Date.now() - last < delay - 250) {
      // Activity happened sooner than expected — reschedule
      this.scheduleEvict(capability)
      return
    }
    if (this.isCapabilityBusy(capability)) {
      // Defer while busy; will be rescheduled on next touch
      Logger.dev('Speech auto-evict deferred — capability busy', { capability })
      return
    }
    const runtimes = CAPABILITY_RUNTIME_MAP[capability]
    const targets = runtimes.filter((runtime) => this.queue.isIdle(runtime))
    if (targets.length === 0) return
    Logger.dev('Speech auto-evict', { capability, runtimes: targets, option })
    await Promise.all(
      targets.map(async (runtime) => {
        const backend = this.backends.get(runtime)
        if (!backend) return
        try {
          await backend.dispose()
        } catch (cause) {
          Logger.error('Speech auto-evict dispose failed', { capability, runtime, cause })
        }
      })
    )
  }

  async dispose(): Promise<void> {
    for (const timer of this.unloadTimers.values()) clearTimeout(timer)
    this.unloadTimers.clear()
    for (const controller of this.downloadControllers.values()) controller.abort()
    this.downloadControllers.clear()
    const activeNativeSession = this.nativeCapture.activeSessionId
    if (activeNativeSession) {
      await this.failNativeCapture(
        activeNativeSession,
        'Recording stopped because the application shut down.'
      ).catch(() => undefined)
    }
    await this.nativeCapture.dispose()
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
      if (catalogArtifact.qualification.status === 'retired')
        throw new Error('The selected model is retired.')
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
    if (installed?.source === 'import' && installed.importPath) {
      if (
        installed.runtime === 'sherpa-onnx' &&
        installed.importPath.toLowerCase().endsWith('.onnx')
      ) {
        return dirname(installed.importPath)
      }
      if (
        installed.runtime === 'coreml' &&
        (installed.importPath.toLowerCase().endsWith('.mlmodelc') ||
          installed.importPath.toLowerCase().endsWith('.mlpackage'))
      ) {
        return dirname(installed.importPath)
      }
      return installed.importPath
    }
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
        candidate.qualification.status !== 'retired'
    )
    if (!artifact) return null
    const installed = this.installed.artifacts.find(
      (item) => item.artifactId === artifact.id && item.available && item.runtime === runtime
    )
    return installed ? artifact : null
  }

  /**
   * Pick an installed instruct cleanup model. Honors an explicit artifact
   * preference, then falls back to the lightweight GGUF cleanup model. Only the
   * GGUF (llama.cpp) runtime provides cleanup now; the retired MLX/sherpa
   * pseudo-cleanup paths are never selected.
   */
  private selectInstalledCleanupArtifact(
    preferredArtifactId?: string
  ): { runtime: SpeechRuntime; artifact: SpeechModelArtifact } | null {
    if (preferredArtifactId) {
      const catalogArtifact = this.requireCatalog().artifacts.find(
        (candidate) =>
          candidate.id === preferredArtifactId &&
          candidate.capability === 'cleanup' &&
          candidate.runtime === 'gguf' &&
          candidate.qualification.status !== 'retired'
      )
      if (catalogArtifact) {
        const installed = this.installed.artifacts.find(
          (item) =>
            item.artifactId === catalogArtifact.id &&
            item.available &&
            item.runtime === catalogArtifact.runtime
        )
        if (installed) {
          return { runtime: catalogArtifact.runtime, artifact: catalogArtifact }
        }
      }
    }
    for (const runtime of CAPABILITY_RUNTIME_MAP['cleanup']) {
      const artifact = this.installedCleanupArtifact(runtime)
      if (artifact) {
        return { runtime, artifact }
      }
    }
    return null
  }

  /**
   * Apply cleanup to a transcript. Prefers the installed local instruct model,
   * which also applies the user's learned style lessons; without a model the
   * raw transcript is returned untouched and flagged so the UI can offer the
   * download. Never switches path silently on failure.
   */
  private async runCleanup(
    rawTranscript: string,
    mode: SpeechCleanupMode,
    scope: SpeechScope
  ): Promise<{
    text: string
    provenance: SpeechCleanupProvenance
  }> {
    if (mode.kind === 'disabled') {
      return {
        text: rawTranscript,
        provenance: { mode: 'none', appliedLessonIds: [], failed: false }
      }
    }
    if (mode.kind === 'remote') {
      try {
        if (!this.remoteCleanup) throw new Error('Remote cleanup is unavailable.')
        const lessons = this.learning.enabled(scope)
        const remote = await this.remoteCleanup({
          transcript: rawTranscript,
          scope,
          selection: mode.selection,
          ...(mode.modelId ? { modelId: mode.modelId } : {}),
          ...(lessons.length ? { lessons } : {})
        })
        return {
          text: remote.text,
          provenance: {
            mode: 'remote',
            modelId: remote.modelId,
            appliedLessonIds: lessons.map((lesson) => lesson.id),
            failed: false
          }
        }
      } catch (cause) {
        const fallback = this.cleanup.fallback(rawTranscript, cause)
        return { text: fallback.text, provenance: { ...fallback.provenance, mode: 'remote' } }
      }
    }
    const resolved = this.selectInstalledCleanupArtifact(mode.artifactId)
    if (!resolved) {
      return {
        text: rawTranscript,
        provenance: {
          mode: 'none',
          appliedLessonIds: [],
          failed: false,
          modelMissing: true
        }
      }
    }
    try {
      const profile = cleanupProfileFor(resolved.artifact)
      const cleaned = await this.queue
        .enqueue({
          capability: 'cleanup',
          runtime: resolved.runtime,
          run: async (signal) => {
            const artifact = {
              id: resolved.artifact.id,
              directory: this.artifactDirectory(resolved.artifact.id),
              cleanupProfile: profile
            }
            const backend = this.requireBackend(resolved.runtime)
            if (backend.warmup) await backend.warmup(artifact, signal)
            return backend.cleanup(
              rawTranscript,
              artifact,
              signal,
              profile === 'instruct' ? { lessons: this.learning.enabled(scope) } : undefined
            )
          }
        })
        .result
      this.touch('cleanup')
      // Normalizers legitimately return an empty string for filler-only input;
      // keep the raw transcript so dictation never loses words.
      const finalText = cleaned.trim().length > 0 ? cleaned : rawTranscript
      return {
        text: finalText,
        provenance: {
          mode: 'local',
          runtime: resolved.runtime,
          artifactId: resolved.artifact.id,
          appliedLessonIds:
            profile === 'instruct'
              ? this.learning.enabled(scope).map((lesson) => lesson.id)
              : [],
          failed: false
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
      const location =
        artifact.source === 'import' && artifact.importPath
          ? artifact.importPath
          : this.storage.modelDirectory(artifact.artifactId)
      artifact.available = await access(location)
        .then(() => true)
        .catch(() => false)
      if (!artifact.available) artifact.unavailableReason = 'The model path is no longer available.'
      else artifact.unavailableReason = undefined
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
