import { createHash, randomUUID } from 'node:crypto'
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
  ModelPathValidationResult,
  SpeechProgressEvent,
  SpeechRecordingAttempt,
  SpeechAudioBytes,
  SpeechPlaybackAudio,
  SpeechPreparedPlayback,
  SpeechRefinementFlags,
  SpeechSynthesizedSegment,
  SpeechConfirmation,
  SpeechDestructiveAction,
  SpeechRuntime,
  SpeechRuntimeAvailability,
  SpeechScope,
  SpeechLearningObservation,
  SpeechTranscriptionResult
} from '../../lib/speech/types'
import {
  MAX_SPEECH_CHUNK_BYTES,
  recommendedSpeechRuntime,
  resolveSpeechRuntime
} from '../../lib/speech/types'
import type { SpeechUnloadOption } from '../../lib/speech/types'
import { parseSpeechModelCatalog } from '../../lib/speech/model-catalog'
import { collapseRepetitiveArtifacts } from '../../lib/speech/transcript-sanitizer'
import { DEFAULT_REFINEMENT_FLAGS } from '../../lib/speech/types'
import { posixBasename } from '../../lib/paths'
import { SpeechJobQueue } from './speech-job-queue'
import { SpeechStorage } from './speech-storage'
import type { SpeechBackend } from './speech-backend'
import { SherpaSpeechBackend } from './backends/sherpa-backend'
import { MlxSpeechBackend } from './backends/mlx-backend'
import { CoreMlSpeechBackend } from './backends/coreml-backend'
import { LlamaServerSpeechBackend, setLlamaServerBinary } from './backends/llama-backend'
import { LlamaRuntimeService } from './llama-runtime-service'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import { SpeechCleanupService } from './speech-cleanup-service'
import { SpeechLearningService } from './speech-learning-service'
import { normalizeSpeechMarkdown } from '../../lib/speech/tts-normalizer'
import { TtsPlaybackService } from './tts-playback-service'
import { NativeSpeechCapture } from './native-speech-capture'
import { validateSpeechModelPath } from './speech-service/model-path-validation'
import { SpeechPlaygroundStore } from './speech-service/speech-playground-store'
import {
  CAPABILITY_RUNTIME_MAP,
  SpeechRuntimeEviction
} from './speech-service/speech-runtime-eviction'
import { SpeechArtifactDownloader } from './speech-service/speech-artifact-downloader'
import { toSpeechError } from './speech-service/speech-error-mapping'

export { speechResult } from './speech-service/speech-error-mapping'

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
  /** Cleanup behavior toggles mirrored into the remote system prompt. */
  flags?: SpeechRefinementFlags
}

export interface SpeechRemoteCleanupOutput {
  text: string
  modelId: string
}

export type SpeechRemoteCleanupExecutor = (
  input: SpeechRemoteCleanupInput
) => Promise<SpeechRemoteCleanupOutput>

export interface SpeechRemoteLearningInput {
  insertedText: string
  sentText: string
  scope: SpeechScope
}

/**
 * Lesson extraction through the active conversation provider's cheapest model
 * (the title-generation route). Returns null when the route is unavailable so
 * the caller can fall back to the local instruct cleanup model.
 */
export type SpeechRemoteLearningExecutor = (
  input: SpeechRemoteLearningInput
) => Promise<import('../../lib/speech/types').SpeechExtractedLesson[] | null>

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

/** Main-process coordinator. Native inference is delegated to bounded workers. */
export class SpeechService {
  private readonly storage: SpeechStorage
  private readonly queue = new SpeechJobQueue()
  private readonly backends: Map<SpeechRuntime, SpeechBackend>
  private readonly listeners = new Set<SpeechProgressListener>()
  private readonly downloader: SpeechArtifactDownloader
  private catalog: SpeechModelCatalog | null = null
  private installed: InstalledArtifactIndex = { version: 1, artifacts: [] }
  private readonly cleanup = new SpeechCleanupService()
  private readonly learning: SpeechLearningService
  private readonly llamaRuntime = new LlamaRuntimeService()
  private readonly playback = new TtsPlaybackService()
  private readonly nativeCapture: NativeSpeechCapture
  private readonly confirmations = new Map<string, SpeechConfirmation>()
  private readonly eviction: SpeechRuntimeEviction
  private readonly playground = new SpeechPlaygroundStore()

