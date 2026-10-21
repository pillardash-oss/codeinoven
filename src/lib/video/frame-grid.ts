export interface VideoFrameCell {
  frame: number
  time: number
  end: number
}

export interface VideoFrameThumbnail {
  time: number
  image: string
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
