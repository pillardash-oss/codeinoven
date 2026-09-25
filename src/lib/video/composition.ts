/**
 * The composition document: what an agent writes to describe a video, as pure
 * functions.
 *
 * The document is data rather than code on purpose. A video is compiled into a
 * single ffmpeg invocation, and ffmpeg's inputs and filter graph are a flat,
 * ordered description, so a timeline is a better fit than a program: it is
 * diffable, it can be validated before a render is started, and a bad field is
 * a message rather than a crash half way through an export.
 *
 * Everything here is checked before the renderer is handed anything, so the
 * renderer never has to guess and an agent gets one readable sentence per
 * problem instead of an ffmpeg stack trace.
 */

/** Version of the document this module reads. A future shape bumps this. */
export const VIDEO_COMPOSITION_VERSION = 1

/** Ceilings, so a hand-written document cannot turn one render into a hundred inputs. */
export const MAX_VIDEO_CLIPS = 200
export const MAX_VIDEO_TEXT_LAYERS = 100
export const MAX_VIDEO_AUDIO_TRACKS = 24

/** Ceilings on one field, so a bad document cannot inflate a process argument. */
export const MAX_VIDEO_SOURCE_LENGTH = 1_024
export const MAX_VIDEO_TEXT_LENGTH = 4_000
export const MAX_VIDEO_SOURCE_SECONDS = 24 * 60 * 60

/** Output limits. ffmpeg handles more, but a composition is a short-form medium. */
export const MIN_VIDEO_DIMENSION = 16
export const MAX_VIDEO_DIMENSION = 7_680
export const MIN_VIDEO_FPS = 1
export const MAX_VIDEO_FPS = 120

/** The frame sizes a composition may name, which is what settings would offer. */
export const VIDEO_FRAME_PRESETS: readonly {
  readonly label: string
  readonly width: number
  readonly height: number
}[] = [
  { label: 'Landscape 1080p', width: 1920, height: 1080 },
  { label: 'Portrait 1080p', width: 1080, height: 1920 },
  { label: 'Square 1080p', width: 1080, height: 1080 },
  { label: 'Landscape 720p', width: 1280, height: 720 },
  { label: 'Portrait 720p', width: 720, height: 1280 }
]

/**
 * How a clip joins the clip before it.
 *
 * The names are ffmpeg's `xfade` transitions, kept to the ones that read as an
 * edit rather than an effect. A transition needs both clips to overlap, so its
 * duration is taken off the reel's total.
 */
export const VIDEO_TRANSITIONS: readonly string[] = [
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'circleopen',
  'circleclose',
  'radial',
  'pixelize',
  'hblur',
  'smoothleft',
  'smoothright'
]

export interface VideoTransition {
  /** One of `VIDEO_TRANSITIONS`. */
  type: string
  /** Seconds of overlap. Defaults to 0.5. */
  duration?: number
}

/** Whether a clip fills the frame, or fits inside it against the composition background. */
export type VideoClipFit = 'cover' | 'contain'

export interface VideoClip {
  /** Stable id, so a render and its reply can name the clip. */
  id: string
  kind: 'video' | 'image'
  /** Project-relative path, or an https URL. */
  source: string
  /** Seconds into the source where this clip begins. Video only. */
  sourceIn?: number
  /** How long the clip runs on the timeline. */
  duration: number
  /** Defaults to cover, which fills the frame and crops what overflows. */
  fit?: VideoClipFit
  /** Colour behind a contained clip. Defaults to the composition background. */
  fill?: string
  /** Whether the clip's own sound is used. Defaults to true for video, false for an image. */
  audio?: boolean
  /** Level of the clip's own sound, 1 being unchanged. */
  volume?: number
  /**
   * How this clip joins the one before it. Ignored on the first clip, which has
   * nothing to join.
   */
  transition?: VideoTransition
}

/** One line of text drawn over the reel for a window of the timeline. */
export interface VideoTextLayer {
  id: string
  text: string
  /** Seconds on the timeline where the text appears. */
  start: number
  /** Seconds on the timeline where the text leaves. */
  end: number
  /** Where the text sits, 0 to 1 across the frame. 0.5, 0.85 is a lower third. */
  position?: { x: number; y: number }
  /** Text size in pixels at the composition's own height. Defaults to 48. */
  fontSize?: number
  /** `#rrggbb`. Defaults to white. */
  color?: string
  /** Melt in and out over this many seconds. Defaults to none. */
  fade?: number
  /** A box behind the text, so it stays legible over footage. */
  background?: { color: string; opacity?: number; padding?: number }
}

