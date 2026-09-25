import { invoke } from '$lib/ipc.svelte'
import type {
  SpeechPlaybackState,
  SpeechScope,
  SpeechSegment,
  SpeechSettings,
  SpeechSynthesizedSegment
} from '../../../lib/speech/types'
import { logRendererError } from '../system/renderer-logger'
import { pauseCurrentHistoryAudio } from './global-audio'
import { selectTtsArtifact } from './speech-controller-artifacts'
import { errorMessage } from './speech-controller-capture'
import {
  estimatedTotalSeconds as computeEstimatedTotal,
  generatedFrontierSeconds as computeGeneratedFrontier,
  locatePlaybackPosition,
  segmentProgress as computeSegmentProgress,
  segmentSeconds
} from './speech-controller-playback'
import type { ActivePlayback } from './speech-controller-types'

// Text-to-speech normally starts playing within seconds. If the pipeline wedges
// before the first audio sample, settle the UI into a retryable failure instead
// of spinning forever.
const PLAYBACK_STALL_WATCHDOG_MS = 60_000
// After pausing, keep the read-along border and seek controls on screen for a
// few seconds so users can resume without losing their place. Then fade out.
const PAUSED_LINGER_MS = 5_000

/** Owner-side hooks the playback engine needs but does not own. */
export interface SpeechPlaybackHost {
  getSound(): SpeechSettings
  loadSettings(): Promise<void>
  /** Stop an active recording so TTS and capture never run together. */
  stopRecordingIfNeeded(): Promise<void>
  claimThreadSlot(scope: SpeechScope | null | undefined): void
}

/**
 * Owns every read-aloud rune and the segment-by-segment playback state machine.
 * The controller delegates its public playback getters and operations here, so
 * the capture state machine and this one stay independent.
 */
export class SpeechPlaybackEngine {
  constructor(private readonly host: SpeechPlaybackHost) {}

  playback = $state<SpeechPlaybackState>({ state: 'idle' })

  private activePlayback: ActivePlayback | null = null
  // Reactive mirror consumed by the per-line TTS highlight rendering. Kept
  // separate from activePlayback because storing the live playback record
  // (promises, media elements) behind a $state proxy would break the raw-local
  // identity checks that guard every step of segment playback.
  private currentSegments = $state<SpeechSegment[] | null>(null)
  private readAlongVisible = $state(false)
  private elapsedSeconds = $state(0)
  private knownDurationSeconds = $state(0)
  /** Where the spoken response lives, for row-level "Speaking" indicators. */
  private playbackScope = $state<SpeechScope | null>(null)
  private playbackStallWatchdog: ReturnType<typeof setTimeout> | null = null
  private playbackStallMessageId: string | null = null
  private pausedLingerTimer: ReturnType<typeof setTimeout> | null = null

  get segments(): SpeechSegment[] | null {
    return this.currentSegments
  }

  /** Read-along border visibility: playing, or paused within the linger window. */
  get readAlong(): boolean {
    return this.readAlongVisible
  }

  /** Playhead position in seconds across all retained (played) segments. */
  get elapsedPlaybackSeconds(): number {
    return this.elapsedSeconds
  }

  /** Sum of known media durations; grows as segment metadata loads. */
  get knownPlaybackDurationSeconds(): number {
    return this.knownDurationSeconds
  }

  /** Whether a segment session is currently preparing, playing, or paused. */
  hasActivePlayback(): boolean {
    const state = this.playback
    return 'messageId' in state && ['preparing', 'playing', 'paused'].includes(state.state)
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

  /**
   * Fraction (0..1) of the active block already spoken, for word-level
   * read-along highlighting. Reactive through the `elapsedSeconds` mirror,
   * which the segment audio's timeupdate events refresh several times a
   * second, plenty for advancing a whole-word highlight.
   */
  get activeSegmentProgress(): number {
    const current = this.playback
    if (!('segmentIndex' in current) || (current.state !== 'playing' && current.state !== 'paused'))
      return 0
    const playback = this.activePlayback
    if (!playback) return 0
    return computeSegmentProgress(playback, current.segmentIndex, this.elapsedSeconds)
  }

  /** Estimated duration of the entire readable block; the slider's full range. */
  get estimatedTotalDurationSeconds(): number {
    const playback = this.activePlayback
    if (!playback) return 0
    return computeEstimatedTotal(playback)
  }

  /** Seconds of audio already generated (filled part of the seek track). */
  get generatedFrontierSeconds(): number {
    const playback = this.activePlayback
    if (!playback) return 0
    return computeGeneratedFrontier(playback)
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

  async togglePlayback(messageId: string, markdown: string, scope?: SpeechScope): Promise<void> {
    // TTS and the recorder cannot run together; whoever started last wins.
    await this.host.stopRecordingIfNeeded()
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
    await this.host.loadSettings()
    this.playback = { state: 'preparing', sessionId: 'pending', messageId }
    this.armPlaybackStallWatchdog(messageId)
    try {
      const sound = this.host.getSound()
      const selection = await selectTtsArtifact(sound)
      const prepared = await invoke(
        'speech:preparePlayback',
        messageId,
        markdown,
        sound.includeCodeBlocksInSpeech
      )
      if (!prepared.ok) throw new Error(prepared.error.message)
      const playback: ActivePlayback = {
        prepared: prepared.value,
        runtime: selection.runtime,
        artifact: selection.artifact,
        voiceId: sound.ttsVoiceId ?? selection.artifact.voices[0] ?? '0',
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
      // Playback beginning is a new speech action for the thread's row slot.
      this.host.claimThreadSlot(this.playbackScope)
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
          'Text-to-speech did not start within 60 seconds. Playback was stopped. Click speak to retry.',
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
   * Plays, or positions, a segment's retained audio, constructing the element
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
   * session, reading skips it and continues. Three consecutive failures mean
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
    for (let i = 0; i < playback.index; i += 1) prefix += segmentSeconds(playback, i)
    const current = playback.audio?.currentTime ?? 0
    this.elapsedSeconds = prefix + current
    this.knownDurationSeconds = computeGeneratedFrontier(playback)
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
    const { index, offset } = locatePlaybackPosition(playback, Math.max(0, seconds))
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
}
