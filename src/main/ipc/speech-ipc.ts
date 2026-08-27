import type { WebContents } from 'electron'
import { MAX_SPEECH_CHUNK_BYTES } from '../../lib/speech/types'
import type {
  SpeechCapability,
  SpeechLearningObservation,
  SpeechCleanupMode,
  SpeechDestructiveAction,
  SpeechRefinementFlags,
  SpeechRuntime,
  SpeechScope
} from '../../lib/speech/types'
import { SpeechService, speechResult } from '../speech/speech-service'
import { sendToRenderer } from './renderer-delivery'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'

function entityId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/u.test(value)) {
    throw new RangeError(`${label} is invalid.`)
  }
  return value
}

function destructiveAction(value: unknown): SpeechDestructiveAction {
  if (
    value !== 'history-item' &&
    value !== 'all-history' &&
    value !== 'recording' &&
    value !== 'lesson' &&
    value !== 'model'
  ) {
    throw new RangeError('Destructive speech action is invalid.')
  }
  return value
}

function speechCapability(value: unknown): SpeechCapability {
  if (value !== 'asr' && value !== 'cleanup' && value !== 'tts')
    throw new RangeError('Speech capability is invalid.')
  return value
}

function runtime(value: unknown): SpeechRuntime {
  if (value !== 'mlx' && value !== 'sherpa-onnx' && value !== 'gguf' && value !== 'coreml')
    throw new RangeError('Speech runtime is invalid.')
  return value
}

function refinementFlags(value: unknown): SpeechRefinementFlags {
  if (typeof value !== 'object' || value === null) throw new RangeError('Cleanup flags are invalid.')
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate['smartCleanup'] !== 'boolean' ||
    typeof candidate['selfCorrection'] !== 'boolean' ||
    typeof candidate['preserveTechnical'] !== 'boolean'
  ) {
    throw new RangeError('Cleanup flags are invalid.')
  }
  return {
    smartCleanup: candidate['smartCleanup'],
    selfCorrection: candidate['selfCorrection'],
    preserveTechnical: candidate['preserveTechnical']
  }
}

function cleanupMode(value: unknown): SpeechCleanupMode {
  if (typeof value !== 'object' || value === null) throw new RangeError('Cleanup mode is invalid.')
  const candidate = value as Record<string, unknown>
  if (candidate['kind'] === 'disabled') return { kind: 'disabled' }
  if (candidate['kind'] === 'local') {
    const artifactId = candidate['artifactId']
    const flags =
      candidate['flags'] === undefined ? undefined : refinementFlags(candidate['flags'])
    return {
      kind: 'local',
      ...(artifactId === undefined ? {} : { artifactId: entityId(artifactId, 'Cleanup artifact id') }),
      ...(flags ? { flags } : {})
    }
  }
  if (candidate['kind'] === 'remote') {
    const selection = candidate['selection']
    if (selection !== 'fixed' && selection !== 'conversation') {
      throw new RangeError('Remote cleanup selection is invalid.')
    }
    const modelId = candidate['modelId']
    if (selection === 'fixed' && modelId === undefined) {
      throw new RangeError('A fixed remote cleanup model is required.')
    }
    const flags =
      candidate['flags'] === undefined ? undefined : refinementFlags(candidate['flags'])
    return {
      kind: 'remote',
      selection,
      ...(modelId === undefined ? {} : { modelId: boundedString(modelId, 'Remote cleanup model', 256) }),
      ...(flags ? { flags } : {})
    }
  }
  throw new RangeError('Cleanup mode is invalid.')
}

