import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { isEscapeClaimed } from '$lib/stores/page-surface.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { commitDraftStateNow, scheduleDraftCommit } from '$lib/stores/draft-activity.svelte'
import { reportErrorWithDetails } from '$lib/stores/app-errors.svelte'
import { toast } from 'svelte-sonner'
import {
  deliverTranscriptHeadless,
  sendUnsentComposerContentNow,
  unsentComposerContent,
  voiceScopeTarget
} from './voice-send'
import { logRendererError } from '../system/renderer-logger'
import type {
  SpeechDictationSpan,
  SpeechPlaybackState,
  SpeechScope
} from '../../../lib/speech/types'
import { DEFAULT_SPEECH_SETTINGS } from '../../../lib/speech/types'
import type {
  SpeechEditorApplyResult,
  SpeechEditorSnapshot,
  SpeechEditorTarget
} from './editor-target'
import {
  CAPTURE_STOP_TIMEOUT_MS,
  CAPTURE_TIMESLICE_MS,
  PAUSE_UPLOAD_DEPTH,
  errorMessage,
  recordingToastMessage,
  selectedMimeType,
  type RecordingFailurePhase
} from './speech-controller-capture'
import {
  selectAsrArtifact,
  transcribeCapture,
  type SpeechArtifactSelection
} from './speech-controller-artifacts'
import { playSpeechCue } from './speech-controller-cues'
import { SpeechPlaybackEngine } from './speech-controller-playback.svelte'
import {
  nextVoiceSendLevel,
  selectVoiceSendCandidate,
  stageForLevel
} from './speech-controller-voice-send'
import type {
  ActiveCapture,
  RendererSpeechState,
  VoiceSendIntent,
  VoiceSendStage,
  VoiceTranscriptionRecord
} from './speech-controller-types'

export type { RendererSpeechState, VoiceSendStage } from './speech-controller-types'

class SpeechController {
  state = $state<RendererSpeechState>({ state: 'idle' })

  /**
   * Read-aloud state lives in its own engine; every public playback member
   * below delegates to it so the capture machine here stays independent.
   */
  private readonly playbackEngine = new SpeechPlaybackEngine({
    getSound: () => this.sound,
    loadSettings: () => this.loadSettings(),
    stopRecordingIfNeeded: async () => {
      // TTS and the recorder cannot run together; whoever started last wins.
      if (this.state.state === 'recording') await this.stop()
    },
    claimThreadSlot: (scope) => this.claimThreadSlot(scope)
  })

  get playback(): SpeechPlaybackState {
    return this.playbackEngine.playback
  }

  get activeSegments() {
    return this.playbackEngine.segments
  }

  /** Read-along border visibility: playing, or paused within the linger window. */
  get readingOverlayActive(): boolean {
    return this.playbackEngine.readAlong
  }

  /** Seek slider visibility mirrors the read-along overlay (same linger timer). */
  get seekControlsActive(): boolean {
    return this.playbackEngine.seekControlsActive
  }

  /** Index of the line to highlight while the overlay is up; -1 hides it. */
  get visibleSegmentIndex(): number {
    return this.playbackEngine.visibleSegmentIndex
  }

  get elapsedPlaybackSeconds(): number {
    return this.playbackEngine.elapsedPlaybackSeconds
  }

  get knownPlaybackDurationSeconds(): number {
    return this.playbackEngine.knownPlaybackDurationSeconds
  }

  /**
   * Fraction (0..1) of the active block already spoken, for word-level
   * read-along highlighting.
   */
  get activeSegmentProgress(): number {
    return this.playbackEngine.activeSegmentProgress
  }

  /** Estimated duration of the entire readable block; the slider's full range. */
  get estimatedTotalDurationSeconds(): number {
    return this.playbackEngine.estimatedTotalDurationSeconds
  }