  constructor(
    private readonly paths: SpeechServicePaths,
    storage?: SpeechStorage,
    private readonly remoteCleanup?: SpeechRemoteCleanupExecutor,
    private readonly transcribeAudio?: SpeechAudioTranscribeExecutor,
    private readonly remoteLearning?: SpeechRemoteLearningExecutor,
    private readonly trackProcess?: (pid: number, command: string, cwd: string) => void
  ) {
    this.nativeCapture = new NativeSpeechCapture(paths.nativeCaptureWorkerPath)
    this.storage = storage ?? new SpeechStorage()
    this.learning = new SpeechLearningService(
      join(getConfigRoot(), 'speech', 'lessons.json'),
      (observation) => this.learnLessonsFromCorrection(observation)
    )
    this.backends = new Map<SpeechRuntime, SpeechBackend>([
      ['sherpa-onnx', new SherpaSpeechBackend()],
      ['mlx', new MlxSpeechBackend(paths.mlxWorkerPath)],
      ['coreml', new CoreMlSpeechBackend(paths.coremlWorkerPath)],
      [
        'gguf',
        new LlamaServerSpeechBackend(
          (pid, command, cwd) => this.llamaRuntime.registerServerProcess(pid, command, cwd),
          (pid) => this.llamaRuntime.unregisterServerProcess(pid),
          (pid, command, cwd) => this.trackProcess?.(pid, command, cwd)
        )
      ]
    ])
    this.eviction = new SpeechRuntimeEviction({
      isCapabilityBusy: (capability) => this.isCapabilityBusy(capability),
      isRuntimeIdle: (runtime) => this.queue.isIdle(runtime),
      disposeRuntime: (runtime) => this.disposeRuntime(runtime)
    })
    this.downloader = new SpeechArtifactDownloader(this.storage, {
      catalog: () => this.requireCatalog(),
      emitDownload: (artifact, download) => this.emitDownload(artifact, download),
      recordInstalled: (artifact, installedAt) => this.recordInstalled(artifact, installedAt)
    })
  }