/** One sound running under the reel. */
export interface VideoAudioTrack {
  id: string
  /** Project-relative path, or an https URL. */
  source: string
  /** Seconds on the timeline where the sound starts. Defaults to 0. */
  start?: number
  /** Seconds into the source to begin at. Defaults to 0. */
  sourceIn?: number
  /** How long the track runs. Defaults to whatever the source holds. */
  duration?: number
  /** Level, 1 being unchanged. */
  volume?: number
  /** Melt in over this many seconds. */
  fadeIn?: number
  /** Melt out over this many seconds, ending where the track ends. */
  fadeOut?: number
}

export interface VideoComposition {
  version: number
  width: number
  height: number
  fps: number
  /** `#rrggbb` behind every clip. Defaults to black. */
  background: string
  clips: VideoClip[]
  text: VideoTextLayer[]
  audio: VideoAudioTrack[]
}

const HEX_COLOUR_PATTERN = /^#[0-9a-f]{6}$/iu
const COMPOSITION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,60}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new TypeError(message)
}

function boundedString(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const trimmed = value.trim()
  if (!allowEmpty && trimmed.length === 0) fail(`${label} must not be empty`)
  if (trimmed.length > maximum) fail(`${label} must be at most ${maximum} characters`)
  return trimmed
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be a number`)
  if (value < minimum || value > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function optionalNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined
  return finiteNumber(value, label, minimum, maximum)
}

function proportion(value: unknown, label: string): number {
  return finiteNumber(value, label, 0, 1)
}

function colour(value: unknown, label: string, fallback?: string): string {
  if (value === undefined) {
    if (fallback !== undefined) return fallback
    fail(`${label} must be a #rrggbb colour`)
  }
  if (typeof value !== 'string' || !HEX_COLOUR_PATTERN.test(value.trim())) {
    fail(`${label} must be a #rrggbb colour`)
  }
  return value.trim().toLowerCase()
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${label} must be true or false`)
  return value
}

function compositionId(value: unknown, label: string, seen: Set<string>): string {
  const id = boundedString(value, label, 61)
  if (!COMPOSITION_ID_PATTERN.test(id)) {
    fail(`${label} must be lowercase letters, digits and hyphens, starting with a letter or digit`)
  }
  if (seen.has(id)) fail(`${label} must be unique, and "${id}" is used twice`)
  seen.add(id)
  return id
}

function readArray(value: unknown, label: string, maximum: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail(`${label} must be a list`)
  if (value.length > maximum) fail(`${label} must hold at most ${maximum} entries`)
  return value
}

function readClip(raw: unknown, index: number, seen: Set<string>): VideoClip {
  const label = `clips[${index}]`
  if (!isRecord(raw)) fail(`${label} must be an object`)
  const kind = raw['kind']
  if (kind !== 'video' && kind !== 'image') fail(`${label}.kind must be "video" or "image"`)
  const fit = raw['fit']
  if (fit !== undefined && fit !== 'cover' && fit !== 'contain') {
    fail(`${label}.fit must be "cover" or "contain"`)
  }
  const duration = finiteNumber(
    raw['duration'],
    `${label}.duration`,
    0.05,
    MAX_VIDEO_SOURCE_SECONDS
  )
  const sourceIn = optionalNumber(raw['sourceIn'], `${label}.sourceIn`, 0, MAX_VIDEO_SOURCE_SECONDS)
  if (sourceIn !== undefined && kind === 'image') {
    fail(`${label}.sourceIn does not apply to an image, which has no timeline of its own`)
  }
  return {
    id: compositionId(raw['id'], `${label}.id`, seen),
    kind,
    source: boundedString(raw['source'], `${label}.source`, MAX_VIDEO_SOURCE_LENGTH),
    duration,
    ...(sourceIn !== undefined ? { sourceIn } : {}),
    ...(fit !== undefined ? { fit } : {}),
    ...(raw['fill'] !== undefined ? { fill: colour(raw['fill'], `${label}.fill`) } : {}),
    ...(raw['audio'] !== undefined
      ? { audio: optionalBoolean(raw['audio'], `${label}.audio`) }
      : {}),
    ...(raw['volume'] !== undefined
      ? { volume: optionalNumber(raw['volume'], `${label}.volume`, 0, 8) }
      : {}),
    ...(raw['transition'] !== undefined
      ? { transition: readTransition(raw['transition'], `${label}.transition`) }
      : {})
  }
}

function readTransition(raw: unknown, label: string): VideoTransition {
  if (!isRecord(raw)) fail(`${label} must be an object`)
  const type = boundedString(raw['type'], `${label}.type`, 32)
  if (!VIDEO_TRANSITIONS.includes(type)) {
    fail(`${label}.type must be one of ${VIDEO_TRANSITIONS.join(', ')}`)
  }
  const duration = optionalNumber(raw['duration'], `${label}.duration`, 0.05, 10)
  return { type, ...(duration !== undefined ? { duration } : {}) }
}

function readTextLayer(raw: unknown, index: number, seen: Set<string>): VideoTextLayer {
  const label = `text[${index}]`
  if (!isRecord(raw)) fail(`${label} must be an object`)
  const text = boundedString(raw['text'], `${label}.text`, MAX_VIDEO_TEXT_LENGTH, true)
  if (text.length === 0) fail(`${label}.text must not be empty`)
  const start = finiteNumber(raw['start'], `${label}.start`, 0, MAX_VIDEO_SOURCE_SECONDS)
  const end = finiteNumber(raw['end'], `${label}.end`, 0, MAX_VIDEO_SOURCE_SECONDS)
  if (end <= start) fail(`${label}.end must be later than ${label}.start`)
  const background = raw['background']
  let resolvedBackground: VideoTextLayer['background']
  if (background !== undefined) {
    if (!isRecord(background)) fail(`${label}.background must be an object`)
    resolvedBackground = {
      color: colour(background['color'], `${label}.background.color`),
      ...(background['opacity'] !== undefined
        ? { opacity: proportion(background['opacity'], `${label}.background.opacity`) }
        : {}),
      ...(background['padding'] !== undefined
        ? {
            padding: optionalNumber(background['padding'], `${label}.background.padding`, 0, 400)
          }
        : {})
    }
  }
  let position: VideoTextLayer['position']
  if (raw['position'] !== undefined) {
    if (!isRecord(raw['position'])) fail(`${label}.position must be an object`)
    position = {
      x: proportion(raw['position']['x'], `${label}.position.x`),
      y: proportion(raw['position']['y'], `${label}.position.y`)
    }
  }
  return {
    id: compositionId(raw['id'], `${label}.id`, seen),
    text,
    start,
    end,
    ...(position !== undefined ? { position } : {}),
    ...(raw['fontSize'] !== undefined
      ? { fontSize: finiteNumber(raw['fontSize'], `${label}.fontSize`, 6, 1_000) }
      : {}),
    ...(raw['color'] !== undefined ? { color: colour(raw['color'], `${label}.color`) } : {}),
    ...(raw['fade'] !== undefined
      ? { fade: optionalNumber(raw['fade'], `${label}.fade`, 0, 10) }
      : {}),
    ...(resolvedBackground !== undefined ? { background: resolvedBackground } : {})
  }
}

function readAudioTrack(raw: unknown, index: number, seen: Set<string>): VideoAudioTrack {
  const label = `audio[${index}]`
  if (!isRecord(raw)) fail(`${label} must be an object`)
  return {
    id: compositionId(raw['id'], `${label}.id`, seen),
    source: boundedString(raw['source'], `${label}.source`, MAX_VIDEO_SOURCE_LENGTH),
    ...(raw['start'] !== undefined
      ? { start: optionalNumber(raw['start'], `${label}.start`, 0, MAX_VIDEO_SOURCE_SECONDS) }
      : {}),
    ...(raw['sourceIn'] !== undefined
      ? {
          sourceIn: optionalNumber(
            raw['sourceIn'],
            `${label}.sourceIn`,
            0,
            MAX_VIDEO_SOURCE_SECONDS
          )
        }
      : {}),
    ...(raw['duration'] !== undefined
      ? {
          duration: optionalNumber(
            raw['duration'],
            `${label}.duration`,
            0.05,
            MAX_VIDEO_SOURCE_SECONDS
          )
        }
      : {}),
    ...(raw['volume'] !== undefined
      ? { volume: optionalNumber(raw['volume'], `${label}.volume`, 0, 8) }
      : {}),
    ...(raw['fadeIn'] !== undefined
      ? { fadeIn: optionalNumber(raw['fadeIn'], `${label}.fadeIn`, 0, 60) }
      : {}),
    ...(raw['fadeOut'] !== undefined
      ? { fadeOut: optionalNumber(raw['fadeOut'], `${label}.fadeOut`, 0, 60) }
      : {})
  }
}

/**
 * Read a composition, or refuse it with one sentence naming the field at fault.
 *
 * Every message is written to be read by the model that wrote the document, so
 * it names the exact path it rejected rather than the field it happened to be
 * checking.
 */
export function describeVideoComposition(value: unknown): VideoComposition {
  if (!isRecord(value)) fail('A video composition must be an object')
  const version = value['version']
  if (version !== VIDEO_COMPOSITION_VERSION) {
    fail(`version must be ${VIDEO_COMPOSITION_VERSION}, the only version this app reads`)
  }
  const width = finiteNumber(value['width'], 'width', MIN_VIDEO_DIMENSION, MAX_VIDEO_DIMENSION)
  const height = finiteNumber(value['height'], 'height', MIN_VIDEO_DIMENSION, MAX_VIDEO_DIMENSION)
  if (width % 2 !== 0 || height % 2 !== 0) {
    fail('width and height must both be even, which every video codec requires')
  }
  const fps = finiteNumber(value['fps'], 'fps', MIN_VIDEO_FPS, MAX_VIDEO_FPS)
  const background = colour(value['background'], 'background', '#000000')

  const clipIds = new Set<string>()
  const clips = readArray(value['clips'], 'clips', MAX_VIDEO_CLIPS).map((raw, index) =>
    readClip(raw, index, clipIds)
  )
  if (clips.length === 0) fail('clips must hold at least one clip, or there is nothing to render')

  const textIds = new Set<string>()
  const text = readArray(value['text'], 'text', MAX_VIDEO_TEXT_LAYERS).map((raw, index) =>
    readTextLayer(raw, index, textIds)
  )

  const audioIds = new Set<string>()
  const audio = readArray(value['audio'], 'audio', MAX_VIDEO_AUDIO_TRACKS).map((raw, index) =>
    readAudioTrack(raw, index, audioIds)
  )

  const reel = videoReelDuration({ clips })
  const overrun = text.filter((layer) => layer.start > reel + 1e-6)
  if (overrun.length > 0) {
    fail(
      `text[${text.indexOf(overrun[0]!)}] starts at ${overrun[0]!.start}s, past the end of the ${reel}s reel`
    )
  }

  return { version, width, height, fps, background, clips, text, audio }
}

/** The transition duration a clip uses, with its default applied. */
export function videoTransitionSeconds(clip: VideoClip): number {
  if (!clip.transition) return 0
  return Math.min(clip.transition.duration ?? 0.5, clip.duration / 2)
}

/**
 * How long the reel runs.
 *
 * Clips play end to end, and a transition overlaps the two clips it joins, so
 * the reel is the sum of the durations minus the overlaps.
 */
export function videoReelDuration(composition: Pick<VideoComposition, 'clips'>): number {
  let total = 0
  for (const [index, clip] of composition.clips.entries()) {
    total += clip.duration
    if (index > 0) total -= videoTransitionSeconds(clip)
  }
  return Math.max(0, Math.round(total * 1_000) / 1_000)
}

/**
 * Where each clip begins and ends on the timeline.
 *
 * A transition moves the following clip earlier by its own duration, so the
 * override has to be threaded through the running total rather than added up
 * per clip.
 */
export interface VideoClipPlacement {
  clip: VideoClip
  /** Seconds on the timeline where the clip becomes visible. */
  start: number
  /** Seconds on the timeline where its own contribution ends. */
  end: number
  /** Seconds of overlap with the previous clip, 0 for the first. */
  overlap: number
}

export function videoClipPlacements(
  composition: Pick<VideoComposition, 'clips'>
): VideoClipPlacement[] {
  const placements: VideoClipPlacement[] = []
  let cursor = 0
  for (const [index, clip] of composition.clips.entries()) {
    const overlap = index > 0 ? videoTransitionSeconds(clip) : 0
    const start = cursor - overlap
    const end = start + clip.duration
    placements.push({ clip, start, end, overlap })
    cursor = end
  }
  return placements
}