  /** Seconds of audio already generated (filled part of the seek track). */
  get generatedFrontierSeconds(): number {
    return this.playbackEngine.generatedFrontierSeconds
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
  /** Level-2 steers still in flight, keyed by attempt id. A transcript that
   *  lands meanwhile must wait for the box content to leave the composer before
   *  it reads the mirrored draft, or it delivers the same message twice. */
  private readonly pendingSteers = new Map<string, Promise<void>>()
  /**
   * Detached transcriptions whose transcript has not landed yet, with the
   * editor and thread they belong to. Rows, mic buttons and the armed-send
   * shortcut read this to know which dictation is still in flight.
   *
   * Entries are removed by attempt id, never by object identity, which is
   * unreliable here: Svelte 5 deep-proxies $state array elements, so a raw
   * scope object never matches its proxied copy and an identity filter would
   * keep the entry forever.
   */
  private transcribing = $state<VoiceTranscriptionRecord[]>([])
  /** Dictations the user armed to deliver themselves (see `armVoiceSend`). */
  private voiceSends = $state<VoiceSendIntent[]>([])
  private readonly spans = new Map<string, SpeechDictationSpan[]>()
  private stopPromise: Promise<void> | null = null
  private sound = structuredClone(DEFAULT_SPEECH_SETTINGS)
  /** Whether `sound` has been loaded from config at least once. Until then a
   *  `start()` still pays one `config:get`; afterwards the mirror below keeps
   *  it fresh without any disk round trip on the recording hot path. */
  private soundReady = false
  /**
   * Wall-clock time the speech action currently occupying a thread row's single
   * indicator slot began, and the thread it belongs to. Rows arbitrate that slot
   * across speech and computer use by "last action wins", and this controller is
   * the only place that knows when a speech action started. Claimed at each
   * start point (mic opens, mic closes into transcription, playback begins).
   * A stale claim is harmless: rows only read it while one of the
   * `is*Thread` flags is true for that thread.
   */
  private slotClaim = $state<{ threadId: string; at: number } | null>(null)

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.handleGlobalKeydown, true)
      window.addEventListener('cio:soundChanged', this.handleSoundChanged)
      void this.loadSettings()
    }
  }

  private readonly handleSoundChanged = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!detail || typeof detail !== 'object') return
    this.sound = structuredClone(detail as typeof this.sound)
    this.soundReady = true
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      if (this.state.state !== 'recording') return
      if (!this.escapeStopsRecording()) return
      event.preventDefault()
      event.stopPropagation()
      void this.stop()
      return
    }
    if (!this.isVoiceSendShortcut(event)) return
    // A surface above the thread owns the keyboard (a modal, a sheet, a palette,
    // or a full-page Settings/Scope view): its own chord meaning must win, the
    // same way Escape there never reaches the recording behind it.
    if (isEscapeClaimed(event)) return
    if (!this.voiceSendCandidate()) return
    event.preventDefault()
    event.stopPropagation()
    this.armVoiceSend()
  }

  /** Cmd/Ctrl+Shift+Enter, the send chord, re-aimed at a dictation in flight. */
  private isVoiceSendShortcut(event: KeyboardEvent): boolean {
    return (
      event.key === 'Enter' && event.shiftKey && (event.metaKey || event.ctrlKey) && !event.repeat
    )
  }

  /**
   * Escape may end a recording only while the user is viewing the surface that
   * is recording. A thread-scoped capture keeps running when the user navigates
   * to another thread, so Escape pressed there must keep its normal meaning
   * (stop that thread's run, close an overlay) instead of killing a recording
   * happening elsewhere, the user returns to the recording thread to stop it.
   * Recordings without a thread (global overlays like the switcher) stay
   * Escapable from anywhere because their owning surface remains on screen.
   */
  private escapeStopsRecording(): boolean {
    const active = this.active
    if (!active) return false
    // A surface above the recording owns Escape, a full-page surface (a
    // Settings page or the Scope view) covering the shell, or an open modal or
    // palette (spotlight). Escape there closes the surface on top and must
    // never kill a recording happening underneath.
    if (isEscapeClaimed()) return false
    const scope = active.scope
    if (scope.kind === 'global' || scope.threadId === undefined) return true
    // Temporary side chats render a synthetic thread that is never the
    // selected workspace thread, they live in the context sidebar. When a
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
    const viewed = workspaceState.selectedThread
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
   * equivalent editor mounts again, e.g. the user returned to the thread
   * before the transcript landed, the transcript must insert into the visible
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
    if (this.state.state === 'recording' || this.state.state === 'starting')
      return this.active?.scope ?? this.captureScope
    return null
  }

  /** The scope of whichever editor is dictating across every live phase,
   *  starting to recording to stopping. Unlike `recordingScope`
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

  /**
   * When the speech action this thread's row slot is showing began (wall
   * clock), or null when the thread has no speech action in that slot. Callers
   * compare it against computer-use activity to apply the row's last-action-wins
   * rule; a live action with no recorded claim reports 0 so it ranks as oldest.
   */
  threadIndicatorActionAt(threadId: string): number | null {
    const active =
      this.isRecordingThread(threadId) ||
      this.isTranscribingThread(threadId) ||
      this.isSpeakingThread(threadId)
    if (!active) return null
    return this.slotClaim?.threadId === threadId ? this.slotClaim.at : 0
  }

  /** Record that a speech action for this scope just started. */
  private claimThreadSlot(scope: SpeechScope | null | undefined): void {
    if (!scope || scope.kind === 'global' || !scope.threadId) return
    this.slotClaim = { threadId: scope.threadId, at: Date.now() }
  }

  isCapturingThread(threadId: string): boolean {
    const scope = this.capturingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  /** Whether a detached background transcription is still running for this
   *  editor target, the transcript will land in the field when it settles. */
  isTranscribingTarget(targetId: string): boolean {
    return this.transcribing.some((entry) => entry.targetId === targetId)
  }

  /** Whether a background transcription is still running inside this thread,
   *  the mic has closed but the transcript has not landed yet. This spans the
   *  whole post-recording pipeline, from the moment the recorder is stopped
   *  (finalize, upload, ASR selection) through the detached transcription job. */
  isTranscribingThread(threadId: string): boolean {
    const matches = (scope: SpeechScope | null): boolean =>
      scope !== null && scope.kind !== 'global' && scope.threadId === threadId
    if (this.transcribing.some((entry) => matches(entry.scope))) return true
    // The mic has closed but the capture is still finishing, the transcript
    // job has not been registered yet, so the capture scope is the only signal.
    return this.state.state === 'stopping' && matches(this.capturingScope)
  }

  /**
   * Whether the dictation in flight for this editor target can send itself when
   * the transcript lands. False for every editor that is not a message surface
   * (spec fields, comment boxes), where the transcript can only be pasted.
   */
  canAutoSendVoice(targetId: string): boolean {
    return this.transcribing.some((entry) => entry.targetId === targetId && entry.autoSend)
  }

  /** Stage of the armed voice send for an editor target, or null when off. */
  voiceSendStageForTarget(targetId: string): VoiceSendStage | null {
    const intent = this.armedVoiceSend((entry) => entry.targetId === targetId)
    return intent ? stageForLevel(intent.level) : null
  }

  /** Stage of the armed voice send belonging to a thread's row, or null. */
  voiceSendStageForThread(threadId: string): VoiceSendStage | null {
    const intent = this.armedVoiceSend(
      (entry) => entry.scope.kind !== 'global' && entry.scope.threadId === threadId
    )
    return intent ? stageForLevel(intent.level) : null
  }

  /**
   * An armed intent is only meaningful while its transcription is still in
   * flight. Reading through the live transcription list keeps an intent that
   * outlived its delivery invisible instead of leaving an armed icon behind.
   */
  private armedVoiceSend(match: (intent: VoiceSendIntent) => boolean): VoiceSendIntent | null {
    return (
      this.voiceSends.find(
        (intent) =>
          this.transcribing.some((entry) => entry.attemptId === intent.attemptId) && match(intent)
      ) ?? null
    )
  }

  /**
   * Arm, or escalate, the automatic delivery of the transcription in flight.
   *
   * The mic button (double-click) and Cmd/Ctrl+Shift+Enter both land here while
   * a transcript is still being produced, and every press advances one step of
   * a ladder that cycles back to where it started:
   *
   * 1. the transcript is sent when it lands, together with whatever the
   *    composer already held, which waits for it instead of being sent alone;
   * 2. the composer's text is steered into the running turn right now and the
   *    transcript follows as its own message;
   * 3. the transcript itself is steered, interrupting the running turn;
   * 4. the intent is cleared again, so the transcript goes back to being pasted
   *    into its editor (and written to the clipboard) with nothing sent, and
   *    the next press arms a fresh send.
   *
   * Returns false when nothing is armable: a dictation on a plain editor, or
   * no dictation at all, so callers can leave the event to its normal meaning.
   */
  armVoiceSend(options: { targetId?: string } = {}): boolean {
    const record = this.voiceSendCandidate(options.targetId)
    if (!record) return false
    const existing = this.voiceSends.find((entry) => entry.attemptId === record.attemptId)
    // The press after "steer the transcript" ends the ladder instead of
    // escalating it: the intent goes away and the cycle starts over.
    const cleared = existing?.level === 3
    const level = nextVoiceSendLevel(existing?.level, unsentComposerContent(record.scope) !== null)
    this.voiceSends = [
      // Prune intents whose transcription already settled: only the dictation
      // in flight may carry an armed state, and a cleared one is dropped so the
      // transcript keeps only its plain paste behaviour.
      ...this.voiceSends.filter(
        (entry) =>
          entry.attemptId !== record.attemptId &&
          this.transcribing.some((live) => live.attemptId === entry.attemptId)
      ),
      ...(cleared
        ? []
        : [
            {
              attemptId: record.attemptId,
              targetId: record.targetId,
              target: record.target,
              scope: record.scope,
              level
            }
          ])
    ]
    // Arming is a user action on the transcription's thread, so the row's
    // single indicator slot is claimed now, as any other speech action does:
    // the armed state is then the most recent claim, which is what the row's
    // last-action-wins rule compares against computer-use activity.
    this.claimThreadSlot(record.scope)
    // Level 2 hands over what the composer holds at this instant: that text is
    // an instruction for the running turn and must not wait for the transcript.
    // Clearing is never level 2, so this only fires on a fresh ladder step.
    if (level === 2) this.trackPendingSteer(record)
    return true
  }

  /** Hand the composer content to the running turn, remembering the work so a
   *  transcript landing meanwhile waits for it instead of racing it. */
  private trackPendingSteer(record: VoiceTranscriptionRecord): void {
    // Never rejects: the delivery awaits this promise, and a steer that threw
    // must not turn into a transcription failure for the transcript behind it.
    const steering = this.steerPendingComposerContent(record).catch((cause: unknown) => {
      logRendererError('The queued voice message could not be steered.', cause)
    })
    this.pendingSteers.set(record.attemptId, steering)
    void steering.finally(() => {
      if (this.pendingSteers.get(record.attemptId) === steering)
        this.pendingSteers.delete(record.attemptId)
    })
  }

  /** The dictation an arming gesture applies to (see the selector module). */
  private voiceSendCandidate(targetId?: string): VoiceTranscriptionRecord | null {
    const viewed = workspaceState.selectedThread
    return selectVoiceSendCandidate(this.transcribing, this.voiceSends, targetId, viewed)
  }

  /**
   * Steer what a thread's composer already holds. A mounted composer drives its
   * own send path so the steer obeys every gate the send button has; otherwise
   * the mirrored draft is steered headlessly.
   */
  private async steerPendingComposerContent(record: VoiceTranscriptionRecord): Promise<void> {
    const autoSend = record.target.autoSend
    if (autoSend?.isLive()) {
      autoSend.submit(true)
      // A composer that dispatched clears its own buffer. One that refused (an
      // open slash or mention menu, a locked field) left the text in place, so
      // steer it headlessly instead of quietly dropping the intent.
      if (unsentComposerContent(record.scope) === null) return
    }
    await sendUnsentComposerContentNow(record.scope)
  }

  /** Scope of the thread whose response is currently being spoken aloud. */
  get speakingScope(): SpeechScope | null {
    return this.playbackEngine.speakingScope
  }

  isSpeakingThread(threadId: string): boolean {
    const scope = this.speakingScope
    return scope !== null && scope.kind !== 'global' && scope.threadId === threadId
  }

  /** The thread target of a dictation scope, when it dictates into a thread
   *  composer. Global scope and thread-less scopes have no draft surface. */
  private draftTargetFromScope(scope: SpeechScope): { projectId: string; threadId: string } | null {
    return voiceScopeTarget(scope)
  }

  /** Flag the thread as drafting in the DB the moment a capture starts, so a
   *  thread being dictated survives every bounded DB listing (and other
   *  instances see it) even before any transcript lands. */
  private flagCaptureDrafting(scope: SpeechScope): void {
    const target = this.draftTargetFromScope(scope)
    if (!target) return
    scheduleDraftCommit(
      target.projectId,
      target.threadId,
      true,
      rendererRecovery.composerDraftJson(target.projectId, target.threadId)
    )
  }

  /** After a capture fully settles, transcript landed in the composer, or the
   *  pipeline failed/cancelled with nothing inserted, commit the thread's
   *  authoritative draft state so the DB flag never outlives the dictation. */
  private settleCaptureDraft(scope: SpeechScope): void {
    const target = this.draftTargetFromScope(scope)
    if (!target) return
    if (rendererRecovery.hasDraftContent(target.projectId, target.threadId)) {
      scheduleDraftCommit(
        target.projectId,
        target.threadId,
        true,
        rendererRecovery.composerDraftJson(target.projectId, target.threadId)
      )
    } else {
      commitDraftStateNow(target.projectId, target.threadId, false, null)
    }
  }

  async start(
    target: SpeechEditorTarget,
    scope: SpeechScope,
    preparedSnapshot?: SpeechEditorSnapshot | null
  ): Promise<void> {
    if (this.active || !['idle', 'failed'].includes(this.state.state)) return
    // TTS and the recorder cannot run together; whoever started last wins.
    if (this.playbackEngine.hasActivePlayback()) await this.cancelPlayback()
    this.captureScope = scope
    // The mic opening is a new speech action for the thread's row slot.
    this.claimThreadSlot(scope)
    if (!this.soundReady) await this.loadSettings()
    const snapshot = preparedSnapshot ?? target.capture()
    if (!snapshot) {
      this.surfaceFailure(target.id, 'prepare', new Error('Focus the editor before recording.'))
      return
    }
    // Flip the surface to recording immediately: the double-press shortcut and
    // the mic button must respond in the same frame they are pressed. Every
    // async pipeline step below has a failure path that settles into `failed`.
    this.state = { state: 'starting', targetId: target.id }

    const nativeStarted = await invoke('speech:beginNativeCapture', scope).catch(() => null)
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
      this.flagCaptureDrafting(capture.scope)
      playSpeechCue(this.sound, 'started')
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
      this.flagCaptureDrafting(capture.scope)
      playSpeechCue(this.sound, 'started')
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
      this.settleCaptureDraft(scope)
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
    // The mic is closed and the transcript is on its way: that transition is a
    // new speech action for the thread's row slot.
    this.claimThreadSlot(this.capturingScope)
    // Capture the target's current value and caret when the user stops, not
    // only when recording started. This lets users type and reposition the
    // caret while the mic is active without losing the intended insertion point.
    const insertionSnapshot = active.target.capture() ?? active.snapshot
    // The transcript is on its way from this instant, not from the moment ASR
    // answers. Registering the job here is what makes the dictation armable
    // while the capture is still finalising, instead of only afterwards.
    this.beginTranscription(active)

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
      playSpeechCue(this.sound, 'stopped')
      const transcription = this.deliverTranscript(active, insertionSnapshot)
      this.transcriptions.set(active.attemptId, transcription)
      void transcription.finally(() => {
        const current = this.transcriptions.get(active.attemptId)
        if (current === transcription) this.transcriptions.delete(active.attemptId)
      })
    } catch (cause) {
      // No transcript will ever land for this attempt, so its job and any
      // intent armed for it are over before the failure surfaces.
      this.endTranscription(active.attemptId)
      const message = errorMessage(cause)
      await (
        active.native
          ? invoke('speech:failNativeCapture', active.sessionId, message)
          : invoke('speech:failCapture', active.sessionId, message)
      ).catch(() => undefined)
      this.surfaceFailure(active.target.id, 'capture', cause)
      this.settleCaptureDraft(active.scope)
    } finally {
      if (active.stream) for (const track of active.stream.getTracks()) track.stop()
      this.active = null
      if (this.state.state === 'stopping') this.state = { state: 'idle' }
    }
  }

  /** Start tracking a dictation whose transcript has not landed yet. Called the
   *  moment the recorder is told to stop, so a transcript is armable across the
   *  whole post-recording pipeline and not only once ASR has answered. */
  private beginTranscription(active: ActiveCapture): void {
    this.transcribing = [
      ...this.transcribing,
      {
        attemptId: active.attemptId,
        targetId: active.target.id,
        target: active.target,
        scope: structuredClone(active.scope),
        autoSend: active.target.autoSend !== undefined
      }
    ]
  }

  /** Stop tracking a dictation and drop any intent armed for it. */
  private endTranscription(attemptId: string): void {
    this.transcribing = this.transcribing.filter((entry) => entry.attemptId !== attemptId)
    this.voiceSends = this.voiceSends.filter((entry) => entry.attemptId !== attemptId)
    this.pendingSteers.delete(attemptId)
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
    const transcribingScope = structuredClone(active.scope)
    try {
      const transcript = await transcribeCapture(active, this.sound, () => this.selectAsrArtifact())
      await invoke('clipboard:writeText', transcript)
      const inserted = active.target.apply(insertionSnapshot, transcript)
      let applied: SpeechEditorApplyResult = inserted
      if (!applied.ok && active.target.fallbackApply) {
        // Every failed insertion still has a home: the target's store-level
        // fallback appends the transcript to the value it mirrors. That covers a
        // destroyed editor, a field the user kept typing in while the model was
        // transcribing, and a box an armed level-2 steer has already emptied,
        // which is exactly the case an armed transcript has to survive.
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
      playSpeechCue(this.sound, 'completed')
      // Armed dictation: the transcript has landed, so hand it over now. The
      // composer drives its own send path whenever the transcript reached the
      // live editor; otherwise the mirrored draft is delivered headlessly,
      // which is what makes this work from another thread entirely.
      const intent = this.voiceSends.find((entry) => entry.attemptId === active.attemptId)
      if (intent) await this.deliverArmedVoiceSend(intent, inserted.ok)
    } catch (cause) {
      await invoke('speech:markAttemptFailure', active.attemptId, errorMessage(cause)).catch(
        () => undefined
      )
      logRendererError(
        `Voice transcription failed for attempt ${active.attemptId}: ${errorMessage(cause)}`
      )
      try {
        reportErrorWithDetails('Voice transcription failed.', { details: errorMessage(cause) })
      } catch {
        // Toast failures must never break the detached job.
      }
    } finally {
      this.endTranscription(active.attemptId)
      this.settleCaptureDraft(transcribingScope)
    }
  }

  /**
   * Delivery of an armed dictation once its transcript has landed. `landedLive`
   * reports whether the transcript was inserted into the mounted editor: only
   * then may the composer dispatch itself, because its buffer is the only copy
   * that then holds the transcript.
   */
  private async deliverArmedVoiceSend(intent: VoiceSendIntent, landedLive: boolean): Promise<void> {
    // A level-2 steer may still be handing the box content over. The transcript
    // must not be read out of the mirrored draft until that text has left it, or
    // the same message is delivered twice.
    await this.pendingSteers.get(intent.attemptId)
    const direct = intent.level >= 3
    if (landedLive) {
      const autoSend = intent.target.autoSend
      if (autoSend?.isLive()) {
        // The composer's own send path already reports the dictation for
        // correction learning, so this branch is complete on its own.
        autoSend.submit(direct)
        return
      }
    }
    const deliveredText = await deliverTranscriptHeadless(intent.scope, direct)
    // A headless delivery bypasses the composer, which is where a dictation is
    // normally reported for correction learning. Report it here instead, so a
    // voice message sent from another thread teaches the model exactly like one
    // sent by hand.
    if (deliveredText !== null) this.observeSent(intent.targetId, deliveredText)
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
    await this.playbackEngine.togglePlayback(messageId, markdown, scope)
  }

  async cancelPlayback(): Promise<void> {
    await this.playbackEngine.cancelPlayback()
  }

  async seekPlayback(seconds: number): Promise<void> {
    await this.playbackEngine.seekPlayback(seconds)
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

  private selectAsrArtifact(): Promise<SpeechArtifactSelection> {
    return selectAsrArtifact(this.sound, (artifactId) =>
      this.forgetUnavailableAsrSelection(artifactId)
    )
  }

  private forgetUnavailableAsrSelection(artifactId: string): void {
    if (this.sound.asrArtifactId !== artifactId) return
    const nextSound = { ...this.sound, asrArtifactId: undefined }
    this.sound = nextSound
    void invoke('config:update', { sound: nextSound }).catch((cause: unknown) => {
      logRendererError('Could not clear the unavailable speech-to-text model selection.', cause)
    })
  }

  private async loadSettings(): Promise<void> {
    try {
      const config = await invoke('config:get')
      this.sound = structuredClone(config.sound)
    } catch {
      this.sound = structuredClone(DEFAULT_SPEECH_SETTINGS)
    } finally {
      this.soundReady = true
    }
  }
}

export const speechController = new SpeechController()
