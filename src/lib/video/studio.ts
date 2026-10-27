import {
  validateVideoEdit,
  validateCaptionAppearance,
  type VideoEditDocument,
  type VideoCaptionAppearance
} from './edit'

/** File-backed video edits and bounded job records shared by the tools and UI. */
export type VideoValue = string | number | boolean
export interface VideoControl {
  key: string
  label: string
  kind: 'text' | 'number' | 'color' | 'switch'
  value: VideoValue
  min?: number
  max?: number
}
export interface VideoCaption {
  text: string
  start: number
  end: number
  words?: { text: string; start: number; end: number }[]
  appearance?: VideoCaptionAppearance
}
export interface VideoAudioTrack {
  source: string
  start: number
  trim: number
  duration: number
  gain: number
}
export interface VideoStudioDocument {
  version: 1
  controls: VideoControl[]
  captions: VideoCaption[]
  /**
   * How captions are drawn over the picture.
   *
   * `none` draws no captions at all: a composition can carry its words for a
   * transcript and still show none of them, which is a real editorial choice and
   * not the same as an empty caption list.
   */
  captionStyle: 'plain' | 'highlight' | 'karaoke' | 'none'
  audioTracks: VideoAudioTrack[]
  edit?: VideoEditDocument
  captionAppearance?: VideoCaptionAppearance
}
export interface VideoJob {
  id: string
  projectId: string
  threadId: string
  operation: string
  state: 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  stage: string
  files: string[]
  error?: string
  result?: unknown
}
export const VIDEO_STUDIO_FILE = 'studio.json'

