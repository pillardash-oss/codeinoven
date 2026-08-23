import type { WebContents } from 'electron'
import { MAX_SPEECH_CHUNK_BYTES } from '../../lib/speech/types'
import type { SpeechRuntime, SpeechScope } from '../../lib/speech/types'
import { SpeechService, speechResult } from '../speech/speech-service'
import { sendToRenderer } from './renderer-delivery'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

function entityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)) {
    throw new RangeError(`${label} is invalid.`)
  }
  return value
}

function runtime(value: unknown): SpeechRuntime {
  if (value !== 'mlx' && value !== 'sherpa-onnx') throw new RangeError('Speech runtime is invalid.')
  return value
}

function scope(value: unknown): SpeechScope {
  if (typeof value !== 'object' || value === null) throw new RangeError('Speech scope is invalid.')
  const candidate = value as Record<string, unknown>
  if (candidate['kind'] === 'global') return { kind: 'global' }
  if (candidate['kind'] === 'inbox') return { kind: 'inbox' }
  if (candidate['kind'] === 'project') {
    return { kind: 'project', projectId: entityId(candidate['projectId'], 'Project id') }
  }
  throw new RangeError('Speech scope is invalid.')
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new RangeError(`${label} is invalid.`)
  }
  return value
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} is invalid.`)
  }
  return value
}

/** Register the intentionally small, validated speech IPC allowlist. */
export function registerSpeechIpc(
  service: SpeechService,
  renderer: () => WebContents | null
): () => void {
  const stopProgress = service.onProgress((progress) => {
    sendToRenderer(renderer(), 'speech:progress', progress)
  })

  ipcMain.handle('speech:getCapabilities', () => speechResult(() => service.capabilities()))
  ipcMain.handle('speech:getCatalog', () => speechResult(async () => service.catalogSnapshot()))
  ipcMain.handle('speech:beginCapture', (_event, rawScope: unknown, rawMimeType: unknown) =>
    speechResult(() =>
      service.beginCapture(scope(rawScope), boundedString(rawMimeType, 'MIME type', 128))
    )
  )
  ipcMain.handle('speech:appendCapture', (_event, rawSessionId: unknown, rawChunk: unknown) =>
    speechResult(() => {
      const sessionId = entityId(rawSessionId, 'Capture session id')
      if (!(rawChunk instanceof Uint8Array) || rawChunk.byteLength > MAX_SPEECH_CHUNK_BYTES) {
        throw new RangeError('Audio chunk is invalid or too large.')
      }
      return service.appendCapture(sessionId, rawChunk)
    })
  )
  ipcMain.handle('speech:finishCapture', (_event, rawSessionId: unknown, rawDurationMs: unknown) =>
    speechResult(() =>
      service.finishCapture(
        entityId(rawSessionId, 'Capture session id'),
        boundedInteger(rawDurationMs, 'Recording duration', 0, Number.MAX_SAFE_INTEGER)
      )
    )
  )
  ipcMain.handle('speech:failCapture', (_event, rawSessionId: unknown, rawMessage: unknown) =>
    speechResult(() =>
      service.failCapture(
        entityId(rawSessionId, 'Capture session id'),
        boundedString(rawMessage, 'Capture failure', 1_000)
      )
    )
  )
  ipcMain.handle(
    'speech:transcribe',
    (
      _event,
      rawAttemptId: unknown,
      rawRuntime: unknown,
      rawArtifactId: unknown,
      rawLanguage: unknown
    ) =>
      speechResult(() =>
        service.transcribe(
          entityId(rawAttemptId, 'Attempt id'),
          runtime(rawRuntime),
          entityId(rawArtifactId, 'Artifact id'),
          boundedString(rawLanguage, 'Language', 32)
        )
      )
  )
  ipcMain.handle('speech:getHistory', (_event, rawCursor?: unknown, rawLimit?: unknown) =>
    speechResult(() => {
      const cursor =
        rawCursor === undefined ? undefined : boundedString(rawCursor, 'History cursor', 32)
      const limit =
        rawLimit === undefined ? undefined : boundedInteger(rawLimit, 'History limit', 1, 100)
      return service.history(cursor, limit)
    })
  )
  ipcMain.handle('speech:downloadArtifact', (_event, rawArtifactId: unknown) =>
    speechResult(() => service.downloadArtifact(entityId(rawArtifactId, 'Artifact id')))
  )
  ipcMain.handle('speech:cancelDownload', (_event, rawArtifactId: unknown) =>
    speechResult(async () => service.cancelDownload(entityId(rawArtifactId, 'Artifact id')))
  )
  ipcMain.handle('speech:cancelJob', (_event, rawJobId: unknown) =>
    speechResult(async () => service.cancelJob(entityId(rawJobId, 'Speech job id')))
  )

  return () => {
    stopProgress()
    for (const channel of [
      'speech:getCapabilities',
      'speech:getCatalog',
      'speech:beginCapture',
      'speech:appendCapture',
      'speech:finishCapture',
      'speech:failCapture',
      'speech:transcribe',
      'speech:getHistory',
      'speech:downloadArtifact',
      'speech:cancelDownload',
      'speech:cancelJob'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}
