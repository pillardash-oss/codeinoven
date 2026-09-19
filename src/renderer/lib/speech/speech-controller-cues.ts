import type { SpeechSettings } from '../../../lib/speech/types'
import { logRendererError } from '../system/renderer-logger'
import { errorMessage } from './speech-controller-capture'

export type SpeechCueKind = 'started' | 'stopped' | 'completed'

/** Play the short blip that marks a capture or delivery milestone. */
export function playSpeechCue(sound: SpeechSettings, kind: SpeechCueKind): void {
  const enabled =
    kind === 'started'
      ? sound.cues.listeningStarted
      : kind === 'stopped'
        ? sound.cues.recordingStopped
        : sound.cues.transcriptReady
  if (!enabled || sound.cues.volume === 0) return
  const AudioContextConstructor = window.AudioContext
  if (typeof AudioContextConstructor !== 'function') return
  try {
    const context = new AudioContextConstructor()
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
    oscillator.addEventListener('ended', () => void context.close(), { once: true })
  } catch (cause) {
    logRendererError(`Voice recording ${kind} cue failed: ${errorMessage(cause)}`, cause)
  }
}
