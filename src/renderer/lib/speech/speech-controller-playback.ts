import type { ActivePlayback } from './speech-controller-types'

/**
 * Fallback reading rate used when no segment has published a media duration
 * yet: characters per second, calibrated against the audio already heard.
 */
const FALLBACK_CHARS_PER_SECOND = 12

/**
 * Duration of one segment: real media length once known, otherwise a
 * characters-per-second estimate calibrated against the audio already heard.
 */
export function segmentSeconds(playback: ActivePlayback, index: number): number {
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
  return text.length / FALLBACK_CHARS_PER_SECOND
}

/** Maps a slider position onto (segment, offset) across the whole block. */
export function locatePlaybackPosition(
  playback: ActivePlayback,
  seconds: number
): { index: number; offset: number } {
  let remaining = seconds
  const lastIndex = playback.prepared.segments.length - 1
  for (let i = 0; i <= lastIndex; i += 1) {
    const span = segmentSeconds(playback, i)
    if (remaining <= span || i === lastIndex) return { index: i, offset: Math.max(0, remaining) }
    remaining -= span
  }
  return { index: -1, offset: 0 }
}

/** Estimated duration of the entire readable block; the slider's full range. */
export function estimatedTotalSeconds(playback: ActivePlayback): number {
  let total = 0
  for (let i = 0; i < playback.prepared.segments.length; i += 1)
    total += segmentSeconds(playback, i)
  return total
}

/** Seconds of audio already generated (filled part of the seek track). */
export function generatedFrontierSeconds(playback: ActivePlayback): number {
  let total = 0
  for (let i = 0; i < playback.retainedUrls.length; i += 1) {
    if (!playback.retainedUrls[i]) continue
    total += segmentSeconds(playback, i)
  }
  return total
}

/**
 * Fraction (0..1) of the block at `index` already spoken, for word-level
 * read-along highlighting.
 */
export function segmentProgress(
  playback: ActivePlayback,
  index: number,
  elapsedSeconds: number
): number {
  let prefix = 0
  for (let i = 0; i < index; i += 1) prefix += segmentSeconds(playback, i)
  const span = segmentSeconds(playback, index)
  if (!(span > 0)) return 0
  const within = elapsedSeconds - prefix
  return Math.min(1, Math.max(0, within / span))
}
