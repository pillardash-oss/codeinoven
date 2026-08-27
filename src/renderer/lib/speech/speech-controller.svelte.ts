import { invoke } from '$lib/ipc.svelte'
import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
import { toast } from 'svelte-sonner'
import { pauseCurrentHistoryAudio } from './global-audio'
import { logRendererError } from '../system/renderer-logger'
import { isRemotePwaRuntime } from '$lib/runtime-context'
import type {
  SpeechDictationSpan,
  SpeechModelArtifact,
  SpeechRuntime,
  SpeechScope,
  SpeechPlaybackState,
  SpeechPreparedPlayback,
  SpeechSegment,
  SpeechSynthesizedSegment
} from '../../../lib/speech/types'
import { DEFAULT_SPEECH_SETTINGS } from '../../../lib/speech/types'
import type {
  SpeechEditorApplyResult,
  SpeechEditorSnapshot,
  SpeechEditorTarget
} from './editor-target'

export type RendererSpeechState =
  | { state: 'idle' }
  | { state: 'requesting-permission'; targetId: string }
  | {
      state: 'recording'
      targetId: string
      attemptId: string
      startedAt: number
      elapsedMs: number
    }
  | { state: 'stopping'; targetId: string; attemptId: string }
  | { state: 'transcribing'; targetId: string; attemptId: string }
  | { state: 'failed'; targetId?: string; message: string }

interface ActiveCapture {
  target: SpeechEditorTarget
  snapshot: SpeechEditorSnapshot
  scope: SpeechScope
  recorder: MediaRecorder | null
  stream: MediaStream | null
  native: boolean
  sessionId: string
  attemptId: string
  startedAt: number
  uploadTail: Promise<void>
  queuedChunks: number
  uploadError: Error | null
}

interface ActivePlayback {
  prepared: SpeechPreparedPlayback
  runtime: SpeechRuntime
  artifact: SpeechModelArtifact
  voiceId: string
  audio: HTMLAudioElement | null
  audioUrl: string | null
  next: Promise<SpeechSynthesizedSegment> | null
  index: number
}

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const
// Chunk the stream for bounded IPC and disk writes. There is intentionally no
// elapsed-time cap on a recording; it ends only when the user stops it or the
// capture device/storage reports a real failure.
const CAPTURE_TIMESLICE_MS = 250
const PAUSE_UPLOAD_DEPTH = 4
const CAPTURE_STOP_TIMEOUT_MS = 5_000
// Text-to-speech normally starts playing within seconds. If the pipeline wedges
// before the first audio sample, settle the UI into a retryable failure instead
// of spinning forever.
const PLAYBACK_STALL_WATCHDOG_MS = 60_000

type RecordingFailurePhase = 'prepare' | 'permission' | 'capture' | 'transcription'

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return 'Unknown recording error.'
}

function selectedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

function recordingToastMessage(cause: unknown, phase: RecordingFailurePhase): string {
  const name =
    typeof DOMException !== 'undefined' && cause instanceof DOMException ? cause.name : ''
  if (phase === 'prepare') return 'Focus the editor before recording.'
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is unavailable.'
  }
  if (phase === 'transcription') return 'Voice recording could not be transcribed.'
  return 'Voice recording failed.'
}

