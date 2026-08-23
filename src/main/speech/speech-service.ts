import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  SpeechCapabilitySnapshot,
  SpeechCaptureSessionInfo,
  SpeechDownloadState,
  SpeechError,
  SpeechHistoryPage,
  SpeechInstalledArtifact,
  SpeechModelArtifact,
  SpeechModelCatalog,
  SpeechProgressEvent,
  SpeechRecordingAttempt,
  SpeechResult,
  SpeechRuntime,
  SpeechRuntimeAvailability,
  SpeechScope,
  SpeechTranscriptionResult
} from '../../lib/speech/types'
import {
  DEFAULT_SPEECH_SETTINGS,
  MAX_SPEECH_CHUNK_BYTES,
  recommendedSpeechRuntime,
  resolveSpeechRuntime
} from '../../lib/speech/types'
import { parseSpeechModelCatalog } from '../../lib/speech/model-catalog'
import { SpeechJobQueue, SpeechQueueError } from './speech-job-queue'
import { SpeechStorage } from './speech-storage'
import type { SpeechBackend } from './speech-backend'
import { SherpaSpeechBackend } from './backends/sherpa-backend'
import { MlxSpeechBackend } from './backends/mlx-backend'
import { Logger } from '../system/logger'

interface InstalledArtifactIndex {
  version: 1
  artifacts: SpeechInstalledArtifact[]
}

interface SpeechServicePaths {
  catalogPath: string
  mlxWorkerPath: string
}

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

  constructor(
    private readonly paths: SpeechServicePaths,
    storage?: SpeechStorage
  ) {
    this.storage = storage ?? new SpeechStorage()
    this.backends = new Map<SpeechRuntime, SpeechBackend>([
      ['sherpa-onnx', new SherpaSpeechBackend()],
      ['mlx', new MlxSpeechBackend(paths.mlxWorkerPath)]
    ])
  }

  async initialize(): Promise<void> {
    await this.storage.initialize()
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
    const selected = resolveSpeechRuntime(target, runtimes, DEFAULT_SPEECH_SETTINGS.runtimeOverride)
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
    language: string | 'auto'
  ): Promise<SpeechTranscriptionResult> {
    const artifact = this.requireSelectableArtifact(artifactId, runtime, 'asr')
    const backend = this.requireBackend(runtime)
    const queued = this.queue.enqueue({
      capability: 'asr',
      runtime,
      run: (signal) =>
        backend.transcribe(
          {
            artifact: { id: artifact.id, directory: this.storage.modelDirectory(artifact.id) },
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
      await this.storage.updateAttempt(attemptId, (attempt) => {
        attempt.stage = 'completed'
        attempt.rawTranscript = rawTranscript
        attempt.finalTranscript = rawTranscript
      })
      this.emit({ kind: 'history', attemptId, stage: 'completed' })
      return { attemptId, jobId: queued.id, rawTranscript, finalTranscript: rawTranscript }
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
      for (const file of artifact.files) {
        const target = join(staging, file.path)
        await mkdir(dirname(target), { recursive: true })
        received += await this.downloadFile(
          file.sourceUrl,
          target,
          file.byteSize,
          file.sha256,
          controller.signal
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
    signal: AbortSignal
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
    const artifact = this.requireCatalog().artifacts.find((item) => item.id === artifactId)
    if (!artifact || artifact.runtime !== runtime || artifact.capability !== capability) {
      throw new Error('The selected model is incompatible with this operation.')
    }
    if (artifact.qualification.status !== 'qualified')
      throw new Error('The selected model is not qualified.')
    const installed = this.installed.artifacts.find(
      (item) => item.artifactId === artifactId && item.available
    )
    if (!installed) throw new Error('The selected model is not installed.')
    return artifact
  }

  private requireBackend(runtime: SpeechRuntime): SpeechBackend {
    const backend = this.backends.get(runtime)
    if (!backend) throw new Error(`Unsupported speech runtime: ${runtime}`)
    return backend
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
