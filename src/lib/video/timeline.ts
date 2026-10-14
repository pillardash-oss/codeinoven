/**
 * The timeline a composition draws itself as.
 *
 * A composition is code, so there is nothing to drag: the arrangement the user
 * reads is derived from what the composition already declares, not stored
 * separately. This module turns the manifest and the studio document into the
 * bands, ticks and lanes a timeline draws, and it holds no state of its own so
 * the board, the note descriptor and the tests all read the same numbers.
 */
import type { VideoProjectManifest } from './project'
import type { VideoAudioTrack, VideoCaption, VideoStudioDocument } from './studio'

/** Longest timecode this app prints, so a caller can size a column for it. */
export const VIDEO_TIMECODE_LENGTH = 10

/** Seconds as `M:SS.mmm`, the resolution of a frame address. */
export function videoTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  // Round to the millisecond first, then split. Splitting before the rounding
  // would carry 59.9996 into `0:60.000`, and the same moment is also printed as
  // `seconds: 60.000`, so the two lines of one descriptor would disagree.
  const totalMs = Math.round(safe * 1000)
  const minutes = Math.floor(totalMs / 60_000)
  const restMs = totalMs - minutes * 60_000
  const wholeSeconds = Math.floor(restMs / 1000)
  const millis = restMs - wholeSeconds * 1000
  return `${minutes}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Seconds as `M:SS.d`, the coarser form a ruler tick is labelled with. */
export function videoClockLabel(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${Math.floor(rest).toString().padStart(2, '0')}`
}

/** A finite second count inside a range, or the fallback when none is given. */
export function videoBoundedSeconds(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(Math.max(numeric, min), max)
}

/** The frame a second lands on, at a composition's own rate. */
export function videoFrameAt(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(fps) || fps <= 0) return 0
  return Math.max(0, Math.round(seconds * fps))
}

/** Slices along the ruler, one per tick, with the label each one carries. */
export interface VideoTimelineTick {
  seconds: number
  label: string
  /** Fraction of the whole composition, 0..1, so a caller places it without math. */
  fraction: number
}

/**
 * Ruler ticks for a composition.
 *
 * The step is picked from the duration rather than passed in: a ten minute film
 * and a ten second sting both want roughly eight readable ticks, and a fixed
 * step would make one of them either empty or unreadable. The steps stay on the
 * familiar 1/2/5/10/15/30 minute ladder so a label lands on a round time.
 */
export function videoTimelineTicks(duration: number, target = 8): VideoTimelineTick[] {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 0
  if (total === 0) return []
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const wanted = total / Math.max(1, target)
  const step = steps.find((candidate) => candidate >= wanted) ?? steps[steps.length - 1]
  const ticks: VideoTimelineTick[] = []
  for (let seconds = 0; seconds <= total + 1e-6; seconds += step) {
    ticks.push({
      seconds,
      label: videoClockLabel(seconds),
      fraction: seconds / total
    })
  }
  return ticks
}

/** One audio band on the timeline: a track placed at its own offset. */
export interface VideoTimelineAudioLane {
  /** Stable key: the file plus where it starts, so two tracks of one file differ. */
  key: string
  /** Project-relative file the composition folder resolves. */
  source: string
  /** What the lane is called, taken from the file name. */
  label: string
  start: number
  trim: number
  duration: number
  gain: number
}

/** One spoken band: a caption placed at its own time. */
export interface VideoTimelineCaptionBand {
  key: string
  text: string
  start: number
  end: number
}

/** The audio bands a composition plays, from its tracks or, failing those, its manifest. */
export function videoAudioLanes(
  document: VideoStudioDocument | null,
  manifest: VideoProjectManifest | null
): VideoTimelineAudioLane[] {
  const tracks: VideoAudioTrack[] = document?.audioTracks.length
    ? document.audioTracks
    : (manifest?.audio ?? []).map((source) => ({
        source,
        start: 0,
        trim: 0,
        duration: manifest?.duration ?? 0,
        gain: 1
      }))
  return tracks.map((track, index) => ({
    key: `${index}:${track.source}:${track.start}`,
    source: track.source,
    label: track.source.split('/').pop() ?? track.source,
    start: track.start,
    trim: track.trim,
    duration: track.duration,
    gain: track.gain
  }))
}

/** The caption bands a composition draws, in the order it plays them. */
export function videoCaptionBands(
  document: VideoStudioDocument | null
): VideoTimelineCaptionBand[] {
  return (document?.captions ?? []).map((caption: VideoCaption, index) => ({
    key: `${index}:${caption.start}:${caption.end}`,
    text: caption.text,
    start: caption.start,
    end: caption.end
  }))
}

/** The caption the composition is showing at a second, if it is inside one. */
export function videoCaptionAt(
  document: VideoStudioDocument | null,
  seconds: number
): VideoCaption | null {
  for (const caption of document?.captions ?? []) {
    if (seconds >= caption.start && seconds <= caption.end) return caption
  }
  return null
}

/** A lane's placement as fractions of the composition, so a caller needs no math. */
export function videoBandGeometry(
  start: number,
  end: number,
  duration: number
): { left: string; width: string } {
  const total = Number.isFinite(duration) && duration > 0 ? duration : 1
  const clampedStart = Math.min(Math.max(start / total, 0), 1)
  const clampedEnd = Math.min(Math.max(end / total, clampedStart), 1)
  return {
    left: `${clampedStart * 100}%`,
    width: `${Math.max((clampedEnd - clampedStart) * 100, 0.2)}%`
  }
}
