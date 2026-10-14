import {
  MARK_BADGE_SIZE,
  accentMarkColor,
  clampMarkStrokeWidth,
  isMarkTap,
  markBadgePoint,
  type MarkPoint
} from './annotation-marks'
import { videoTimecode } from '$shared/video/timeline'

/**
 * Turning marks into a picture: the rasterising half of the annotation engine.
 *
 * The agent cannot see normalized coordinates, so a send has to arrive as a
 * picture with the marks drawn on it. This module is that step and nothing else:
 * no file access, no IPC, no app state, just a base picture and a list of marks
 * in and a PNG out. Keeping it free of the app is what makes it the one place
 * marks become pixels for both kinds of surface, and what lets the round trip be
 * looked at on its own.
 *
 * Two sources of base picture arrive here, and they differ in exactly one step.
 * A still is decoded from its bytes. A video is decoded from its bytes too, then
 * seeked to the annotated second, because a frame is not a file and the only way
 * to reach one is to ask a player for it.
 */

/** One mark, resolved to everything the rasteriser needs to draw it. */
export interface RasterMark {
  /** Any CSS colour; the mark's own, not the pen's current one. */
  color: string
  /** The number drawn in the badge, from the label the composer showed. */
  number: number
  /** The stroke, normalized to 0..1 of the picture. */
  points: readonly MarkPoint[]
  /** Stroke width in CSS pixels, at the picture's own size. */
  strokeWidth: number
}

/**
 * Longest edge of a composed picture. Artifacts are bounded at 512 MiB by the
 * preview table, which is far larger than any model should be handed for a
 * picture the user marked; downscaling keeps the attachment inside the app's own
 * image limits and small enough to upload quickly.
 */
export const MAX_COMPOSED_EDGE = 1600

/**
 * Ceiling on the bytes read to resolve one frame.
 *
 * Reading a video into memory to reach a frame is the only way a renderer can
 * decode one, and a long clip is exactly the case where that is not worth doing
 * for a single annotation. Past this the mark travels as its timecode and text
 * alone, which still tells the agent which second to change.
 */
export const MAX_FRAME_SOURCE_BYTES = 64 * 1024 * 1024

/** Ceiling on one decode or one seek, so a corrupt file cannot hang a send. */
export const FRAME_DECODE_TIMEOUT_MS = 10_000

/** Colour used when the live theme cannot be read (tests, SSR, a bare page). */
export const FALLBACK_ACCENT = '#e5484d'

/** Wait for one media event, or reject rather than hang the send. */
function waitForMediaEvent(video: HTMLVideoElement, type: 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`the frame did not arrive within ${FRAME_DECODE_TIMEOUT_MS}ms`))
    }, FRAME_DECODE_TIMEOUT_MS)
    const onDone = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('the video could not be decoded'))
    }
    function cleanup(): void {
      clearTimeout(timer)
      video.removeEventListener(type, onDone)
      video.removeEventListener('error', onError)
    }
    video.addEventListener(type, onDone)
    video.addEventListener('error', onError)
  })
}

/**
 * One frame of a video, decoded from its own bytes.
 *
 * The blob URL is built in this document, so the frame lands on an untainted
 * canvas and can be read back. The target second is clamped inside the file's
 * length, because a mark drawn at the last visible second of a rounded timeline
 * would otherwise seek past the end and never fire `seeked`.
 */
