import type { Contract } from './contract-helpers'

export const invokeSpeechContract = {
  'speech:getCapabilities': {} as Contract<
    [],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechCapabilitySnapshot>
  >,
  'speech:getCatalog': {} as Contract<
    [],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechModelCatalog>
  >,
  'speech:beginCapture': {} as Contract<
    [scope: import('../speech/types').SpeechScope, mimeType: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechCaptureSessionInfo>
  >,
  'speech:beginNativeCapture': {} as Contract<
    [scope: import('../speech/types').SpeechScope],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechCaptureSessionInfo>
  >,
  'speech:recordPermissionFailure': {} as Contract<
    [scope: import('../speech/types').SpeechScope, message: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:appendCapture': {} as Contract<
    [sessionId: string, chunk: Uint8Array<ArrayBuffer>],
    import('../speech/types').SpeechResult<number>
  >,
  'speech:finishCapture': {} as Contract<
    [sessionId: string, durationMs: number],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:finishNativeCapture': {} as Contract<
    [sessionId: string, durationMs: number],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:failCapture': {} as Contract<
    [sessionId: string, message: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:failNativeCapture': {} as Contract<
    [sessionId: string, message: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:markAttemptFailure': {} as Contract<
    [attemptId: string, message: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechRecordingAttempt>
  >,
  'speech:transcribe': {} as Contract<
    [
      attemptId: string,
      runtime: import('../speech/types').SpeechRuntime,
      artifactId: string,
      language: string,
      cleanupMode: import('../speech/types').SpeechCleanupMode
    ],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechTranscriptionResult>
  >,
  'speech:preloadAsr': {} as Contract<
    [runtime: import('../speech/types').SpeechRuntime, artifactId: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:getHistory': {} as Contract<
    [cursor?: string, limit?: number],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechHistoryPage>
  >,
  'speech:enforceHistoryLimit': {} as Contract<
    [limit: number],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:transcribeAudioToLlm': {} as Contract<
    [
      attemptId: string,
      scope: import('../speech/types').SpeechScope,
      language: string,
      cleanupMode: import('../speech/types').SpeechCleanupMode
    ],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechTranscriptionResult>
  >,
  'speech:validateModelPath': {} as Contract<
    [path: string, capability: import('../speech/types').SpeechCapability],
    import('../speech/types').SpeechResult<import('../speech/types').ModelPathValidationResult>
  >,
  'speech:importModel': {} as Contract<
    [path: string, capability?: import('../speech/types').SpeechCapability],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechInstalledArtifact>
  >,
  'speech:unregisterModel': {} as Contract<
    [artifactId: string, confirmationToken: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:downloadArtifact': {} as Contract<
    [artifactId: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:cancelDownload': {} as Contract<
    [artifactId: string],
    import('../speech/types').SpeechResult<boolean>
  >,
  'speech:cancelJob': {} as Contract<
    [jobId: string],
    import('../speech/types').SpeechResult<boolean>
  >,
  'speech:getLessons': {} as Contract<
    [scope?: import('../speech/types').SpeechScope],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechLesson[]>
  >,
  'speech:observeCorrection': {} as Contract<
    [observation: import('../speech/types').SpeechLearningObservation],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechLesson[]>
  >,
  'speech:setLessonEnabled': {} as Contract<
    [lessonId: string, enabled: boolean],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechLesson>
  >,
  'speech:deleteLesson': {} as Contract<
    [lessonId: string, confirmationToken: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:getLlamaRuntimeStatus': {} as Contract<
    [],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechLlamaRuntimeStatus>
  >,
  'speech:downloadLlamaRuntime': {} as Contract<[], import('../speech/types').SpeechResult<void>>,
  'speech:requestConfirmation': {} as Contract<
    [action: import('../speech/types').SpeechDestructiveAction, targetId: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechConfirmation>
  >,
  'speech:deleteHistory': {} as Contract<
    [attemptId: string, confirmationToken: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:deleteAllHistory': {} as Contract<
    [confirmationToken: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:readAudio': {} as Contract<
    [attemptId: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechPlaybackAudio>
  >,
  'speech:retryTranscription': {} as Contract<
    [
      attemptId: string,
      runtime: import('../speech/types').SpeechRuntime,
      artifactId: string,
      language: string
    ],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechTranscriptionResult>
  >,
  'speech:deleteArtifact': {} as Contract<
    [artifactId: string, confirmationToken: string],
    import('../speech/types').SpeechResult<void>
  >,
  'speech:preparePlayback': {} as Contract<
    [messageId: string, markdown: string, includeCodeBlocks: boolean],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechPreparedPlayback>
  >,
  'speech:synthesizePlaybackSegment': {} as Contract<
    [
      sessionId: string,
      segmentIndex: number,
      runtime: import('../speech/types').SpeechRuntime,
      artifactId: string,
      voiceId: string
    ],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechSynthesizedSegment>
  >,
  'speech:cancelPlayback': {} as Contract<
    [sessionId?: string],
    import('../speech/types').SpeechResult<boolean>
  >,
  /** Stage renderer-recorded audio bytes for the ephemeral Sound Playground. */
  'speech:playgroundStage': {} as Contract<
    [audio: Uint8Array<ArrayBuffer>, mimeType: string],
    import('../speech/types').SpeechResult<{ token: string; byteSize: number }>
  >,
  /** Import a user-picked audio file into the ephemeral Sound Playground. */
  'speech:playgroundImportPath': {} as Contract<
    [path: string],
    import('../speech/types').SpeechResult<{ token: string; byteSize: number; fileName: string }>
  >,
  'speech:playgroundReadAudio': {} as Contract<
    [token: string],
    import('../speech/types').SpeechResult<import('../speech/types').SpeechAudioBytes>
  >,
  'speech:playgroundTranscribe': {} as Contract<
    [
      token: string,
      runtime: import('../speech/types').SpeechRuntime,
      artifactId: string,
      language: string,
      cleanupMode: import('../speech/types').SpeechCleanupMode
    ],
    import('../speech/types').SpeechResult<{ rawTranscript: string; finalTranscript: string }>
  >,
  'speech:playgroundDiscard': {} as Contract<
    [token: string],
    import('../speech/types').SpeechResult<void>
  >,
  /** Read a user-picked text/PDF file for the Playground read-aloud section. */
  'speech:playgroundReadText': {} as Contract<
    [path: string],
    { text: string; fileName: string; truncated: boolean } | null
  >
}