  async initialize(): Promise<void> {
    // Reap any app-owned llama-server orphaned by an unclean previous run before
    // anything can spawn one again. Only servers this app spawned are journaled,
    // so a user's own llama-server is never touched.
    await this.llamaRuntime.recoverOrphans().catch((error) => {
      Logger.error('Llama-server orphan recovery failed (non-fatal):', error)
    })
    await this.storage.initialize()
    await this.learning.initialize()
    await this.refreshLlamaRuntime()
    this.catalog = parseSpeechModelCatalog(
      JSON.parse(await readFile(this.paths.catalogPath, 'utf8'))
    )
    await this.loadInstalledIndex()
    // Warm the native capture worker in the background so the first voice
    // recording starts instantly instead of paying process + audio-unit init.
    void this.nativeCapture.warm().catch((error) => {
      Logger.dev('Native speech capture warmup failed (non-fatal):', error)
    })
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
      installedArtifacts: await Promise.all(
        this.installed.artifacts.map(async (artifact) => {
          const runtime = runtimeAvailability.get(artifact.runtime)
          if (
            artifact.source === 'import' &&
            artifact.importPath &&
            !(await access(artifact.importPath).then(
              () => true,
              () => false
            ))
          ) {
            return structuredClone({
              ...artifact,
              available: false,
              unavailableReason: 'The imported model path no longer exists on disk.'
            })
          }
          if (artifact.available && runtime && !runtime.available) {
            return structuredClone({
              ...artifact,
              available: false,
              unavailableReason: runtime.reason ?? 'Runtime unavailable.'
            })
          }
          return structuredClone(artifact)
        })
      )
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
      // Cleanup provenance may have touched cleanup model   also refresh cleanup timer if local cleanup used
      if (
        cleanupMode.kind === 'local' &&
        cleanupProvenance.mode === 'local' &&
        !cleanupProvenance.failed
      ) {
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
        // Warm the cleanup stack too so transcription + cleanup never pay a
        // lazy llama-server spawn after the recording ends.
        await this.preloadCleanup()
      } catch {
        // Warmup is best-effort; transcription will surface real errors.
      } finally {
        clearTimeout(timer)
      }
    } else {
      this.touch('asr')
    }
  }

  /**
   * Stage renderer-recorded audio bytes for the ephemeral Sound Playground.
   * The copy lives only in a temp directory tracked in memory; it is never
   * written to speech history storage.
   */
  async stagePlaygroundAudio(
    audio: Uint8Array,
    mimeType: string
  ): Promise<{ token: string; byteSize: number }> {
    return this.playground.stage(audio, mimeType)
  }

  /**
   * Import a user-picked audio file into the ephemeral Sound Playground. The
   * file is copied to the playground temp directory so nothing references the
   * original after the session ends.
   */
  async importPlaygroundAudioFromPath(
    rawPath: string
  ): Promise<{ token: string; byteSize: number; fileName: string }> {
    return this.playground.importFromPath(rawPath)
  }

  /** Read staged playground audio so the renderer can build a playback URL. */
  async readPlaygroundAudio(token: string): Promise<SpeechAudioBytes> {
    return this.playground.read(token)
  }

  /**
   * Transcribe staged playground audio without touching speech history. When
   * `cleanupMode` is not disabled, the raw transcript flows through the same
   * cleanup service used by dictation.
   */
  async playgroundTranscribe(
    token: string,
    runtime: SpeechRuntime,
    artifactId: string,
    language: string | 'auto',
    cleanupMode: SpeechCleanupMode = { kind: 'disabled' }
  ): Promise<{ rawTranscript: string; finalTranscript: string }> {
    const staged = this.playground.resolve(token)
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
            audioPath: staged.path,
            language
          },
          signal
        )
    })
    try {
      const rawTranscript = (await queued.result).trim()
      if (rawTranscript.length === 0) {
        throw new Error('The speech runtime returned an empty transcript.')
      }
      let finalTranscript = rawTranscript
      if (cleanupMode.kind !== 'disabled') {
        finalTranscript = (await this.runCleanup(rawTranscript, cleanupMode, { kind: 'global' }))
          .text
      }
      this.touch('asr')
      if (cleanupMode.kind === 'local') this.touch('cleanup')
      return { rawTranscript, finalTranscript }
    } catch (cause) {
      Logger.error('Playground transcription failed', {
        runtime,
        artifactId,
        jobId: queued.id,
        error: this.asError(cause, 'transcription-failed').message
      })
      throw cause
    }
  }

  /** Delete a staged playground audio copy. Ephemeral by contract. */
  async discardPlaygroundAudio(token: string): Promise<void> {
    return this.playground.discard(token)
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

  /**
   * Read a stored recording as playable audio: containers Chromium can demux
   * are returned as stored, everything else is converted once and cached.
   */
  readPlaybackAudio(attemptId: string): Promise<SpeechPlaybackAudio> {
    return this.storage.readPlaybackAudio(attemptId)
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
    return validateSpeechModelPath(rawPath, capability, this.platformTarget())
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
   * Ask what the user's edit teaches us. The remote cheap-model learning agent
   * (the title-generation route) runs first; the local instruct cleanup model is
   * the offline fallback. Called through the job queue so learning never
   * overlaps local cleanup inference.
   */
  private async learnLessonsFromCorrection(
    observation: SpeechLearningObservation
  ): Promise<import('../../lib/speech/types').SpeechExtractedLesson[]> {
    if (this.remoteLearning) {
      try {
        const remote = await this.remoteLearning({
          insertedText: observation.insertedText,
          sentText: observation.sentText,
          scope: observation.scope
        })
        if (remote !== null) return remote
      } catch {
        // Route unavailable   fall through to the local instruct model.
      }
    }
    return this.learnLessonsLocally(
      observation.insertedText,
      observation.sentText,
      observation.scope.kind === 'project' ? 'project' : 'chat'
    )
  }

  /** Local fallback: the installed Qwen3 instruct cleanup model extracts lessons. */
  private async learnLessonsLocally(
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
          backend
            .learnFromCorrection(insertedText, sentText, mode, signal)
            .then((value) => value ?? [])
      })
      .result.catch(() => [])
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
    return this.downloader.download(artifactId)
  }

  cancelDownload(artifactId: string): boolean {
    return this.downloader.cancel(artifactId)
  }

  cancelJob(jobId: string): boolean {
    return this.queue.cancel(jobId)
  }

  updateUnloadOptions(options: Partial<Record<SpeechCapability, SpeechUnloadOption>>): void {
    this.eviction.updateUnloadOptions(options)
  }

  /**
   * Best-effort preload of the GGUF cleanup stack: resolve the installed
   * cleanup artifact and ensure its llama-server process is resident with the
   * model fully loaded before transcription needs it. Failures are logged and
   * swallowed so a missing cleanup model never blocks ASR warmup.
   */
  private async preloadCleanup(): Promise<void> {
    const resolved = this.selectInstalledCleanupArtifact()
    if (!resolved) return
    const backend = this.requireBackend(resolved.runtime)
    if (!backend.warmup) return
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    try {
      await backend.warmup(
        {
          id: resolved.artifact.id,
          directory: this.artifactDirectory(resolved.artifact.id),
          ...(resolved.artifact.familyId === 's1-cleanup'
            ? { cleanupProfile: 'normalizer' as const }
            : {})
        },
        ac.signal
      )
      this.touch('cleanup')
    } catch (cause) {
      Logger.error('Speech cleanup stack preload failed', {
        artifactId: resolved.artifact.id,
        cause: cause instanceof Error ? cause.message : String(cause)
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private touch(capability: SpeechCapability): void {
    this.eviction.touch(capability)
  }

  private clearEvict(capability: SpeechCapability): void {
    this.eviction.clearEvict(capability)
  }

  private isCapabilityBusy(capability: SpeechCapability): boolean {
    for (const runtime of CAPABILITY_RUNTIME_MAP[capability]) {
      if (this.queue.hasActive(runtime) || this.queue.hasPending(runtime)) return true
    }
    return false
  }

  /** Dispose one idle runtime's backend, keeping eviction decoupled from the registry. */
  private async disposeRuntime(runtime: SpeechRuntime): Promise<void> {
    const backend = this.backends.get(runtime)
    if (!backend) return
    await backend.dispose()
  }

  async dispose(): Promise<void> {
    this.eviction.dispose()
    this.downloader.abortAll()
    const activeNativeSession = this.nativeCapture.activeSessionId
    if (activeNativeSession) {
      await this.failNativeCapture(
        activeNativeSession,
        'Recording stopped because the application shut down.'
      ).catch(() => undefined)
    }
    await this.playground.dispose()
    await this.nativeCapture.dispose()
    await this.queue.dispose()
    await Promise.all([...this.backends.values()].map((backend) => backend.dispose()))
    // Clean shutdown: the servers were SIGTERMed above, so clear the journal so
    // the next launch has nothing to reap.
    await this.llamaRuntime.clearOrphanJournal()
    await this.storage.dispose()
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
        label: imported.importPath ? posixBasename(imported.importPath) : imported.artifactId,
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
        const flags = mode.flags ?? DEFAULT_REFINEMENT_FLAGS
        const remote = await this.remoteCleanup({
          // Collapse ASR loop artifacts before any model sees the transcript.
          transcript: collapseRepetitiveArtifacts(rawTranscript),
          scope,
          selection: mode.selection,
          ...(mode.modelId ? { modelId: mode.modelId } : {}),
          ...(lessons.length ? { lessons } : {}),
          flags
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
      const flags: SpeechRefinementFlags = mode.flags ?? DEFAULT_REFINEMENT_FLAGS
      const cleaned = await this.queue.enqueue({
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
            // Collapse ASR loop artifacts before the model sees the transcript.
            collapseRepetitiveArtifacts(rawTranscript),
            artifact,
            signal,
            profile === 'instruct' ? { lessons: this.learning.enabled(scope), flags } : undefined
          )
        }
      }).result
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
            profile === 'instruct' ? this.learning.enabled(scope).map((lesson) => lesson.id) : [],
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

  /** Record a downloaded artifact in the installed index and persist it. */
  private async recordInstalled(artifact: SpeechModelArtifact, installedAt: number): Promise<void> {
    this.installed.artifacts = this.installed.artifacts.filter(
      (item) => item.artifactId !== artifact.id
    )
    this.installed.artifacts.push({
      artifactId: artifact.id,
      runtime: artifact.runtime,
      revision: artifact.repositoryRevision,
      installedAt,
      byteSize: artifact.byteSize,
      source: 'download',
      externalReference: false,
      available: true
    })
    await this.persistInstalledIndex()
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
    return toSpeechError(cause, fallback)
  }
}