function scope(value: unknown): SpeechScope {
  if (typeof value !== 'object' || value === null) throw new RangeError('Speech scope is invalid.')
  const candidate = value as Record<string, unknown>
  if (candidate['kind'] === 'global') return { kind: 'global' }
  if (candidate['kind'] === 'inbox') {
    const threadId = candidate['threadId']
    return threadId === undefined
      ? { kind: 'inbox' }
      : { kind: 'inbox', threadId: entityId(threadId, 'Thread id') }
  }
  if (candidate['kind'] === 'project') {
    const threadId = candidate['threadId']
    return {
      kind: 'project',
      projectId: entityId(candidate['projectId'], 'Project id'),
      ...(threadId === undefined ? {} : { threadId: entityId(threadId, 'Thread id') })
    }
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

function learningObservation(value: unknown): SpeechLearningObservation {
  if (typeof value !== 'object' || value === null) throw new RangeError('Observation is invalid.')
  const candidate = value as Record<string, unknown>
  return {
    insertedText: boundedString(candidate['insertedText'], 'Inserted text', 100_000),
    sentText: boundedString(candidate['sentText'], 'Sent text', 100_000),
    scope: scope(candidate['scope']),
    sentAt: boundedInteger(candidate['sentAt'], 'Sent time', 0, Number.MAX_SAFE_INTEGER)
  }
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
  ipcMain.handle('speech:beginNativeCapture', (_event, rawScope: unknown) =>
    speechResult(() => service.beginNativeCapture(scope(rawScope)))
  )
  ipcMain.handle(
    'speech:recordPermissionFailure',
    (_event, rawScope: unknown, rawMessage: unknown) =>
      speechResult(() =>
        service.recordPermissionFailure(
          scope(rawScope),
          boundedString(rawMessage, 'Permission failure', 1_000)
        )
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
  ipcMain.handle(
    'speech:finishNativeCapture',
    (_event, rawSessionId: unknown, rawDurationMs: unknown) =>
      speechResult(() =>
        service.finishNativeCapture(
          entityId(rawSessionId, 'Native capture session id'),
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
  ipcMain.handle('speech:failNativeCapture', (_event, rawSessionId: unknown, rawMessage: unknown) =>
    speechResult(() =>
      service.failNativeCapture(
        entityId(rawSessionId, 'Native capture session id'),
        boundedString(rawMessage, 'Capture failure', 1_000)
      )
    )
  )
  ipcMain.handle(
    'speech:markAttemptFailure',
    (_event, rawAttemptId: unknown, rawMessage: unknown) =>
      speechResult(() =>
        service.markAttemptFailure(
          entityId(rawAttemptId, 'Attempt id'),
          boundedString(rawMessage, 'Attempt failure', 1_000)
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
      rawLanguage: unknown,
      rawCleanupMode: unknown
    ) =>
      speechResult(() =>
        service.transcribe(
          entityId(rawAttemptId, 'Attempt id'),
          runtime(rawRuntime),
          entityId(rawArtifactId, 'Artifact id'),
          boundedString(rawLanguage, 'Language', 32),
          cleanupMode(rawCleanupMode)
        )
      )
  )
  ipcMain.handle('speech:preloadAsr', (_event, rawRuntime: unknown, rawArtifactId: unknown) =>
    speechResult(() => service.preloadAsr(runtime(rawRuntime), entityId(rawArtifactId, 'Artifact id')))
  )
  ipcMain.handle(
    'speech:transcribeAudioToLlm',
    (
      _event,
      rawAttemptId: unknown,
      rawScope: unknown,
      rawLanguage: unknown,
      rawCleanupMode: unknown
    ) =>
      speechResult(() =>
        service.transcribeAudioToLlm(
          entityId(rawAttemptId, 'Attempt id'),
          scope(rawScope),
          boundedString(rawLanguage, 'Language', 32),
          cleanupMode(rawCleanupMode)
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
  ipcMain.handle('speech:validateModelPath', (_event, rawPath: unknown, rawCapability: unknown) =>
    speechResult(() =>
      service.validateModelPath(
        boundedString(rawPath, 'Model path', 4_096),
        rawCapability === undefined ? 'asr' : speechCapability(rawCapability)
      )
    )
  )
  ipcMain.handle('speech:importModel', (_event, rawPath: unknown, rawCapability?: unknown) =>
    speechResult(() =>
      service.registerImportedModel(
        boundedString(rawPath, 'Model path', 4_096),
        rawCapability === undefined ? undefined : speechCapability(rawCapability)
      )
    )
  )
  ipcMain.handle(
    'speech:unregisterModel',
    (_event, rawArtifactId: unknown, rawConfirmationToken: unknown) =>
      speechResult(() =>
        service.unregisterImportedModel(
          entityId(rawArtifactId, 'Artifact id'),
          entityId(rawConfirmationToken, 'Confirmation token')
        )
      )
  )
  ipcMain.handle('speech:enforceHistoryLimit', (_event, rawLimit: unknown) =>
    speechResult(() =>
      service.enforceHistoryLimit(boundedInteger(rawLimit, 'History limit', 1, 500))
    )
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
  ipcMain.handle('speech:getLessons', (_event, rawScope?: unknown) =>
    speechResult(async () => service.lessons(rawScope === undefined ? undefined : scope(rawScope)))
  )
  ipcMain.handle('speech:observeCorrection', (_event, rawObservation: unknown) =>
    speechResult(() => service.observeCorrection(learningObservation(rawObservation)))
  )
  ipcMain.handle(
    'speech:setLessonEnabled',
    (_event, rawLessonId: unknown, rawEnabled: unknown) =>
      speechResult(() => {
        if (typeof rawEnabled !== 'boolean') throw new RangeError('Enabled state is invalid.')
        return service.setLessonEnabled(entityId(rawLessonId, 'Lesson id'), rawEnabled)
      })
  )
  ipcMain.handle(
    'speech:deleteLesson',
    (_event, rawLessonId: unknown, rawConfirmationToken: unknown) =>
      speechResult(() =>
        service.deleteLesson(
          entityId(rawLessonId, 'Lesson id'),
          entityId(rawConfirmationToken, 'Confirmation token')
        )
      )
  )
  ipcMain.handle('speech:getLlamaRuntimeStatus', () =>
    speechResult(() => service.llamaRuntimeStatus())
  )
  ipcMain.handle('speech:downloadLlamaRuntime', () =>
    speechResult(() => service.downloadLlamaRuntime())
  )
  ipcMain.handle('speech:requestConfirmation', (_event, rawAction: unknown, rawTargetId: unknown) =>
    speechResult(async () =>
      service.requestConfirmation(
        destructiveAction(rawAction),
        entityId(rawTargetId, 'Confirmation target')
      )
    )
  )
  ipcMain.handle(
    'speech:deleteHistory',
    (_event, rawAttemptId: unknown, rawConfirmationToken: unknown) =>
      speechResult(() =>
        service.deleteHistory(
          entityId(rawAttemptId, 'Attempt id'),
          entityId(rawConfirmationToken, 'Confirmation token')
        )
      )
  )
  ipcMain.handle('speech:deleteAllHistory', (_event, rawConfirmationToken: unknown) =>
    speechResult(() =>
      service.deleteAllHistory(entityId(rawConfirmationToken, 'Confirmation token'))
    )
  )
  ipcMain.handle('speech:readAudio', (_event, rawAttemptId: unknown) =>
    speechResult(() => service.readAudio(entityId(rawAttemptId, 'Attempt id')))
  )
  ipcMain.handle(
    'speech:retryTranscription',
    (
      _event,
      rawAttemptId: unknown,
      rawRuntime: unknown,
      rawArtifactId: unknown,
      rawLanguage: unknown
    ) =>
      speechResult(() =>
        service.retryTranscription(
          entityId(rawAttemptId, 'Attempt id'),
          runtime(rawRuntime),
          entityId(rawArtifactId, 'Artifact id'),
          boundedString(rawLanguage, 'Language', 32)
        )
      )
  )
  ipcMain.handle(
    'speech:deleteArtifact',
    (_event, rawArtifactId: unknown, rawConfirmationToken: unknown) =>
      speechResult(() =>
        service.deleteArtifact(
          entityId(rawArtifactId, 'Artifact id'),
          entityId(rawConfirmationToken, 'Confirmation token')
        )
      )
  )
  ipcMain.handle(
    'speech:preparePlayback',
    (_event, rawMessageId: unknown, rawMarkdown: unknown, rawIncludeCodeBlocks: unknown) =>
      speechResult(async () => {
        if (typeof rawIncludeCodeBlocks !== 'boolean') {
          throw new RangeError('Code-block preference is invalid.')
        }
        return service.preparePlayback(
          entityId(rawMessageId, 'Message id'),
          boundedString(rawMarkdown, 'Response text', 1_000_000),
          rawIncludeCodeBlocks
        )
      })
  )
  ipcMain.handle(
    'speech:synthesizePlaybackSegment',
    (
      _event,
      rawSessionId: unknown,
      rawSegmentIndex: unknown,
      rawRuntime: unknown,
      rawArtifactId: unknown,
      rawVoiceId: unknown
    ) =>
      speechResult(() =>
        service.synthesizePlaybackSegment(
          entityId(rawSessionId, 'Playback session id'),
          boundedInteger(rawSegmentIndex, 'Segment index', 0, 10_000),
          runtime(rawRuntime),
          entityId(rawArtifactId, 'Artifact id'),
          boundedString(rawVoiceId, 'Voice id', 128)
        )
      )
  )
  ipcMain.handle('speech:cancelPlayback', (_event, rawSessionId?: unknown) =>
    speechResult(async () =>
      service.cancelPlayback(
        rawSessionId === undefined ? undefined : entityId(rawSessionId, 'Playback session id')
      )
    )
  )

  return () => {
    stopProgress()
    for (const channel of [
      'speech:getCapabilities',
      'speech:getCatalog',
      'speech:beginCapture',
      'speech:beginNativeCapture',
      'speech:recordPermissionFailure',
      'speech:appendCapture',
      'speech:finishCapture',
      'speech:finishNativeCapture',
      'speech:failCapture',
      'speech:failNativeCapture',
      'speech:markAttemptFailure',
      'speech:transcribe',
      'speech:preloadAsr',
      'speech:transcribeAudioToLlm',
      'speech:validateModelPath',
      'speech:getHistory',
      'speech:importModel',
      'speech:unregisterModel',
      'speech:enforceHistoryLimit',
      'speech:downloadArtifact',
      'speech:cancelDownload',
      'speech:cancelJob',
      'speech:getLessons',
      'speech:observeCorrection',
      'speech:setLessonEnabled',
      'speech:deleteLesson',
      'speech:getLlamaRuntimeStatus',
      'speech:downloadLlamaRuntime',
      'speech:requestConfirmation',
      'speech:deleteHistory',
      'speech:deleteAllHistory',
      'speech:readAudio',
      'speech:retryTranscription',
      'speech:deleteArtifact',
      'speech:preparePlayback',
      'speech:synthesizePlaybackSegment',
      'speech:cancelPlayback'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }
}
