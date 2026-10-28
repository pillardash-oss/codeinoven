import type { VideoStudioDocument } from './studio'
import type { VideoEditClip } from './edit'
export interface VideoFrameCell {
  frame: number
  time: number
  end: number
}

export interface VideoFrameThumbnail {
  time: number
  image: string
  clipId?: string
}

/** A frame address must stop at the final drawable frame, not the duration sentinel. */
export function snapVideoFrame(seconds: number, duration: number, fps: number): number {
  if (!Number.isFinite(seconds) || duration <= 0 || fps <= 0) return 0
  const last = Math.max(0, Math.ceil(duration * fps) - 1)
  return Math.min(last, Math.max(0, Math.round(seconds * fps))) / fps
}

/** Virtualize the visible strip. At high zoom each cell is exactly one frame. */
export function visibleVideoFrames(
  duration: number,
  fps: number,
  start: number,
  end: number,
  trackWidth: number
): VideoFrameCell[] {
  if (duration <= 0 || fps <= 0 || trackWidth <= 0) return []
  const count = Math.ceil(duration * fps)
  const stride = Math.max(1, Math.ceil((64 * count) / trackWidth))
  const first = Math.max(0, Math.floor((start * fps) / stride) * stride)
  const last = Math.min(count - 1, Math.ceil(end * fps))
  const cells: VideoFrameCell[] = []
  for (let frame = first; frame <= last && cells.length < 24; frame += stride)
    cells.push({ frame, time: frame / fps, end: Math.min(duration, (frame + stride) / fps) })
  return cells
}

export interface VideoClipFrameCell extends VideoFrameCell {
  clipId: string
  key: string
}
/** Visible source samples, bounded across all clips rather than per track. */
export function visibleClipFrames(
  clips: readonly VideoEditClip[],
  fps: number,
  start: number,
  end: number,
  scale: number
): VideoClipFrameCell[] {
  const cells: VideoClipFrameCell[] = []
  for (const clip of clips) {
    const from = Math.max(clip.start, start),
      to = Math.min(clip.start + clip.duration, end)
    if (to <= from || clip.duration * scale < 12) continue
    const count = Math.max(1, Math.min(8, Math.ceil(((to - from) * scale) / 90)))
    const step = (to - from) / count
    for (let index = 0; index < count && cells.length < 96; index++) {
      const time = Math.max(
        clip.start,
        Math.min(
          clip.start + clip.duration - 1 / fps,
          clip.start + Math.floor((from - clip.start + index * step) * fps + 1e-7) / fps
        )
      )
      const sourceTime = clip.sourceStart + (time - clip.start) * clip.speed
      const key = `${clip.id}:${Math.round(sourceTime * 1_000_000)}`,
        previous = cells.at(-1)
      if (previous?.key === key) {
        previous.end = Math.max(previous.end, Math.min(to, from + (index + 1) * step))
        continue
      }
      cells.push({
        time,
        end: Math.min(to, from + (index + 1) * step),
        frame: Math.round(time * fps),
        clipId: clip.id,
        key
      })
    }
    if (cells.length >= 96) break
  }
  return cells
}

/** Project a single source clip into a full-size thumbnail without other layers. */
export function videoClipThumbnailDocument(
  document: VideoStudioDocument,
  clipId: string
): VideoStudioDocument {
  const edit = document.edit,
    clip = edit?.clips.find((clip) => clip.id === clipId)
  if (!edit || !clip) throw new Error('Thumbnail clip no longer exists')
  return {
    ...document,
    captions: [],
    captionStyle: 'none',
    audioTracks: [],
    edit: {
      ...edit,
      background: 'black',
      regions: [],
      clips: [
        {
          ...clip,
          id: clip.assetId,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          opacity: 1,
          volume: 0,
          transition: { kind: 'none', duration: 0 }
        }
      ],
      tracks: edit.tracks.map((track) => ({ ...track, hidden: false, muted: true }))
    }
  }
}

export function videoThumbnailClips(document: VideoStudioDocument | null): VideoEditClip[] {
  const edit = document?.edit
  if (!edit) return []
  const assets = new Map(edit.assets.map((asset) => [asset.id, asset.kind]))
  return edit.clips.filter((clip) => assets.get(clip.assetId) === 'video')
}