class SpeechController {
  state = $state<RendererSpeechState>({ state: 'idle' })
  playback = $state<SpeechPlaybackState>({ state: 'idle' })
  get activeSegments(): SpeechSegment[] | null {
    return this.activePlayback?.prepared.segments ?? null
  }
  private active: ActiveCapture | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private preloadTimer: ReturnType<typeof setTimeout> | null = null
  private preloadFired = false
  private readonly spans = new Map<string, SpeechDictationSpan[]>()
  private activePlayback = $state<ActivePlayback | null>(null)
  private stopPromise: Promise<void> | null = null
  private sound = structuredClone(DEFAULT_SPEECH_SETTINGS)
  private playbackStallWatchdog: ReturnType<typeof setTimeout> | null = null
  private playbackStallMessageId: string | null = null

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleGlobalKeydown, true)
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    // While a capture is in any active phase, Escape belongs to the recording
    // flow. It stops an in-progress recording and never falls through to the
    // thread-stop handler until the capture lifecycle is fully idle again.
    if (this.state.state === 'idle' || this.state.state === 'failed') return
    event.preventDefault()
    event.stopPropagation()
    if (this.state.state === 'recording') void this.stop()
  }

  isActiveTarget(targetId: string): boolean {
    return 'targetId' in this.state && this.state.targetId === targetId
  }

  get recordingScope(): SpeechScope | null {
    return this.state.state === 'recording' ? (this.active?.scope ?? null) : null
  }

  isRecordingThread(threadId: string): boolean {
    const scope = this.recordingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  async start(
    target: SpeechEditorTarget,
    scope: SpeechScope,
    preparedSnapshot?: SpeechEditorSnapshot | null
  ): Promise<void> {
    if (this.active || !['idle', 'failed'].includes(this.state.state)) return
    await this.loadSettings()
    const snapshot = preparedSnapshot ?? target.capture()
    if (!snapshot) {
      this.surfaceFailure(target.id, 'prepare', new Error('Focus the editor before recording.'))
      return
    }
    this.state = { state: 'requesting-permission', targetId: target.id }

    const nativeStarted = isRemotePwaRuntime()
      ? null
      : await invoke('speech:beginNativeCapture', scope).catch(() => null)
    if (nativeStarted?.ok) {
      const capture: ActiveCapture = {
        target,
        snapshot,
        scope,
        recorder: null,
        stream: null,
        native: true,
        sessionId: nativeStarted.value.sessionId,
        attemptId: nativeStarted.value.attemptId,
        startedAt: performance.now(),
        uploadTail: Promise.resolve(),
        queuedChunks: 0,
        uploadError: null
      }
      this.active = capture
      this.state = {
        state: 'recording',
        targetId: target.id,
        attemptId: capture.attemptId,
        startedAt: Date.now(),
        elapsedMs: 0
      }
      this.startElapsedTimer(capture)
      this.scheduleAsrPreload(capture)
      this.playCue('started')
      return
    }

    let stream: MediaStream
    try {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        throw new Error('Microphone recording is unavailable in this environment.')
      }
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('Audio recording is unavailable in this environment.')
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
    } catch (cause) {
      const message = errorMessage(cause)
      await invoke('speech:recordPermissionFailure', scope, message).catch(() => undefined)
      this.surfaceFailure(target.id, 'permission', cause)
      return
    }

    let recorder: MediaRecorder
    let pendingSessionId: string | null = null
    let active: ActiveCapture | null = null
    try {
      const mimeType = selectedMimeType()
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000
      })
      const started = await invoke(
        'speech:beginCapture',
        scope,
        recorder.mimeType || mimeType || 'audio/webm'
      )
      if (!started.ok) throw new Error(started.error.message)
      pendingSessionId = started.value.sessionId
      const capture: ActiveCapture = {
        target,
        snapshot,
        scope,
        recorder,
        stream,
        native: false,
        sessionId: started.value.sessionId,
        attemptId: started.value.attemptId,
        startedAt: performance.now(),
        uploadTail: Promise.resolve(),
        queuedChunks: 0,
        uploadError: null
      }
      active = capture
      this.active = capture
      recorder.ondataavailable = (event) => this.queueChunk(capture, event.data)
      recorder.onerror = () => {
        capture.uploadError ??= new Error('The recording device stopped unexpectedly.')
        void this.stop()
      }
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          'ended',
          () => {
            if (this.active !== capture || recorder.state === 'inactive') return
            capture.uploadError ??= new Error(
              'Microphone access was revoked or the device was disconnected.'
            )
            void this.stop()
          },
          { once: true }
        )
      }
      recorder.start(CAPTURE_TIMESLICE_MS)
      pendingSessionId = null
      this.state = {
        state: 'recording',
        targetId: target.id,
        attemptId: capture.attemptId,
        startedAt: Date.now(),
        elapsedMs: 0
      }
      this.startElapsedTimer(capture)
      this.scheduleAsrPreload(capture)
      this.playCue('started')
    } catch (cause) {
      this.clearElapsedTimer()
      this.clearPreloadTimer()
      if (active) {
        active.uploadError ??= cause instanceof Error ? cause : new Error(errorMessage(cause))
        if (active.recorder) await this.stopRecorder(active.recorder).catch(() => undefined)
        if (active.stream) for (const track of active.stream.getTracks()) track.stop()
        await active.uploadTail.catch(() => undefined)
        await invoke('speech:failCapture', active.sessionId, errorMessage(cause)).catch(
          () => undefined
        )
      } else if (pendingSessionId) {
        await invoke('speech:failCapture', pendingSessionId, errorMessage(cause)).catch(
          () => undefined
        )
      }
      for (const track of stream.getTracks()) track.stop()
      this.active = null
      this.surfaceFailure(target.id, 'capture', cause)
    }
  }

  async stop(): Promise<void> {
    const active = this.active
    if (!active) return
    if (this.stopPromise) return this.stopPromise
    const pending = this.finishStop(active)
    this.stopPromise = pending
    try {
      await pending
    } finally {
      if (this.stopPromise === pending) this.stopPromise = null
    }
  }

  private async finishStop(active: ActiveCapture): Promise<void> {
    this.clearElapsedTimer()
    this.clearPreloadTimer()
    this.state = { state: 'stopping', targetId: active.target.id, attemptId: active.attemptId }
    // Capture the target's current value and caret when the user stops, not
    // only when recording started. This lets users type and reposition the
    // caret while the mic is active without losing the intended insertion point.
    const insertionSnapshot = active.target.capture() ?? active.snapshot

    let finalized = false
    try {
      const durationMs = Math.max(0, performance.now() - active.startedAt)
      if (active.native) {
        const finished = await invoke(
          'speech:finishNativeCapture',
          active.sessionId,
          Math.round(durationMs)
        )
        if (!finished.ok) throw new Error(finished.error.message)
      } else {
        if (!active.recorder || !active.stream) throw new Error('Browser capture is unavailable.')
        await this.stopRecorder(active.recorder)
        for (const track of active.stream.getTracks()) track.stop()
        await active.uploadTail
        if (active.uploadError) throw active.uploadError
        const finished = await invoke(
          'speech:finishCapture',
          active.sessionId,
          Math.round(durationMs)
        )
        if (!finished.ok) throw new Error(finished.error.message)
      }
      finalized = true
      this.playCue('stopped')
      this.state = {
        state: 'transcribing',
        targetId: active.target.id,
        attemptId: active.attemptId
      }
      const transcript = await this.transcribeActive(active)
      await invoke('clipboard:writeText', transcript)
      const inserted = active.target.apply(insertionSnapshot, transcript)
      let applied: SpeechEditorApplyResult = inserted
      if (!applied.ok && applied.reason === 'destroyed' && active.target.fallbackApply) {
        applied = active.target.fallbackApply(insertionSnapshot, transcript)
      }
      this.playCue('completed')
      if (!applied.ok) {
        const insertionNotice =
          'Transcript copied to the clipboard. It could not be inserted into the recording field.'
        try {
          toast.info(insertionNotice, { closeButton: true })
        } catch (cause) {
          logRendererError('Could not show the voice recording clipboard notice.', cause)
        }
        this.state = { state: 'idle' }
        return
      }
      const span: SpeechDictationSpan = {
        id: crypto.randomUUID(),
        attemptId: active.attemptId,
        editorId: active.target.id,
        insertedText: transcript,
        startOffset: applied.startOffset,
        endOffset: applied.endOffset,
        insertedAt: Date.now(),
        scope: structuredClone(active.scope)
      }
      const current = this.spans.get(active.target.id) ?? []
      this.spans.set(active.target.id, [...current.slice(-7), span])
      this.state = { state: 'idle' }
    } catch (cause) {
      const message = errorMessage(cause)
      await (
        finalized
          ? invoke('speech:markAttemptFailure', active.attemptId, message)
          : active.native
            ? invoke('speech:failNativeCapture', active.sessionId, message)
            : invoke('speech:failCapture', active.sessionId, message)
      ).catch(() => undefined)
      this.surfaceFailure(active.target.id, finalized ? 'transcription' : 'capture', cause)
    } finally {
      if (active.stream) for (const track of active.stream.getTracks()) track.stop()
      this.active = null
    }
  }

  private stopRecorder(recorder: MediaRecorder): Promise<void> {
    if (recorder.state === 'inactive') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout)
        timeout = null
        recorder.removeEventListener('stop', onStop)
      }
      const onStop = (): void => {
        cleanup()
        resolve()
      }
      recorder.addEventListener('stop', onStop, { once: true })
      timeout = setTimeout(() => {
        cleanup()
        reject(new Error('The recording device did not stop cleanly.'))
      }, CAPTURE_STOP_TIMEOUT_MS)
      try {
        recorder.stop()
      } catch (cause) {
        cleanup()
        reject(cause)
      }
    })
  }

  private surfaceFailure(targetId: string, phase: RecordingFailurePhase, cause: unknown): void {
    const detail = errorMessage(cause)
    logRendererError(`Voice recording ${phase} failed: ${detail}`, cause)
    try {
      reportErrorWithDetails(recordingToastMessage(cause, phase), { details: detail })
    } catch (toastCause) {
      logRendererError('Could not show the voice recording error toast.', toastCause)
    }
    this.state = { state: 'failed', targetId, message: detail }
  }

  resetFailure(targetId: string): void {
    if (this.state.state === 'failed' && this.state.targetId === targetId)
      this.state = { state: 'idle' }
  }

  observeSent(targetId: string, sentText: string): void {
    const spans = this.spans.get(targetId)
    if (!spans?.length) return
    this.spans.delete(targetId)
    const sentAt = Date.now()
    for (const span of spans) {
      void invoke('speech:observeCorrection', { span, sentText, sentAt })
    }
  }

  async togglePlayback(messageId: string, markdown: string): Promise<void> {
    const active = this.activePlayback
    if (active?.prepared.messageId === messageId && active.audio) {
      if (active.audio.paused) {
        await active.audio.play()
        this.playback = {
          state: 'playing',
          sessionId: active.prepared.sessionId,
          messageId,
          segmentIndex: active.index
        }
      } else {
        active.audio.pause()
        this.playback = {
          state: 'paused',
          sessionId: active.prepared.sessionId,
          messageId,
          segmentIndex: active.index
        }
      }
      return
    }
    await this.cancelPlayback()
    pauseCurrentHistoryAudio()
    await this.loadSettings()
    this.playback = { state: 'preparing', sessionId: 'pending', messageId }
    this.armPlaybackStallWatchdog(messageId)
    try {
      const selection = await this.selectTtsArtifact()
      const prepared = await invoke(
        'speech:preparePlayback',
        messageId,
        markdown,
        this.sound.includeCodeBlocksInSpeech
      )
      if (!prepared.ok) throw new Error(prepared.error.message)
      const playback: ActivePlayback = {
        prepared: prepared.value,
        runtime: selection.runtime,
        artifact: selection.artifact,
        voiceId: this.sound.ttsVoiceId ?? selection.artifact.voices[0] ?? '0',
        audio: null,
        audioUrl: null,
        next: null,
        index: 0
      }
      this.activePlayback = playback
      await this.playSegment(playback, 0)
    } catch (cause) {
      this.clearPlaybackStallWatchdog()
      this.playback = {
        state: 'failed',
        messageId,
        error: { code: 'synthesis-failed', message: errorMessage(cause), retryable: true }
      }
    }
  }

  /**
   * Bounds the window between clicking speak and the first audible sample. If
   * something in the pipeline stalls without rejecting (the original infinite
   * spinner bug), the watchdog settles the UI into the normal retryable failed
   * state and tears down the pending playback session.
   */
  private armPlaybackStallWatchdog(messageId: string): void {
    this.clearPlaybackStallWatchdog()
    this.playbackStallMessageId = messageId
    this.playbackStallWatchdog = setTimeout(() => {
      const watchdogMessageId = this.playbackStallMessageId
      this.playbackStallWatchdog = null
      this.playbackStallMessageId = null
      if (!watchdogMessageId) return
      const stillPreparing =
        this.playback.state === 'preparing' && this.playback.messageId === watchdogMessageId
      const activeWithoutAudio =
        this.activePlayback?.prepared.messageId === watchdogMessageId &&
        this.activePlayback.audio === null
      if (!stillPreparing && !activeWithoutAudio) return
      void this.failStalledPlayback(watchdogMessageId)
    }, PLAYBACK_STALL_WATCHDOG_MS)
  }

  private clearPlaybackStallWatchdog(): void {
    if (this.playbackStallWatchdog) clearTimeout(this.playbackStallWatchdog)
    this.playbackStallWatchdog = null
    this.playbackStallMessageId = null
  }

  private async failStalledPlayback(messageId: string): Promise<void> {
    logRendererError(
      `TTS playback stalled for message ${messageId} before any audio started; watchdog stopped it.`
    )
    const active = this.activePlayback
    this.activePlayback = null
    if (active) {
      active.audio?.pause()
      if (active.audioUrl) URL.revokeObjectURL(active.audioUrl)
      await invoke('speech:cancelPlayback', active.prepared.sessionId).catch(() => undefined)
    }
    this.playback = {
      state: 'failed',
      messageId,
      error: {
        code: 'synthesis-failed',
        message:
          'Text-to-speech did not start within 60 seconds. Playback was stopped — click speak to retry.',
        retryable: true
      }
    }
  }

  async cancelPlayback(): Promise<void> {
    const active = this.activePlayback
    this.activePlayback = null
    this.clearPlaybackStallWatchdog()
    if (active) {
      active.audio?.pause()
      if (active.audioUrl) URL.revokeObjectURL(active.audioUrl)
      await invoke('speech:cancelPlayback', active.prepared.sessionId).catch(() => undefined)
    }
    this.playback = { state: 'idle' }
  }

  private queueChunk(active: ActiveCapture, blob: Blob): void {
    if (blob.size === 0) return
    const recorder = active.recorder
    if (!recorder) return
    active.queuedChunks += 1
    if (active.queuedChunks >= PAUSE_UPLOAD_DEPTH && recorder.state === 'recording') {
      recorder.pause()
    }
    active.uploadTail = active.uploadTail
      .then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const appended = await invoke('speech:appendCapture', active.sessionId, bytes)
        if (!appended.ok) throw new Error(appended.error.message)
      })
      .catch((cause: unknown) => {
        active.uploadError = cause instanceof Error ? cause : new Error(String(cause))
        void this.stop()
      })
      .finally(() => {
        active.queuedChunks -= 1
        if (
          active.queuedChunks < PAUSE_UPLOAD_DEPTH &&
          recorder.state === 'paused' &&
          !active.uploadError
        ) {
          recorder.resume()
        }
      })
  }

  private startElapsedTimer(active: ActiveCapture): void {
    this.clearElapsedTimer()
    this.elapsedTimer = setInterval(() => {
      if (this.active !== active || this.state.state !== 'recording') return
      this.state.elapsedMs = Math.max(0, performance.now() - active.startedAt)
    }, 250)
  }

  private clearElapsedTimer(): void {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer)
    this.elapsedTimer = null
  }

  private clearPreloadTimer(): void {
    if (this.preloadTimer) clearTimeout(this.preloadTimer)
    this.preloadTimer = null
  }

  private scheduleAsrPreload(active: ActiveCapture): void {
    this.clearPreloadTimer()
    this.preloadFired = false
    this.preloadTimer = setTimeout(() => {
      if (this.active !== active || this.state.state !== 'recording') return
      if (this.preloadFired) return
      this.preloadFired = true
      void this.preloadAsr()
    }, 2000)
  }

  private async preloadAsr(): Promise<void> {
    try {
      const selection = await this.selectAsrArtifact()
      await invoke('speech:preloadAsr', selection.runtime, selection.artifact.id)
    } catch {
      // Best-effort warmup; errors surface at transcription time.
    }
  }

  private async selectAsrArtifact(): Promise<{
    runtime: SpeechRuntime
    artifact: SpeechModelArtifact
  }> {
    const [capabilities, catalog] = await Promise.all([
      invoke('speech:getCapabilities'),
      invoke('speech:getCatalog')
    ])
    if (!capabilities.ok) throw new Error(capabilities.error.message)
    if (!catalog.ok) throw new Error(catalog.error.message)
    const installedAll = capabilities.value.installedArtifacts.filter((a) => a.available)
    const installedIds = new Set(installedAll.map((a) => a.artifactId))
    const activeArtifactId = this.sound.asrArtifactId
    if (activeArtifactId) {
      const chosenInstalled = installedAll.find((a) => a.artifactId === activeArtifactId)
      if (chosenInstalled) {
        const catalogHit = catalog.value.artifacts.find((c) => c.id === chosenInstalled.artifactId)
        if (catalogHit) {
          if (catalogHit.capability === 'asr' && catalogHit.qualification.status !== 'retired')
            return { runtime: chosenInstalled.runtime, artifact: catalogHit }
        } else if (chosenInstalled.capability !== 'tts') {
          // Imported model — synthesize a pseudo-artifact; service will handle directory
          const pseudo = {
            id: chosenInstalled.artifactId,
            familyId: 'whisper',
            capability: 'asr' as const,
            runtime: chosenInstalled.runtime,
            label: chosenInstalled.importPath?.split('/').pop() ?? chosenInstalled.artifactId,
            description: '',
            tier: 'balanced' as const,
            version: 'imported',
            repositoryRevision: 'imported',
            platforms: [] as unknown as string[],
            architectures: [] as unknown as string[],
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
          } as unknown as import('../../../lib/speech/types').SpeechModelArtifact
          return { runtime: chosenInstalled.runtime, artifact: pseudo }
        }
      }
      this.forgetUnavailableAsrSelection(activeArtifactId)
    }
    const artifact = catalog.value.artifacts.find(
      (candidate) =>
        candidate.capability === 'asr' &&
        candidate.qualification.status !== 'retired' &&
        installedIds.has(candidate.id)
    )
    if (!artifact) throw new Error(`Install a speech-to-text model in Sound settings.`)
    return { runtime: artifact.runtime, artifact }
  }

  private forgetUnavailableAsrSelection(artifactId: string): void {
    if (this.sound.asrArtifactId !== artifactId) return
    const nextSound = { ...this.sound, asrArtifactId: undefined }
    this.sound = nextSound
    void invoke('config:update', { sound: nextSound }).catch((cause: unknown) => {
      logRendererError('Could not clear the unavailable speech-to-text model selection.', cause)
    })
  }

  /**
   * Produce the final transcript for a finished capture. Prefers an installed
   * local ASR model; when voice recording is enabled and no local ASR is
   * installed, falls back to audio-to-LLM transcription (audio never leaves the
   * device unless the user has opted in via the default-`false` toggle).
   */
  private async transcribeActive(active: ActiveCapture): Promise<string> {
    if (this.sound.voiceRecordingEnabled) {
      let selection: { runtime: SpeechRuntime; artifact: SpeechModelArtifact } | null
      try {
        selection = await this.selectAsrArtifact()
      } catch {
        selection = null
      }
      if (selection) {
        const result = await invoke(
          'speech:transcribe',
          active.attemptId,
          selection.runtime,
          selection.artifact.id,
          'auto',
          this.cleanupMode()
        )
        if (!result.ok) throw new Error(result.error.message)
        return result.value.finalTranscript
      }
      const audioLlm = await invoke(
        'speech:transcribeAudioToLlm',
        active.attemptId,
        active.scope,
        'auto',
        this.cleanupMode()
      )
      if (!audioLlm.ok) throw new Error(audioLlm.error.message)
      return audioLlm.value.finalTranscript
    }
    const selection = await this.selectAsrArtifact()
    const result = await invoke(
      'speech:transcribe',
      active.attemptId,
      selection.runtime,
      selection.artifact.id,
      'auto',
      this.cleanupMode()
    )
    if (!result.ok) throw new Error(result.error.message)
    return result.value.finalTranscript
  }

  private cleanupMode(): import('../../../lib/speech/types').SpeechCleanupMode {
    if (this.sound.localLlmCleanupEnabled) return { kind: 'local-llm' }
    if (this.sound.remoteCleanupEnabled) {
      return {
        kind: 'remote',
        selection: this.sound.remoteCleanupSelection,
        ...(this.sound.remoteCleanupModelId ? { modelId: this.sound.remoteCleanupModelId } : {})
      }
    }
    return this.sound.localCleanupEnabled
      ? { kind: 'local', artifactId: this.sound.cleanupArtifactId }
      : { kind: 'disabled' }
  }

  private async selectTtsArtifact(): Promise<{
    runtime: SpeechRuntime
    artifact: SpeechModelArtifact
  }> {
    const [capabilities, catalog] = await Promise.all([
      invoke('speech:getCapabilities'),
      invoke('speech:getCatalog')
    ])
    if (!capabilities.ok) throw new Error(capabilities.error.message)
    if (!catalog.ok) throw new Error(catalog.error.message)
    const installedAll = capabilities.value.installedArtifacts.filter((item) => item.available)
    const installed = new Set(installedAll.map((item) => item.artifactId))
    if (this.sound.ttsArtifactId) {
      const chosenInstalled = installedAll.find((a) => a.artifactId === this.sound.ttsArtifactId)
      if (chosenInstalled) {
        const catalogHit = catalog.value.artifacts.find((c) => c.id === chosenInstalled.artifactId)
        if (catalogHit) {
          if (catalogHit.capability === 'tts' && catalogHit.qualification.status !== 'retired')
            return { runtime: chosenInstalled.runtime, artifact: catalogHit }
        } else {
          const pseudo = {
            id: chosenInstalled.artifactId,
            familyId: 'kokoro',
            capability: 'tts' as const,
            runtime: chosenInstalled.runtime,
            label: chosenInstalled.importPath?.split('/').pop() ?? chosenInstalled.artifactId,
            description: '',
            tier: 'balanced' as const,
            version: 'imported',
            repositoryRevision: 'imported',
            platforms: [] as unknown as string[],
            architectures: [] as unknown as string[],
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
          } as unknown as import('../../../lib/speech/types').SpeechModelArtifact
          return { runtime: chosenInstalled.runtime, artifact: pseudo }
        }
      }
      throw new Error(`The active text-to-speech model is not installed.`)
    }
    const artifact = catalog.value.artifacts.find(
      (item) =>
        item.capability === 'tts' &&
        item.qualification.status !== 'retired' &&
        installed.has(item.id)
    )
    if (!artifact) throw new Error(`Install a text-to-speech model.`)
    return { runtime: artifact.runtime, artifact }
  }

  private synthesize(playback: ActivePlayback, index: number): Promise<SpeechSynthesizedSegment> {
    return invoke(
      'speech:synthesizePlaybackSegment',
      playback.prepared.sessionId,
      index,
      playback.runtime,
      playback.artifact.id,
      playback.voiceId
    ).then((result) => {
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    })
  }

  private async playSegment(playback: ActivePlayback, index: number): Promise<void> {
    if (this.activePlayback !== playback) return
    const synthesized = playback.next ? await playback.next : await this.synthesize(playback, index)
    playback.next = null
    if (this.activePlayback !== playback) return
    playback.index = index
    if (index + 1 < playback.prepared.segments.length) {
      playback.next = this.synthesize(playback, index + 1)
    }
    if (playback.audioUrl) URL.revokeObjectURL(playback.audioUrl)
    const url = URL.createObjectURL(new Blob([synthesized.audio], { type: 'audio/wav' }))
    const audio = new Audio(url)
    playback.audioUrl = url
    playback.audio = audio
    audio.addEventListener(
      'ended',
      () => {
        if (this.activePlayback !== playback) return
        if (index + 1 < playback.prepared.segments.length) {
          void this.playSegment(playback, index + 1).catch((cause: unknown) => {
            this.clearPlaybackStallWatchdog()
            this.playback = {
              state: 'failed',
              messageId: playback.prepared.messageId,
              error: {
                code: 'synthesis-failed',
                message: errorMessage(cause),
                retryable: true
              }
            }
          })
        } else {
          this.clearPlaybackStallWatchdog()
          this.playback = { state: 'completed', messageId: playback.prepared.messageId }
          void this.cancelPlayback()
        }
      },
      { once: true }
    )
    pauseCurrentHistoryAudio()
    await audio.play()
    this.clearPlaybackStallWatchdog()
    this.playback = {
      state: 'playing',
      sessionId: playback.prepared.sessionId,
      messageId: playback.prepared.messageId,
      segmentIndex: index
    }
  }

  private playCue(kind: 'started' | 'stopped' | 'completed'): void {
    const enabled =
      kind === 'started'
        ? this.sound.cues.listeningStarted
        : kind === 'stopped'
          ? this.sound.cues.recordingStopped
          : this.sound.cues.transcriptReady
    if (!enabled || this.sound.cues.volume === 0) return
    const AudioContextConstructor = window.AudioContext
    if (typeof AudioContextConstructor !== 'function') return
    try {
      const context = new AudioContextConstructor()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const frequency = kind === 'started' ? 520 : kind === 'stopped' ? 360 : 700
      oscillator.frequency.setValueAtTime(frequency, context.currentTime)
      gain.gain.setValueAtTime(0.0001, context.currentTime)
      gain.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, 0.06 * this.sound.cues.volume),
        context.currentTime + 0.01
      )
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.1)
      oscillator.addEventListener('ended', () => void context.close(), { once: true })
    } catch (cause) {
      logRendererError(`Voice recording ${kind} cue failed: ${errorMessage(cause)}`, cause)
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      const config = await invoke('config:get')
      this.sound = structuredClone(config.sound)
    } catch {
      this.sound = structuredClone(DEFAULT_SPEECH_SETTINGS)
    }
  }
}

export const speechController = new SpeechController()
