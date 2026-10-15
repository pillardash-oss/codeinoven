import type { SpeechSettings } from '../../../lib/speech/types'
import { logRendererError } from '../system/renderer-logger'
import { errorMessage } from './speech-controller-capture'

export type SpeechCueKind = 'started' | 'stopped' | 'completed'

/**
 * One output context for every cue, shared by the whole session.
 *
 * Each cue used to build its own `AudioContext` and close it once the blip
 * ended. Every `AudioContext` opens its own output stream against the operating
 * system, so a single dictation produced three open/close cycles - one of them
 * (`started`) landing exactly while the microphone input stream was being
 * captured, and another (`completed`) while the app was still finalizing the
 * recording. That churn is what the audio service reports as
 * "The AudioContext encountered an error from the audio device or the WebAudio
 * renderer" and "MixableOutputStream: Error during independent playback", and
 * on macOS it takes the capture device down with it, which is why recordings
 * died with "Microphone access was revoked or the device was disconnected" and
 * why later cues went silent.
 *
 * A single long-lived context holds one output stream for the entire session:
 * no device churn, no ceiling on how many cues have played, and no per-cue
 * teardown. A context the platform suspends (autoplay policy, an output device
 * switch, or the microphone taking voice processing) is resumed instead of
 * being replaced; a context that is genuinely closed is rebuilt on the next
 * cue. The context is opened when a session starts and released once the
 * session has been idle past `CUE_RELEASE_IDLE_MS`, so no output stream is held
 * from app boot.
 */
let cueContext: AudioContext | null = null
let cueReleaseTimer: ReturnType<typeof setTimeout> | null = null

/**
 * How long the shared cue context is kept after a session ends before its
 * output stream is released.
 *
 * The window has to outlast the cue that fires at the end of a dictation plus
 * the transcription latency after it: `stopped` plays when the mic closes, but
 * `completed` can land many seconds later once the model answers, and closing
 * on the earlier cue would cut that final blip off. A minute covers a slow
 * transcription while still releasing the device soon after a session is
 * genuinely over.
 */
const CUE_RELEASE_IDLE_MS = 60_000

/** Cancel a scheduled release, because a cue or a new session still needs the
 *  context. */
function cancelCueRelease(): void {
  if (cueReleaseTimer) clearTimeout(cueReleaseTimer)
  cueReleaseTimer = null
}

/** Close the shared context and forget it, so the next session rebuilds it.
 *  Never throws: a close failure only means the platform already took the
 *  output stream away. */
function releaseCueContext(): void {
  cueReleaseTimer = null
  const context = cueContext
  cueContext = null
  if (!context) return
  void context.close().catch((cause: unknown) => {
    logRendererError(
      `The speech cue audio output could not be closed: ${errorMessage(cause)}`,
      cause
    )
  })
}

/** The context currently backing cue playback, or null when Web Audio is
 *  unavailable in this environment. Rebuilds a context that has been closed. */
function cueAudioContext(): AudioContext | null {
  if (cueContext && cueContext.state !== 'closed') return cueContext
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
    cueContext = null
    return null
  }
  try {
    cueContext = new window.AudioContext()
  } catch (cause) {
    cueContext = null
    logRendererError(
      `The speech cue audio output could not be opened: ${errorMessage(cause)}`,
      cause
    )
  }
  return cueContext
}

/**
 * Open the shared cue context at the start of a speech session.
 *
 * The context is opened here, before any capture IPC runs, so the output stream
 * is already established when the microphone comes up and opening the mic is
 * never accompanied by the audio device being opened underneath it - the exact
 * ordering that broke capture. Safe to call more than once.
 */
export function prepareSpeechCues(): void {
  // A session is starting: a release armed by the previous one must not close
  // the context underneath this one.
  cancelCueRelease()
  const context = cueAudioContext()
  if (!context || context.state === 'running') return
  // A context that cannot be resumed yet (no user gesture has happened) stays
  // suspended and every cue resumes it on demand, so this is best effort.
  void context.resume().catch(() => undefined)
}

/**
 * Mark the speech session as over, so its output stream can be released.
 *
 * The close is delayed by `CUE_RELEASE_IDLE_MS` instead of happening now: the
 * final cue of the session, and the transcription that produces it, may still
 * be in flight, and a later cue or a new session cancels the release. Only a
 * session that stays quiet for that whole window really closes its device.
 */
export function endSpeechCues(): void {
  cancelCueRelease()
  cueReleaseTimer = setTimeout(releaseCueContext, CUE_RELEASE_IDLE_MS)
}

/** Play the short blip that marks a capture or delivery milestone. */
export function playSpeechCue(sound: SpeechSettings, kind: SpeechCueKind): void {
  const enabled =
    kind === 'started'
      ? sound.cues.listeningStarted
      : kind === 'stopped'
        ? sound.cues.recordingStopped
        : sound.cues.transcriptReady
  if (!enabled || sound.cues.volume === 0) return
  // A cue arriving inside the idle window means the session is not over after
  // all: cancel the pending release so this blip, and the one after it, are
  // never cut off by a close that was already scheduled.
  cancelCueRelease()
  const context = cueAudioContext()
  if (!context) return
  if (context.state !== 'running') {
    // A suspended or interrupted context does not advance its clock, so the
    // blip is scheduled relative to `currentTime` and plays as soon as the
    // resume lands. Failing to resume is logged, never thrown: a silent cue
    // must not disturb the recording pipeline that asked for it.
    void context.resume().catch((cause: unknown) => {
      logRendererError(
        `The speech cue audio output could not resume: ${errorMessage(cause)}`,
        cause
      )
    })
  }
  try {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const frequency = kind === 'started' ? 520 : kind === 'stopped' ? 360 : 700
    oscillator.frequency.setValueAtTime(frequency, context.currentTime)
    // Loud enough to stay audible over a low system volume: the peak rides
    // close to full scale (0.5 x user volume) instead of the near-inaudible
    // 0.06 it used to be, and the slightly longer envelope keeps the blip
    // from reading as a click at high pitch.
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, 0.5 * sound.cues.volume),
      context.currentTime + 0.012
    )
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.13)
    // Only this blip's own nodes are released. The context itself stays open
    // for the next cue, which is what keeps the output device stable.
    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect()
        gain.disconnect()
      },
      { once: true }
    )
  } catch (cause) {
    logRendererError(`Voice recording ${kind} cue failed: ${errorMessage(cause)}`, cause)
  }
}
