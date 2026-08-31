import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { isWorkspaceCovered } from '$lib/stores/page-surface.svelte'
import { mobileState } from '$lib/remote/mobile-state.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
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
  /**
   * Blob URL per segment, indexed by segment index. A `null` slot is a block
   * skipped after a synthesis failure — it keeps later indexes aligned and can
   * still be synthesized on demand when the user seeks back into it.
   */
  retainedUrls: Array<string | null>
  /** Media duration per retained segment; NaN until metadata loads. */
  durations: number[]
  /** Prefetch handle plus the segment index it belongs to. */
  next: Promise<SpeechSynthesizedSegment> | null
  nextIndex: number | null
  /** Bumped whenever the user relocates the playhead; invalidates stale chains. */
  generation: number
  index: number
  /** Back-to-back segment synthesis failures before the session is abandoned. */
  consecutiveFailures: number
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
// After pausing, keep the read-along border and seek controls on screen for a
// few seconds so users can resume without losing their place. Then fade out.
const PAUSED_LINGER_MS = 5_000

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
    return this.currentSegments
  }
  /** Read-along border visibility: playing, or paused within the linger window. */
  get readingOverlayActive(): boolean {
    return this.readAlongVisible
  }
  /** Seek slider visibility mirrors the read-along overlay (same linger timer). */
  get seekControlsActive(): boolean {
    const state = this.playback.state
    if (state !== 'playing' && state !== 'paused') return false
    return this.readAlongVisible
  }
  /** Index of the line to highlight while the overlay is up; -1 hides it. */
  get visibleSegmentIndex(): number {
    if (!this.readAlongVisible) return -1
    const current = this.playback
    if ('segmentIndex' in current && (current.state === 'playing' || current.state === 'paused'))
      return current.segmentIndex
    return -1
  }
  get elapsedPlaybackSeconds(): number {
    return this.elapsedSeconds
  }
  get knownPlaybackDurationSeconds(): number {
    return this.knownDurationSeconds
  }
  /**
   * Fraction (0..1) of the active block already spoken, for word-level
   * read-along highlighting. Reactive through the `elapsedSeconds` mirror,
   * which the segment audio's timeupdate events refresh several times a
   * second — plenty for advancing a whole-word highlight.
   */
  get activeSegmentProgress(): number {
    const current = this.playback
    if (!('segmentIndex' in current) || (current.state !== 'playing' && current.state !== 'paused'))
      return 0
    const playback = this.activePlayback
    if (!playback) return 0
    const index = current.segmentIndex
    let prefix = 0
    for (let i = 0; i < index; i += 1) prefix += this.segmentSeconds(playback, i)
    const span = this.segmentSeconds(playback, index)
    if (!(span > 0)) return 0
    const within = this.elapsedSeconds - prefix
    return Math.min(1, Math.max(0, within / span))
  }
  /** Estimated duration of the entire readable block; the slider's full range. */
  get estimatedTotalDurationSeconds(): number {
    const playback = this.activePlayback
    if (!playback) return 0
    let total = 0
    for (let i = 0; i < playback.prepared.segments.length; i += 1)
      total += this.segmentSeconds(playback, i)
    return total
  }
  /** Seconds of audio already generated (filled part of the seek track). */
  get generatedFrontierSeconds(): number {
    const playback = this.activePlayback
    if (!playback) return 0
    let total = 0
    for (let i = 0; i < playback.retainedUrls.length; i += 1) {
      if (!playback.retainedUrls[i]) continue
      total += this.segmentSeconds(playback, i)
    }
    return total
  }

  private static readonly FALLBACK_CHARS_PER_SECOND = 12

  /**
   * Duration of one segment: real media length once known, otherwise a
   * characters-per-second estimate calibrated against the audio already heard.
   */
  private segmentSeconds(playback: ActivePlayback, index: number): number {
    const duration = playback.durations[index]
    if (Number.isFinite(duration)) return duration
    const text = playback.prepared.segments[index]?.text ?? ''
    let knownChars = 0
    let knownSeconds = 0
    for (let i = 0; i < playback.retainedUrls.length; i += 1) {
      const known = playback.durations[i]
      if (!Number.isFinite(known)) continue
      knownChars += playback.prepared.segments[i]?.text.length ?? 0
      knownSeconds += known
    }
    if (knownChars > 0 && knownSeconds > 0) return text.length / (knownChars / knownSeconds)
    return text.length / SpeechController.FALLBACK_CHARS_PER_SECOND
  }

  /** Maps a slider position onto (segment, offset) across the whole block. */
  private locatePlaybackPosition(
    playback: ActivePlayback,
    seconds: number
  ): { index: number; offset: number } {
    let remaining = seconds
    const lastIndex = playback.prepared.segments.length - 1
    for (let i = 0; i <= lastIndex; i += 1) {
      const span = this.segmentSeconds(playback, i)
      if (remaining <= span || i === lastIndex) return { index: i, offset: Math.max(0, remaining) }
      remaining -= span
    }
    return { index: -1, offset: 0 }
  }
  private active: ActiveCapture | null = null
  /** Scope captured when `start()` begins so the capture is attributable to
   *  its thread even before permission resolves (no ActiveCapture yet). */
  private captureScope: SpeechScope | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private preloadTimer: ReturnType<typeof setTimeout> | null = null
  private preloadFired = false
  /** In-flight background transcription jobs, keyed by attempt id. */
  private readonly transcriptions = new Map<string, Promise<void>>()
  /** Target ids with a background transcription job still in flight. */
  private transcribingTargets = $state<string[]>([])
  private readonly spans = new Map<string, SpeechDictationSpan[]>()
  private activePlayback: ActivePlayback | null = null
  // Reactive mirror consumed by the per-line TTS highlight rendering. Kept
  // separate from activePlayback because storing the live playback record
  // (promises, media elements) behind a $state proxy would break the raw-local
  // identity checks that guard every step of segment playback.
  private currentSegments = $state<SpeechSegment[] | null>(null)
  private stopPromise: Promise<void> | null = null
  private sound = structuredClone(DEFAULT_SPEECH_SETTINGS)
  private playbackStallWatchdog: ReturnType<typeof setTimeout> | null = null
  private playbackStallMessageId: string | null = null
  private pausedLingerTimer: ReturnType<typeof setTimeout> | null = null
  /** Where the spoken response lives, for row-level "Speaking" indicators. */
  private playbackScope = $state<SpeechScope | null>(null)
  /** Whether the read-along border + seek controls are on screen right now. */
  private readAlongVisible = $state(false)
  /** Playhead position in seconds across all retained (played) segments. */
  private elapsedSeconds = $state(0)
  /** Sum of known media durations; grows as segment metadata loads. */
  private knownDurationSeconds = $state(0)

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleGlobalKeydown, true)
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (this.state.state !== 'recording') return
    if (!this.escapeStopsRecording()) return
    event.preventDefault()
    event.stopPropagation()
    void this.stop()
  }

  /**
   * Escape may end a recording only while the user is viewing the surface that
   * is recording. A thread-scoped capture keeps running when the user navigates
   * to another thread, so Escape pressed there must keep its normal meaning
   * (stop that thread's run, close an overlay) instead of killing a recording
   * happening elsewhere — the user returns to the recording thread to stop it.
   * Recordings without a thread (global overlays like the switcher) stay
   * Escapable from anywhere because their owning surface remains on screen.
   */
  private escapeStopsRecording(): boolean {
    const active = this.active
    if (!active) return false
    // A full-page surface (a Settings page or the Scope view) covers the
    // workspace shell, so the user is not viewing the recording surface —
    // Escape there closes the page on top and must never kill a recording.
    if (isWorkspaceCovered()) return false
    const scope = active.scope
    if (scope.kind === 'global' || scope.threadId === undefined) return true
    // Temporary side chats render a synthetic thread that is never the
    // selected workspace thread — they live in the context sidebar. When a
    // temporary chat is the active sidebar tab, the user "is on" that chat,
    // so Escape must reach its own recording. A recording belonging to any
    // other thread must not be gated by the sidebar tab; it falls through to
    // the viewed-thread check below.
    const sidebarTab = contextSidebarState.activeTab
    if (sidebarTab?.kind === 'temporary-chat') {
      if (sidebarTab.temporaryChatId === scope.threadId) {
        return scope.kind !== 'project' || sidebarTab.projectId === scope.projectId
      }
    }
    const viewed = isRemotePwaRuntime()
      ? mobileState.selectedThread
      : workspaceState.selectedThread
    if (!viewed || viewed.id !== scope.threadId) return false
    if (scope.kind === 'project') return viewed.projectId === scope.projectId
    return true
  }

  isActiveTarget(targetId: string): boolean {
    return 'targetId' in this.state && this.state.targetId === targetId
  }

  /**
   * Swaps the active capture's editor target for a live one with the same id.
   * The editor that started a recording can be destroyed by navigation while
   * the capture is still running (the controller outlives the view); when an
   * equivalent editor mounts again — e.g. the user returned to the thread
   * before the transcript landed — the transcript must insert into the visible
   * editor instead of falling back to the draft store behind its back. Returns
   * true when the reattach happened.
   */
  reattachTarget(target: SpeechEditorTarget): boolean {
    const active = this.active
    if (!active || active.target.id !== target.id) return false
    active.target = target
    return true
  }

  get recordingScope(): SpeechScope | null {
    return this.state.state === 'recording' ? (this.active?.scope ?? null) : null
  }

  /** The scope of whichever editor is dictating across every live phase —
   *  requesting-permission → recording → stopping. Unlike `recordingScope`
   *  this stays non-null after the mic closes until the transcript lands or
   *  the capture fails, so consumers that represent in-progress drafting
   *  (thread rows) never flash back mid-pipeline. */
  get capturingScope(): SpeechScope | null {
    if (this.state.state === 'idle' || this.state.state === 'failed') return null
    return this.captureScope ?? this.active?.scope ?? null
  }

  isRecordingThread(threadId: string): boolean {
    const scope = this.recordingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  isCapturingThread(threadId: string): boolean {
    const scope = this.capturingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  /** Whether a detached background transcription is still running for this
   *  editor target — the transcript will land in the field when it settles. */
  isTranscribingTarget(targetId: string): boolean {
    return this.transcribingTargets.includes(targetId)
  }

  /** Scope of the thread whose response is currently being spoken aloud. */
  get speakingScope(): SpeechScope | null {
    const playbackState = this.playback
    if (!('messageId' in playbackState)) return null
    if (
      playbackState.state !== 'preparing' &&
      playbackState.state !== 'playing' &&
      playbackState.state !== 'paused'
    )
      return null
    return this.playbackScope
  }

  isSpeakingThread(threadId: string): boolean {
    const scope = this.speakingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  async start(
    target: SpeechEditorTarget,
    scope: SpeechScope,
    preparedSnapshot?: SpeechEditorSnapshot | null
  ): Promise<void> {
    if (this.active || !['idle', 'failed'].includes(this.state.state)) return
    // TTS and the recorder cannot run together; whoever started last wins.
    const playbackState = this.playback
    if (
      'messageId' in playbackState &&
      ['preparing', 'playing', 'paused'].includes(playbackState.state)
    ) {
      await this.cancelPlayback()
    }
    this.captureScope = scope
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
      this.playCue('stopped')
      const transcription = this.deliverTranscript(active, insertionSnapshot)
      this.transcriptions.set(active.attemptId, transcription)
      void transcription.finally(() => {
        const current = this.transcriptions.get(active.attemptId)
        if (current === transcription) this.transcriptions.delete(active.attemptId)
      })
    } catch (cause) {
      const message = errorMessage(cause)
      await (
        active.native
          ? invoke('speech:failNativeCapture', active.sessionId, message)
          : invoke('speech:failCapture', active.sessionId, message)
      ).catch(() => undefined)
      this.surfaceFailure(active.target.id, 'capture', cause)
    } finally {
      if (active.stream) for (const track of active.stream.getTracks()) track.stop()
      this.active = null
      if (this.state.state === 'stopping') this.state = { state: 'idle' }
    }
  }

  /**
   * Detached per-attempt transcription job. Runs in the background so the
   * microphone and the shared state machine free up for a new recording while
   * ASR is still processing. Never rejects: every failure path is settled here.
   */
  private async deliverTranscript(
    active: ActiveCapture,
    insertionSnapshot: SpeechEditorSnapshot
  ): Promise<void> {
    this.transcribingTargets = [...this.transcribingTargets, active.target.id]
    try {
      const transcript = await this.transcribeActive(active)
      await invoke('clipboard:writeText', transcript)
      const inserted = active.target.apply(insertionSnapshot, transcript)
      let applied: SpeechEditorApplyResult = inserted
      if (!applied.ok && applied.reason === 'destroyed' && active.target.fallbackApply) {
        applied = active.target.fallbackApply(insertionSnapshot, transcript)
      }
      if (!applied.ok) {
        const insertionNotice =
          'Transcript copied to the clipboard. It could not be inserted into the recording field.'
        try {
          toast.info(insertionNotice, { closeButton: true })
        } catch (cause) {
          logRendererError('Could not show the voice recording clipboard notice.', cause)
        }
        return
      }
      const span: SpeechDictationSpan = {
        id: crypto.randomUUID(),
        attemptId: active.attemptId,
        editorId: active.target.id,
        insertedText: transcript,
        insertedAt: Date.now(),
        scope: structuredClone(active.scope)
      }
      const current = this.spans.get(active.target.id) ?? []
      this.spans.set(active.target.id, [...current.slice(-7), span])
      this.playCue('completed')
    } catch (cause) {
      await invoke('speech:markAttemptFailure', active.attemptId, errorMessage(cause)).catch(
        () => undefined
      )
      logRendererError(`Voice transcription failed for attempt ${active.attemptId}: ${errorMessage(cause)}`)
      try {
        reportErrorWithDetails('Voice transcription failed.', { details: errorMessage(cause) })
      } catch {
        // Toast failures must never break the detached job.
      }
    } finally {
      this.transcribingTargets = this.transcribingTargets.filter(
        (id) => id !== active.target.id
      )
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
      void invoke('speech:observeCorrection', {
        insertedText: span.insertedText,
        sentText,
        scope: span.scope,
        sentAt
      })
    }
  }

  async togglePlayback(messageId: string, markdown: string, scope?: SpeechScope): Promise<void> {
    // TTS and the recorder cannot run together; whoever started last wins.
    if (this.state.state === 'recording') await this.stop()
    const active = this.activePlayback
    if (active?.prepared.messageId === messageId && active.audio) {
      if (active.audio.paused) {
        await active.audio.play()
        this.clearPausedLinger()
        this.readAlongVisible = true
        this.playback = {
          state: 'playing',
          sessionId: active.prepared.sessionId,
          messageId,
          segmentIndex: active.index
        }
      } else {
        active.audio.pause()
        this.armPausedLinger()
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
        retainedUrls: [],
        durations: [],
        next: null,
        nextIndex: null,
        generation: 0,
        index: 0,
        consecutiveFailures: 0
      }
      this.activePlayback = playback
      this.currentSegments = playback.prepared.segments
      this.playbackScope = scope ?? null
      await this.playSegment(playback, 0)
    } catch (cause) {
      this.clearPlaybackStallWatchdog()
      this.resetSeekSurfaces()
      this.activePlayback?.next?.catch(() => undefined)
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
    this.currentSegments = null
    this.playbackScope = null
    this.clearPlaybackStallWatchdog()
    this.resetSeekSurfaces()
    if (active) {
      active.audio?.pause()
      active.next?.catch(() => undefined)
      for (const url of active.retainedUrls) if (url) URL.revokeObjectURL(url)
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
    this.currentSegments = null
    this.playbackScope = null
    this.clearPlaybackStallWatchdog()
    this.resetSeekSurfaces()
    if (active) {
      active.audio?.pause()
      active.next?.catch(() => undefined)
      for (const url of active.retainedUrls) if (url) URL.revokeObjectURL(url)
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
    const flags = this.sound.refinementFlags
    if (this.sound.remoteCleanupEnabled) {
      return {
        kind: 'remote',
        selection: this.sound.remoteCleanupSelection,
        ...(this.sound.remoteCleanupModelId ? { modelId: this.sound.remoteCleanupModelId } : {}),
        ...(flags ? { flags } : {})
      }
    }
    return this.sound.localCleanupEnabled
      ? {
          kind: 'local',
          artifactId: this.sound.cleanupArtifactId,
          ...(flags ? { flags } : {})
        }
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
    const generationAtStart = playback.generation
    await this.obtainSegmentAudio(playback, index)
    if (
      this.activePlayback !== playback ||
      playback.generation !== generationAtStart ||
      index >= playback.retainedUrls.length
    )
      return
    if (index + 1 < playback.prepared.segments.length && !playback.next) {
      const prefetchIndex = index + 1
      const prefetch = this.synthesize(playback, prefetchIndex)
      // The rejection is consumed by obtainSegmentAudio once this segment is
      // reached; attach a no-op now so it never surfaces as an unhandled
      // rejection while the current block is still playing.
      prefetch.catch(() => undefined)
      playback.next = prefetch
      playback.nextIndex = prefetchIndex
    }
    pauseCurrentHistoryAudio()
    await this.startSegmentAudio(playback, index, 0)
  }

  /**
   * Makes sure a generated blob exists for `index`, synthesizing on demand and
   * reusing an in-flight prefetch when it targets the same segment. Safe to
   * call from both the natural chain and explicit seeks. Skipped blocks keep a
   * `null` slot so indexes stay aligned and every index stays reachable.
   */
  private async obtainSegmentAudio(playback: ActivePlayback, index: number): Promise<void> {
    if (index < playback.retainedUrls.length && playback.retainedUrls[index]) return
    let promise: Promise<SpeechSynthesizedSegment>
    if (playback.next && playback.nextIndex === index) {
      promise = playback.next
    } else {
      // A stale prefetch for another index must not surface as unhandled.
      playback.next?.catch(() => undefined)
      promise = this.synthesize(playback, index)
    }
    playback.next = null
    playback.nextIndex = null
    const synthesized = await promise
    // Retain even for an abandoned session so cleanup still revokes the blob.
    const url = URL.createObjectURL(new Blob([synthesized.audio], { type: 'audio/wav' }))
    while (playback.retainedUrls.length < index) {
      playback.retainedUrls.push(null)
      playback.durations.push(Number.NaN)
    }
    if (index < playback.retainedUrls.length) {
      playback.retainedUrls[index] = url
      playback.durations[index] = Number.NaN
    } else {
      playback.retainedUrls.push(url)
      playback.durations.push(Number.NaN)
    }
  }

  /**
   * Plays (or positions) a segment's retained audio, constructing the element
   * when this segment is not already loaded. Paused seeks pass autoplay=false
   * so scrubbing never surprises the user with sudden sound.
   */
  private async startSegmentAudio(
    playback: ActivePlayback,
    index: number,
    offsetSeconds: number,
    autoplay = true
  ): Promise<void> {
    if (this.activePlayback !== playback) return
    const url = playback.retainedUrls[index]
    if (!url) return
    playback.index = index
    let audio = playback.audio
    if (!audio || audio.dataset.segmentIndex !== String(index)) {
      audio?.pause()
      audio = new Audio(url)
      audio.dataset.segmentIndex = String(index)
      if (offsetSeconds > 0) audio.dataset.pendingStart = String(offsetSeconds)
      this.wireSegmentAudio(playback, audio, index)
      playback.audio = audio
    } else if (offsetSeconds > 0 && audio.readyState >= 1) {
      try {
        audio.currentTime = offsetSeconds
      } catch {
        // Ignore; timeupdate reconciles the slider next tick.
      }
    }
    this.syncSeekCounters(playback)
    if (autoplay) {
      try {
        await audio.play()
      } finally {
        if (this.activePlayback === playback) {
          this.clearPausedLinger()
          this.readAlongVisible = true
        }
      }
      if (this.activePlayback !== playback) return
      this.clearPlaybackStallWatchdog()
      playback.consecutiveFailures = 0
      this.playback = {
        state: 'playing',
        sessionId: playback.prepared.sessionId,
        messageId: playback.prepared.messageId,
        segmentIndex: index
      }
    } else {
      // Positioned while paused: refresh the linger clock like a fresh pause.
      this.armPausedLinger()
    }
  }

  private wireSegmentAudio(playback: ActivePlayback, audio: HTMLAudioElement, index: number): void {
    audio.addEventListener(
      'loadedmetadata',
      () => {
        if (this.activePlayback !== playback) return
        playback.durations[index] = Number.isFinite(audio.duration) ? audio.duration : 0
        const pendingStart = Number(audio.dataset.pendingStart ?? '')
        if (pendingStart > 0) {
          delete audio.dataset.pendingStart
          try {
            audio.currentTime = pendingStart
          } catch {
            // Ignore; the first timeupdate will still report a sane position.
          }
        }
        this.syncSeekCounters(playback)
      },
      { once: true }
    )
    audio.addEventListener('timeupdate', () => {
      if (this.activePlayback !== playback) return
      this.syncSeekCounters(playback)
    })
    audio.addEventListener(
      'ended',
      () => {
        if (this.activePlayback !== playback) return
        this.continueAfter(playback, index)
      },
      { once: true }
    )
  }

  /**
   * Chains into the next block when one finishes. A block whose synthesis
   * fails (e.g. the engine rejects overlong text) must not kill the whole
   * session — reading skips it and continues. Three consecutive failures mean
   * the engine itself is broken, so the session settles into the retryable
   * failed state instead of silently muting everything.
   */
  private continueAfter(playback: ActivePlayback, fromIndex: number): void {
    if (this.activePlayback !== playback) return
    const nextIndex = fromIndex + 1
    if (nextIndex >= playback.prepared.segments.length) {
      this.completePlayback(playback)
      return
    }
    void this.playSegment(playback, nextIndex).catch((cause: unknown) => {
      if (this.activePlayback !== playback) return
      playback.consecutiveFailures += 1
      if (playback.consecutiveFailures >= 3) {
        this.clearPlaybackStallWatchdog()
        this.resetSeekSurfaces()
        this.playback = {
          state: 'failed',
          messageId: playback.prepared.messageId,
          error: {
            code: 'synthesis-failed',
            message: errorMessage(cause),
            retryable: true
          }
        }
        return
      }
      logRendererError(
        `TTS block ${nextIndex} could not be synthesized; continuing with the next block: ${errorMessage(cause)}`
      )
      this.continueAfter(playback, nextIndex)
    })
  }

  private completePlayback(playback: ActivePlayback): void {
    this.clearPlaybackStallWatchdog()
    this.resetSeekSurfaces()
    this.playback = { state: 'completed', messageId: playback.prepared.messageId }
    void this.cancelPlayback()
  }

  /** Publishes the cross-segment playhead and generated-frontier counters. */
  private syncSeekCounters(playback: ActivePlayback): void {
    let prefix = 0
    for (let i = 0; i < playback.index; i += 1) prefix += this.segmentSeconds(playback, i)
    const current = playback.audio?.currentTime ?? 0
    this.elapsedSeconds = prefix + current
    this.knownDurationSeconds = this.generatedFrontierSeconds
  }

  /** Hides the read-along border and seek controls at terminal states. */
  private resetSeekSurfaces(): void {
    this.clearPausedLinger()
    this.readAlongVisible = false
    this.elapsedSeconds = 0
    this.knownDurationSeconds = 0
  }

  private armPausedLinger(): void {
    this.clearPausedLinger()
    this.pausedLingerTimer = setTimeout(() => {
      this.pausedLingerTimer = null
      if (this.playback.state !== 'paused') return
      this.readAlongVisible = false
    }, PAUSED_LINGER_MS)
  }

  private clearPausedLinger(): void {
    if (this.pausedLingerTimer) clearTimeout(this.pausedLingerTimer)
    this.pausedLingerTimer = null
  }

  /**
   * Moves the playhead anywhere in the whole block. Positions inside the
   * current segment just move the cursor; other targets (forward or back)
   * swap in that segment's retained audio, synthesizing it first when it has
   * never been generated. A stale request (user kept dragging) is discarded.
   */
  async seekPlayback(seconds: number): Promise<void> {
    const playback = this.activePlayback
    if (!playback || playback.prepared.segments.length === 0) return
    const pausedAtStart = this.playback.state === 'paused'
    const { index, offset } = this.locatePlaybackPosition(playback, Math.max(0, seconds))
    if (index === -1) return
    if (index === playback.index && playback.audio) {
      // Cursor move within the loaded segment.
      try {
        playback.audio.currentTime = offset
      } catch {
        // Metadata pending; the next timeupdate reconciles the slider.
      }
      this.syncSeekCounters(playback)
      if (pausedAtStart) {
        this.armPausedLinger()
      } else {
        this.clearPausedLinger()
        this.readAlongVisible = true
      }
      return
    }
    // Cross-segment relocation: any previously chained continuation is stale.
    playback.generation += 1
    const token = playback.generation
    if (playback.audio && !playback.audio.paused && !pausedAtStart) {
      // Stop sound immediately so scrubbing forward feels instant while the
      // target segment (if uncached) is being generated.
      playback.audio.pause()
    }
    try {
      await this.obtainSegmentAudio(playback, index)
    } catch {
      return
    }
    if (this.activePlayback !== playback || playback.generation !== token) return
    await this.startSegmentAudio(playback, index, offset, !pausedAtStart)
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