export function videoRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function videoNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}
export function videoText(value: unknown, name: string, max = 1024): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must be nonempty text of at most ${max} characters`)
  return value
}
export function validateVideoStudio(raw: unknown): VideoStudioDocument {
  const value = videoRecord(raw)
  if (value.version !== undefined && value.version !== 1)
    throw new Error('Unsupported studio version')
  function list(field: string, limit: number): unknown[] {
    const entries = value[field] ?? []
    if (!Array.isArray(entries) || entries.length > limit)
      throw new Error(`${field} must contain at most ${limit} entries`)
    return entries
  }
  const keys = new Set<string>()
  const controls = list('controls', 32).map((raw): VideoControl => {
    const entry = videoRecord(raw)
    const key = videoText(entry.key, 'key', 64)
    if (!/^[a-zA-Z][\w-]*$/u.test(key) || keys.has(key) || key === 'constructor')
      throw new Error('Control keys must be unique simple identifiers')
    keys.add(key)
    const kind = entry.kind
    if (kind !== 'text' && kind !== 'number' && kind !== 'color' && kind !== 'switch')
      throw new Error('Unsupported control kind')
    const min =
      entry.min === undefined ? -100000 : videoNumber(entry.min, 'minimum', -100000, 100000)
    const max = entry.max === undefined ? 100000 : videoNumber(entry.max, 'maximum', min, 100000)
    let controlValue: VideoValue
    if (kind === 'number') controlValue = videoNumber(entry.value, key, min, max)
    else if (kind === 'switch') {
      if (typeof entry.value !== 'boolean') throw new Error(`${key} must be a boolean`)
      controlValue = entry.value
    } else {
      if (typeof entry.value !== 'string' || entry.value.length > 4096)
        throw new Error(`${key} must be text`)
      if (kind === 'color' && !/^#[0-9a-f]{6}$/iu.test(entry.value))
        throw new Error(`${key} must be a hex color`)
      controlValue = entry.value
    }
    return {
      key,
      label: videoText(entry.label, 'label', 120),
      kind,
      value: controlValue,
      ...(kind === 'number' ? { min, max } : {})
    }
  })
  let previous = -1
  const captions = list('captions', 10000).map((raw): VideoCaption => {
    const entry = videoRecord(raw)
    const start = videoNumber(entry.start, 'caption start', 0, 3600)
    const end = videoNumber(entry.end, 'caption end', start + 0.001, 3600)
    if (start < previous) throw new Error('Captions must be ordered and must not overlap')
    previous = end
    const caption: VideoCaption = { text: videoText(entry.text, 'caption text', 2048), start, end }
    if (entry.appearance !== undefined)
      caption.appearance = validateCaptionAppearance(entry.appearance)
    if (entry.words !== undefined) {
      if (!Array.isArray(entry.words) || entry.words.length > 200)
        throw new Error('Too many caption words')
      let wordEnd = start
      caption.words = entry.words.map((raw) => {
        const word = videoRecord(raw)
        const wordStart = videoNumber(word.start, 'word start', wordEnd, end)
        wordEnd = videoNumber(word.end, 'word end', wordStart + 0.001, end)
        return { text: videoText(word.text, 'word', 128), start: wordStart, end: wordEnd }
      })
    }
    return caption
  })
  const style = value.captionStyle ?? 'plain'
  if (style !== 'plain' && style !== 'highlight' && style !== 'karaoke' && style !== 'none')
    throw new Error('Unsupported caption style')
  const audioTracks = list('audioTracks', 24).map((raw): VideoAudioTrack => {
    const track = videoRecord(raw)
    return {
      source: videoText(track.source, 'audio source'),
      start: videoNumber(track.start ?? 0, 'track start', 0, 3600),
      trim: videoNumber(track.trim ?? 0, 'track trim', 0, 3600),
      duration: videoNumber(track.duration, 'track duration', 0.001, 3600),
      gain: videoNumber(track.gain ?? 1, 'track gain', 0, 1)
    }
  })
  return {
    version: 1,
    controls,
    captions,
    captionStyle: style,
    audioTracks,
    ...(value.edit === undefined ? {} : { edit: validateVideoEdit(value.edit) }),
    ...(value.captionAppearance === undefined
      ? {}
      : { captionAppearance: validateCaptionAppearance(value.captionAppearance) })
  }
}

/** Retimes source captions after a cut. Supplied word timestamps remain exact. */
export function trimVideoCaptions(
  captions: VideoCaption[],
  from: number,
  to: number,
  at = 0
): VideoCaption[] {
  videoNumber(from, 'trim start', 0, 3600)
  videoNumber(to, 'trim end', from + 0.001, 3600)
  videoNumber(at, 'timeline start', 0, 3600 - (to - from))
  return captions
    .filter((caption) => caption.end > from && caption.start < to)
    .map((caption) => ({
      ...caption,
      start: Math.max(from, caption.start) - from + at,
      end: Math.min(to, caption.end) - from + at,
      ...(caption.words
        ? {
            words: caption.words
              .filter((word) => word.end > from && word.start < to)
              .map((word) => ({
                ...word,
                start: Math.max(from, word.start) - from + at,
                end: Math.min(to, word.end) - from + at
              }))
          }
        : {})
    }))
}

export function videoCaptionsSrt(captions: VideoCaption[]): string {
  const timestamp = (seconds: number): string => {
    const total = Math.round(seconds * 1000)
    return `${String(Math.floor(total / 3600000)).padStart(2, '0')}:${String(Math.floor(total / 60000) % 60).padStart(2, '0')}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')},${String(total % 1000).padStart(3, '0')}`
  }
  return (
    captions
      .map(
        (caption, index) =>
          `${index + 1}\n${timestamp(caption.start)} --> ${timestamp(caption.end)}\n${caption.text}`
      )
      .join('\n\n') + '\n'
  )
}

export function parseVideoSrt(source: string): VideoCaption[] {
  const time = (raw: string): number => {
    const parts = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(raw.trim())
    if (!parts || Number(parts[2]) > 59 || Number(parts[3]) > 59)
      throw new Error('Invalid subtitle timestamp')
    return (
      Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) + Number(parts[4]) / 1000
    )
  }
  const captions = source
    .replace(/^\uFEFF/u, '')
    .replaceAll('\r', '')
    .trim()
    .split(/\n\s*\n/u)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n')
      if (/^\d+$/u.test(lines[0])) lines.shift()
      const times = lines.shift()?.split(/\s+-->\s+/u)
      if (!times || times.length !== 2) throw new Error('Invalid subtitle cue')
      return { text: lines.join('\n'), start: time(times[0]), end: time(times[1]) }
    })
  return validateVideoStudio({ captions }).captions
}