export async function videoFrameBitmap(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  seconds: number
): Promise<ImageBitmap> {
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.playsInline = true
  try {
    video.src = objectUrl
    video.load()
    await waitForMediaEvent(video, 'loadeddata')
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null
    const target = end === null ? seconds : Math.min(Math.max(seconds, 0), end - 0.001)
    if (Math.abs(video.currentTime - target) > 0.0005) {
      video.currentTime = target
      await waitForMediaEvent(video, 'seeked')
    }
    return await createImageBitmap(video)
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}

/** The bitmap that marks are drawn over: a still, or one frame of a video. */
export async function baseBitmap(input: {
  bytes: Uint8Array<ArrayBuffer>
  /** The second whose frame is wanted, or null for a still. */
  seconds: number | null
  /** The file's media type, needed only to decode a frame. */
  mime: string
}): Promise<ImageBitmap> {
  if (input.seconds === null) return createImageBitmap(new Blob([input.bytes]))
  if (input.bytes.byteLength > MAX_FRAME_SOURCE_BYTES) {
    throw new Error('the video is too large to resolve a frame from')
  }
  return videoFrameBitmap(input.bytes, input.mime, input.seconds)
}

/** The stroke colour, read from the live theme so the picture matches the app. */
function accentColor(): string {
  if (typeof document === 'undefined') return FALLBACK_ACCENT
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  return value || FALLBACK_ACCENT
}

/** Draw one mark: a haloed stroke for a drawn area, a dot for a tap. */
export function drawMark(
  context: OffscreenCanvasRenderingContext2D,
  mark: RasterMark,
  width: number,
  height: number
): void {
  const scale = Math.min(width, height)
  const first = mark.points[0]
  if (!first) return
  const strokeWidth = clampMarkStrokeWidth(mark.strokeWidth)
  context.lineJoin = 'round'
  context.lineCap = 'round'
  if (isMarkTap(mark.points)) {
    const radius = strokeWidth * 1.6
    const x = first.x * width
    const y = first.y * height
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = mark.color
    context.fill()
    context.lineWidth = strokeWidth
    context.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    context.stroke()
  } else {
    const trace = (): void => {
      context.beginPath()
      context.moveTo(first.x * width, first.y * height)
      for (const point of mark.points.slice(1)) {
        context.lineTo(point.x * width, point.y * height)
      }
      context.stroke()
    }
    // A light halo under the coloured stroke keeps the mark readable over both a
    // bright and a dark picture, which is the whole point of drawing it.
    context.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    context.lineWidth = strokeWidth * 3
    trace()
    context.strokeStyle = mark.color
    context.lineWidth = strokeWidth
    trace()
  }

  const badge = markBadgePoint(mark.points)
  const radius = Math.max(MARK_BADGE_SIZE, Math.round(scale * 0.028)) / 2
  const x = Math.min(Math.max(badge.x * width, radius), width - radius)
  const y = Math.min(Math.max(badge.y * height, radius), height - radius)
  context.beginPath()
  context.arc(x, y, radius, 0, Math.PI * 2)
  context.fillStyle = accentColor()
  context.fill()
  context.lineWidth = Math.max(2, radius / 5)
  context.strokeStyle = '#ffffff'
  context.stroke()
  context.fillStyle = '#ffffff'
  context.font = `600 ${Math.round(radius * 1.2)}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(String(mark.number), x, y)
}

/**
 * The composed picture: the base, downscaled if it is oversized, with every mark
 * drawn on it in the order it was made.
 */
export async function composePicture(
  base: ImageBitmap,
  marks: readonly RasterMark[]
): Promise<Blob | null> {
  const longest = Math.max(base.width, base.height)
  const scale = longest > MAX_COMPOSED_EDGE ? MAX_COMPOSED_EDGE / longest : 1
  const width = Math.max(1, Math.round(base.width * scale))
  const height = Math.max(1, Math.round(base.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(base, 0, 0, width, height)
  for (const mark of marks) {
    drawMark(context, mark, width, height)
  }
  return canvas.convertToBlob({ type: 'image/png' })
}

/**
 * The name of a composed picture.
 *
 * A frame carries its moment in the name, because a send can hold several frames
 * of one video and two attachments called the same thing is a name the agent
 * cannot tell apart. The timecode's colon is not a legal filename character, so
 * it becomes a dash: `clip-0-03.500-annotated.png`.
 */
export function annotatedFilename(filename: string, seconds: number | null): string {
  const trimmed = filename.trim() || 'image'
  const withoutExtension = trimmed.replace(/\.[a-z0-9]{1,8}$/iu, '')
  const base = withoutExtension || 'image'
  if (seconds === null) return `${base}-annotated.png`
  return `${base}-${videoTimecode(seconds).replace(':', '-')}-annotated.png`
}
