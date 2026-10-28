import { FONT_STACKS } from '../app-fonts'

/** Source-preserving editing data shared by the UI, agent tools and renderer. */
export type VideoAssetKind = 'video' | 'audio' | 'image'
export type VideoTrackKind = 'video' | 'audio' | 'caption' | 'overlay'
export interface VideoEditAsset {
  id: string
  name: string
  source: string
  kind: VideoAssetKind
  duration: number
  width: number
  height: number
  hasAudio: boolean
}
export interface VideoEditTrack {
  id: string
  name: string
  kind: VideoTrackKind
  locked: boolean
  muted: boolean
  hidden: boolean
}
export interface VideoEditRect {
  x: number
  y: number
  width: number
  height: number
}
export interface VideoEditGrade {
  exposure: number
  contrast: number
  saturation: number
  temperature: number
  hue: number
}
export interface VideoEditAudio {
  highpass: number
  lowpass: number
  deess: number
  compression: number
  pan: number
}
export interface VideoEditTransition {
  kind: 'none' | 'dissolve' | 'fade' | 'slide' | 'zoom'
  duration: number
}
export interface VideoEditClip {
  id: string
  assetId: string
  trackId: string
  start: number
  sourceStart: number
  duration: number
  speed: number
  volume: number
  audioDetached?: boolean
  opacity: number
  rect: VideoEditRect
  crop: VideoEditRect
  grade: VideoEditGrade
  audio: VideoEditAudio
  fadeIn: number
  fadeOut: number
  transition: VideoEditTransition
}
export interface VideoEditRegion extends VideoEditRect {
  trackId?: string
  id: string
  start: number
  duration: number
  kind: 'blur' | 'pixelate' | 'cover'
  amount: number
  color: string
  stroke?: { x: number; y: number }[]
  brushSize?: number
}
export interface VideoCaptionAppearance {
  x: number
  y: number
  width: number
  size: number
  font: string
  weight: number
  color: string
  background: string
  backgroundOpacity: number
}
export interface VideoEditChange {
  id: string
  author: 'user' | 'agent'
  at: number
  start: number
  end: number
  label: string
  reviewed: boolean
}
export interface VideoEditDocument {
  version: 1
  background: 'black' | 'composition'
  duration: number
  assets: VideoEditAsset[]
  tracks: VideoEditTrack[]
  clips: VideoEditClip[]
  regions: VideoEditRegion[]
  changes: VideoEditChange[]
}
export type VideoEditorSelection =
  | { kind: 'clip'; id: string }
  | { kind: 'region'; id: string }
  | { kind: 'caption'; index: number }
  | { kind: 'brush'; size: number }
  | null
export interface VideoEditorGesture {
  kind?: 'select' | 'context' | 'paint'
  point?: { x: number; y: number }
  selection: Exclude<VideoEditorSelection, null>
  rect: VideoEditRect
  captionAppearance?: VideoCaptionAppearance
  stroke?: { x: number; y: number }[]
  brushSize?: number
}
export function validateVideoBrushStroke(raw: unknown): { x: number; y: number }[] {
  return entries(raw, 256).map((entry) => {
    const point = record(entry)
    return { x: number(point.x, 'Brush X', 0, 1), y: number(point.y, 'Brush Y', 0, 1) }
  })
}
export function validateVideoEditorSelection(raw: unknown): VideoEditorSelection {
  if (raw === null || raw === undefined) return null
  const value = record(raw)
  if (value.kind === 'brush')
    return { kind: 'brush', size: number(value.size, 'Brush size', 0.005, 0.3, 0.04) }
  if (value.kind === 'caption')
    return { kind: 'caption', index: number(value.index, 'Caption index', 0, 9999) }
  return { kind: choice(value.kind, ['clip', 'region']), id: text(value.id, 'Selection ID', 96) }
}

export const VIDEO_EDIT_RECT: VideoEditRect = { x: 0, y: 0, width: 1, height: 1 }
export const VIDEO_EDIT_GRADE: VideoEditGrade = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  hue: 0
}
export const VIDEO_EDIT_AUDIO: VideoEditAudio = {
  highpass: 20,
  lowpass: 20000,
  deess: 0,
  compression: 0,
  pan: 0
}
export const VIDEO_CAPTION_APPEARANCE: VideoCaptionAppearance = {
  x: 0.5,
  y: 0.86,
  width: 0.84,
  size: 0.035,
  font: 'system',
  weight: 600,
  color: '#ffffff',
  background: '#000000',
  backgroundOpacity: 0.8
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected editing data')
  return value as Record<string, unknown>
}
function text(value: unknown, field: string, maximum = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`Invalid ${field}`)
  return value
}
function number(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback?: number
): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${field} must be between ${min} and ${max}`)
  return value
}
function bool(value: unknown): boolean {
  return value === true
}
function entries(value: unknown, maximum: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(`Too many editing entries; maximum ${maximum}`)
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[], fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw new Error('Unsupported editing option')
  return value as T
}
function color(value: unknown, fallback: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/iu.test(value))
    throw new Error('Expected a six-digit colour')
  return value
}
export function validateVideoEditRect(value: unknown): VideoEditRect {
  const r = value === undefined ? {} : record(value)
  return {
    x: number(r.x, 'X', -1, 1, 0),
    y: number(r.y, 'Y', -1, 1, 0),
    width: number(r.width, 'Width', 0.01, 2, 1),
    height: number(r.height, 'Height', 0.01, 2, 1)
  }
}
export function validateCaptionAppearance(value: unknown): VideoCaptionAppearance {
  const r = value === undefined ? {} : record(value)
  if (r.font !== undefined && (typeof r.font !== 'string' || !Object.hasOwn(FONT_STACKS, r.font)))
    throw new Error('Choose a font from the app font library')
  return {
    x: number(r.x, 'Caption X', 0, 1, 0.5),
    y: number(r.y, 'Caption Y', 0, 1, 0.86),
    width: number(r.width, 'Caption width', 0.1, 1, 0.84),
    size: number(r.size, 'Caption size', 0.01, 0.15, 0.035),
    font: r.font === undefined ? 'system' : text(r.font, 'Caption font', 64),
    weight: number(r.weight, 'Caption weight', 100, 900, 600),
    color: color(r.color, '#ffffff'),
    background: color(r.background, '#000000'),
    backgroundOpacity: number(r.backgroundOpacity, 'Caption background opacity', 0, 1, 0.8)
  }
}
export function validateVideoEdit(value: unknown): VideoEditDocument {
  const r = record(value)
  if (r.version !== 1) throw new Error('Unsupported editor version')
  const duration = number(r.duration, 'Edit duration', 0.001, 3600)
  const ids = new Set<string>()
  const id = (raw: unknown): string => {
    const value = text(raw, 'ID', 96)
    if (!/^[\w-]+$/u.test(value) || ids.has(value))
      throw new Error('Editing IDs must be unique simple identifiers')
    ids.add(value)
    return value
  }
  const assets = entries(r.assets, 512).map((raw): VideoEditAsset => {
    const a = record(raw),
      source = text(a.source, 'Source', 1024)
    if (/^(?:[/\\]|[a-z]+:)/iu.test(source) || source.split(/[/\\]/u).some((part) => part === '..'))
      throw new Error('Assets must stay inside the composition folder')
    return {
      id: id(a.id),
      name: text(a.name, 'Asset name'),
      source,
      kind: choice(a.kind, ['video', 'audio', 'image']),
      duration: number(a.duration, 'Asset duration', 0.001, 86400, 5),
      width: number(a.width, 'Asset width', 0, 16384, 0),
      height: number(a.height, 'Asset height', 0, 16384, 0),
      hasAudio: bool(a.hasAudio)
    }
  })
  const tracks = entries(r.tracks, 24).map((raw): VideoEditTrack => {
    const t = record(raw)
    return {
      id: id(t.id),
      name:
        t.kind === 'audio' && (t.name === 'Dialogue' || t.name === 'Music / effects')
          ? 'Audio'
          : text(t.name, 'Track name'),
      kind: choice(t.kind, ['video', 'audio', 'caption', 'overlay']),
      locked: bool(t.locked),
      muted: bool(t.muted),
      hidden: bool(t.hidden)
    }
  })
  // Earlier documents stored captions and privacy masks in implicit rows.
  for (const kind of ['caption', 'overlay'] as const)
    if (!tracks.some((track) => track.kind === kind)) {
      if (tracks.length >= 24) throw new Error('Track limit reached while restoring typed tracks')
      let trackId: string = kind
      while (tracks.some((track) => track.id === trackId)) trackId += '-track'
      tracks.push({
        id: trackId,
        kind,
        name: kind === 'caption' ? 'Captions' : 'Overlays',
        locked: false,
        hidden: false,
        muted: false
      })
    }
  const assetIds = new Map(assets.map((asset) => [asset.id, asset]))
  const trackIds = new Map(tracks.map((track) => [track.id, track]))
  const clips = entries(r.clips, 4000).map((raw): VideoEditClip => {
    const c = record(raw),
      grade = c.grade === undefined ? {} : record(c.grade),
      audio = c.audio === undefined ? {} : record(c.audio)
    const transition = c.transition === undefined ? {} : record(c.transition)
    const assetId = text(c.assetId, 'Asset ID', 96),
      trackId = text(c.trackId, 'Track ID', 96)
    const asset = assetIds.get(assetId)
    if (!asset || !trackIds.has(trackId))
      throw new Error('Clip references a missing asset or track')
    const requiredKind =
      asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'overlay' : 'video'
    if (trackIds.get(trackId)?.kind !== requiredKind)
      throw new Error('Video, audio and overlay clips must stay on matching track types')
    const start = number(c.start, 'Clip start', 0, 3600)
    const clipDuration = number(c.duration, 'Clip duration', 0.001, 3600)
    const sourceStart = number(c.sourceStart, 'Source in', 0, 86400, 0)
    const speed = number(c.speed, 'Speed', 0.25, 4, 1)
    const crop = validateVideoEditRect(c.crop)
    if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > 1.001 || crop.y + crop.height > 1.001)
      throw new Error('Crop must stay inside the source picture')
    if (start + clipDuration > duration + 0.05)
      throw new Error('A clip extends past the edit duration')
    if (asset.kind !== 'image' && sourceStart + clipDuration * speed > asset.duration + 0.1)
      throw new Error('A clip extends past its source media')
    return {
      id: id(c.id),
      assetId,
      trackId,
      start,
      duration: clipDuration,
      sourceStart,
      speed,
      volume: number(c.volume, 'Volume', 0, 4, 1),
      opacity: number(c.opacity, 'Opacity', 0, 1, 1),
      rect: validateVideoEditRect(c.rect),
      crop,
      grade: {
        exposure: number(grade.exposure, 'Exposure', -3, 3, 0),
        contrast: number(grade.contrast, 'Contrast', 0.25, 3, 1),
        saturation: number(grade.saturation, 'Saturation', 0, 3, 1),
        temperature: number(grade.temperature, 'Temperature', -1, 1, 0),
        hue: number(grade.hue, 'Hue', -180, 180, 0)
      },
      ...(c.audioDetached === true ? { audioDetached: true } : {}),
      audio: {
        highpass: number(audio.highpass, 'High pass', 20, 2000, 20),
        lowpass: number(audio.lowpass, 'Low pass', 2000, 20000, 20000),
        deess: number(audio.deess, 'De-essing', 0, 1, 0),
        compression: number(audio.compression, 'Compression', 0, 1, 0),
        pan: number(audio.pan, 'Pan', -1, 1, 0)
      },
      fadeIn: number(c.fadeIn, 'Fade in', 0, clipDuration, 0),
      fadeOut: number(c.fadeOut, 'Fade out', 0, clipDuration, 0),
      transition: {
        kind: choice(transition.kind, ['none', 'dissolve', 'fade', 'slide', 'zoom'], 'none'),
        duration: number(
          transition.duration,
          'Transition duration',
          0,
          Math.min(5, clipDuration),
          0
        )
      }
    }
  })
  const regions = entries(r.regions, 256).map((raw): VideoEditRegion => {
    const b = record(raw)
    return {
      ...validateVideoEditRect(b),
      trackId:
        b.trackId === undefined
          ? tracks.find((track) => track.kind === 'overlay')!.id
          : text(b.trackId, 'Overlay track ID', 96),
      id: id(b.id),
      start: number(b.start, 'Region start', 0, duration),
      duration: number(b.duration, 'Region duration', 0.001, duration),
      kind: choice(b.kind, ['blur', 'pixelate', 'cover'], 'blur'),
      amount: number(b.amount, 'Blur strength', 1, 100, 24),
      color: color(b.color, '#000000'),
      ...(b.stroke !== undefined
        ? {
            stroke: validateVideoBrushStroke(b.stroke),
            brushSize: number(b.brushSize, 'Brush size', 0.001, 2, 0.1)
          }
        : {})
    }
  })
  for (const region of regions)
    if (!tracks.some((track) => track.id === region.trackId && track.kind === 'overlay'))
      throw new Error('Privacy items require an overlay track')
  const changes = entries(r.changes, 100).map((raw): VideoEditChange => {
    const c = record(raw)
    return {
      id: text(c.id, 'Change ID', 96),
      author: choice(c.author, ['user', 'agent']),
      at: number(c.at, 'Change time', 0, Number.MAX_SAFE_INTEGER),
      start: number(c.start, 'Change start', 0, 3600),
      end: number(c.end, 'Change end', 0, 3600),
      label: text(c.label, 'Change label'),
      reviewed: bool(c.reviewed)
    }
  })
  return {
    version: 1,
    background: choice(r.background, ['black', 'composition'], 'black'),
    duration,
    assets,
    tracks,
    clips,
    regions,
    changes
  }
}

export function newVideoEditClip(
  asset: VideoEditAsset,
  trackId: string,
  start: number,
  duration?: number
): VideoEditClip {
  return {
    id: crypto.randomUUID(),
    assetId: asset.id,
    trackId,
    start,
    sourceStart: 0,
    duration: duration ?? Math.min(asset.duration, asset.kind === 'image' ? 5 : 3600 - start),
    speed: 1,
    volume: 1,
    opacity: 1,
    rect: { ...VIDEO_EDIT_RECT },
    crop: { ...VIDEO_EDIT_RECT },
    grade: { ...VIDEO_EDIT_GRADE },
    audio: { ...VIDEO_EDIT_AUDIO },
    fadeIn: 0,
    fadeOut: 0,
    transition: { kind: 'none', duration: 0 }
  }
}
export function snapEditTime(seconds: number, fps: number): number {
  return Math.round(Math.max(0, seconds) * Math.max(1, fps)) / Math.max(1, fps)
}
/** Split retains the exact source interval, including non-unit playback speed. */
export function splitVideoEditClip(
  edit: VideoEditDocument,
  id: string,
  seconds: number,
  fps: number
): string | null {
  const clip = edit.clips.find((clip) => clip.id === id)
  if (!clip || edit.tracks.find((track) => track.id === clip.trackId)?.locked) return null
  const at = snapEditTime(seconds, fps),
    left = at - clip.start,
    right = clip.duration - left
  if (left < 1 / fps || right < 1 / fps) return null
  const next: VideoEditClip = structuredClone(clip)
  next.id = crypto.randomUUID()
  next.start = at
  next.sourceStart += left * clip.speed
  next.duration = right
  next.fadeIn = 0
  next.fadeOut = Math.min(next.fadeOut, right)
  next.transition = { kind: 'none', duration: 0 }
  clip.duration = left
  clip.fadeOut = 0
  clip.fadeIn = Math.min(clip.fadeIn, left)
  clip.transition.duration = Math.min(clip.transition.duration, left)
  edit.clips.push(next)
  return next.id
}
export function removeVideoEditClip(
  edit: VideoEditDocument,
  id: string,
  ripple: boolean | 'all'
): void {
  const clip = edit.clips.find((clip) => clip.id === id)
  if (!clip || edit.tracks.find((track) => track.id === clip.trackId)?.locked) return
  if (ripple === 'all') {
    const start = clip.start,
      end = start + clip.duration,
      next: VideoEditClip[] = []
    for (const item of edit.clips) {
      if (item.id === id) continue
      if (
        edit.tracks.find((track) => track.id === item.trackId)?.locked ||
        item.start + item.duration <= start
      ) {
        next.push(item)
        continue
      }
      if (item.start >= end) {
        next.push({ ...item, start: item.start - clip.duration })
        continue
      }
      const itemEnd = item.start + item.duration
      if (item.start < start)
        next.push({
          ...item,
          duration: start - item.start,
          fadeIn: Math.min(item.fadeIn, start - item.start),
          fadeOut: Math.min(item.fadeOut, start - item.start),
          transition: {
            ...item.transition,
            duration: Math.min(item.transition.duration, start - item.start)
          }
        })
      if (itemEnd > end)
        next.push({
          ...item,
          id: item.start < start ? crypto.randomUUID() : item.id,
          start,
          sourceStart: item.sourceStart + (end - item.start) * item.speed,
          duration: itemEnd - end,
          fadeIn: Math.min(item.fadeIn, itemEnd - end),
          fadeOut: Math.min(item.fadeOut, itemEnd - end),
          transition: { kind: 'none', duration: 0 }
        })
    }
    edit.clips = next
    edit.duration = Math.max(
      0.001,
      edit.duration - clip.duration,
      ...next.map((item) => item.start + item.duration)
    )
    return
  }
  edit.clips = edit.clips.filter((candidate) => candidate.id !== id)
  if (ripple)
    for (const candidate of edit.clips)
      if (
        candidate.trackId === clip.trackId &&
        !edit.tracks.find((track) => track.id === candidate.trackId)?.locked &&
        candidate.start >= clip.start + clip.duration - 0.001
      )
        candidate.start = Math.max(0, candidate.start - clip.duration)
}

export function trimVideoEditClip(
  edit: VideoEditDocument,
  id: string,
  edge: 'start' | 'end',
  seconds: number,
  fps: number,
  rippleEnd = false
): void {
  const clip = edit.clips.find((clip) => clip.id === id)
  if (!clip || edit.tracks.find((track) => track.id === clip.trackId)?.locked) return
  const asset = edit.assets.find((asset) => asset.id === clip.assetId)
  if (!asset) return
  const frame = 1 / Math.max(1, fps),
    end = clip.start + clip.duration
  if (edge === 'start') {
    const previousEnd = Math.max(
      0,
      ...edit.clips
        .filter(
          (item) => item.id !== id && item.trackId === clip.trackId && item.start < clip.start
        )
        .map((item) => item.start + item.duration)
    )
    const minimum = Math.max(previousEnd, clip.start - clip.sourceStart / clip.speed)
    const at = Math.min(end - frame, Math.max(minimum, snapEditTime(seconds, fps)))
    clip.sourceStart += (at - clip.start) * clip.speed
    clip.start = at
    clip.duration = end - at
  } else {
    const nextStart = rippleEnd
      ? 3600
      : Math.min(
          3600,
          ...edit.clips
            .filter(
              (item) =>
                item.id !== id && item.trackId === clip.trackId && item.start >= end - 0.000001
            )
            .map((item) => item.start)
        )
    const maximum = Math.min(
      nextStart,
      asset.kind === 'image' ? 3600 : clip.start + (asset.duration - clip.sourceStart) / clip.speed
    )
    const target = Math.max(clip.start + frame, snapEditTime(seconds, fps))
    // The neighbour and source limits bound growth only. A neighbour that starts
    // exactly where this clip ends is the normal contiguous case, so treating that
    // limit as a cap made every inward end trim a no-op.
    clip.duration = (target < end ? target : Math.min(maximum, target)) - clip.start
  }
  clip.fadeIn = Math.min(clip.fadeIn, clip.duration)
  clip.fadeOut = Math.min(clip.fadeOut, clip.duration)
  clip.transition.duration = Math.min(clip.transition.duration, clip.duration)
  edit.duration = Math.max(edit.duration, clip.start + clip.duration)
}

/** Record actual changed ranges, rather than labelling every frame as changed. */
export function recordVideoEditChange(
  previous: VideoEditDocument | undefined,
  next: VideoEditDocument,
  author: 'user' | 'agent',
  additionalRanges: { start: number; end: number }[] = []
): void {
  const before = new Map((previous?.clips ?? []).map((clip) => [clip.id, clip]))
  const changed = next.clips.filter(
    (clip) => JSON.stringify(before.get(clip.id)) !== JSON.stringify(clip)
  )
  const ids = new Set(next.clips.map((clip) => clip.id))
  changed.push(...(previous?.clips ?? []).filter((clip) => !ids.has(clip.id)))
  const regionsChanged = JSON.stringify(previous?.regions ?? []) !== JSON.stringify(next.regions)
  if (!changed.length && !regionsChanged && !additionalRanges.length && previous) return
  const ranges = [
    ...additionalRanges,
    ...changed.map((clip) => ({ start: clip.start, end: clip.start + clip.duration }))
  ]
  if (regionsChanged)
    ranges.push(
      ...next.regions.map((region) => ({
        start: region.start,
        end: region.start + region.duration
      }))
    )
  next.changes = [
    ...next.changes.slice(-99),
    {
      id: crypto.randomUUID(),
      author,
      at: Date.now(),
      start: ranges.length ? Math.min(...ranges.map((range) => range.start)) : 0,
      end: ranges.length ? Math.max(...ranges.map((range) => range.end)) : next.duration,
      label: author === 'agent' ? 'Agent edit' : 'Your edit',
      reviewed: author === 'user'
    }
  ]
}

/** Bounded incremental commands for agents; callers also send the saved revision. */
export function applyVideoEditOperations(
  edit: VideoEditDocument,
  operations: unknown,
  fps: number
): VideoEditDocument {
  for (const raw of entries(operations, 64)) {
    const operation = record(raw),
      kind = text(operation.kind, 'Operation', 40)
    if (kind === 'addClip') {
      const asset = edit.assets.find((asset) => asset.id === operation.assetId)
      const track = edit.tracks.find((track) => track.id === operation.trackId)
      if (!asset || !track || track.locked) throw new Error('Choose an asset and an unlocked track')
      const start = snapEditTime(number(operation.start, 'Start', 0, 3599, 0), fps)
      const clip = newVideoEditClip(
        asset,
        track.id,
        start,
        operation.duration === undefined
          ? undefined
          : number(operation.duration, 'Duration', 0.001, 3600)
      )
      edit.duration = Math.max(edit.duration, start + clip.duration)
      edit.clips.push(clip)
    } else if (kind === 'addTrack') {
      edit.tracks.push({
        id: crypto.randomUUID(),
        name: text(operation.name, 'Track name'),
        kind: choice(operation.trackKind, ['video', 'audio', 'caption', 'overlay']),
        locked: false,
        muted: false,
        hidden: false
      })
    } else if (kind === 'addRegion') {
      const region = record(operation.region)
      edit.regions.push({
        ...validateVideoEditRect(region),
        id: crypto.randomUUID(),
        start: number(region.start, 'Start', 0, edit.duration, 0),
        duration: number(region.duration, 'Duration', 0.001, edit.duration, edit.duration),
        kind: choice(region.kind, ['blur', 'pixelate', 'cover'], 'blur'),
        amount: number(region.amount, 'Strength', 1, 100, 24),
        color: color(region.color, '#000000')
      })
    } else if (kind === 'removeRegion') {
      edit.regions = edit.regions.filter((region) => region.id !== operation.id)
    } else if (kind === 'review') {
      for (const change of edit.changes)
        if (operation.id === undefined || change.id === operation.id) change.reviewed = true
    } else {
      const clip = edit.clips.find((clip) => clip.id === operation.id)
      if (!clip || edit.tracks.find((track) => track.id === clip.trackId)?.locked)
        throw new Error('Choose an unlocked clip')
      if (kind === 'split') {
        if (
          !splitVideoEditClip(
            edit,
            clip.id,
            number(operation.at, 'Split time', 0, edit.duration),
            fps
          )
        )
          throw new Error('Split inside the clip, at least one frame from either edge')
      } else if (kind === 'trim') {
        trimVideoEditClip(
          edit,
          clip.id,
          choice(operation.edge, ['start', 'end']),
          number(operation.at, 'Trim time', 0, 3600),
          fps
        )
      } else if (kind === 'move') {
        const track = edit.tracks.find((track) => track.id === (operation.trackId ?? clip.trackId))
        if (!track || track.locked) throw new Error('Choose an unlocked destination track')
        clip.start = snapEditTime(number(operation.start, 'Start', 0, 3600 - clip.duration), fps)
        clip.trackId = track.id
        edit.duration = Math.max(edit.duration, clip.start + clip.duration)
      } else if (kind === 'remove') removeVideoEditClip(edit, clip.id, operation.ripple === true)
      else if (kind === 'patchClip') {
        const patch = record(operation.patch)
        Object.assign(clip, patch, { id: clip.id })
        edit.duration = Math.max(edit.duration, clip.start + clip.duration)
      } else throw new Error(`Unsupported edit operation: ${kind}`)
    }
  }
  return validateVideoEdit(edit)
}
