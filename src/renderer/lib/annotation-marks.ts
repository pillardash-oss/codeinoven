/**
 * Freehand annotation marks: the pure half of the app's one annotation engine.
 *
 * A mark is a stroke the user draws on a picture the app is showing: a still an
 * inline artifact published, or one frame of a video an inline artifact
 * published. Every point is normalized to 0..1 of the picture, so a mark survives
 * a re-render at any size and is stored without depending on the layout it was
 * drawn in. Nothing here touches the DOM: the overlay a user draws on, and the
 * send-time rasteriser that bakes the marks into a picture, both render these
 * same normalized points, which is what keeps the mark the user sees and the mark
 * the agent receives in step.
 *
 * The engine is deliberately indifferent to which surface it is drawing on. An
 * image and a video frame differ in three things only, and each is a caller's
 * business rather than this module's: the picture the marks are drawn over, the
 * time a frame belongs to, and the wording of the descriptor. That is why a frame
 * annotation is the same reference, the same overlay, and the same rasteriser as
 * a still one rather than a second implementation of the same idea.
 */

/** One point of a mark, normalized to 0..1 of the picture box. */
export interface MarkPoint {
  x: number
  y: number
}

/** The style one mark is drawn with, chosen per mark so an old mark keeps it. */
export interface MarkStyle {
  /** Any CSS colour; stored as the hex a picker produced. */
  color: string
  /** Stroke width in CSS pixels, on screen and in the composed picture alike. */
  strokeWidth: number
}

/** Which picture a mark was drawn on, for the wording of its descriptor. */
export type MarkSurface = 'picture' | 'frame'

/**
 * Ceiling on the points one mark keeps.
 *
 * A slow drag can sample thousands of positions, and every one of them is
 * persisted in the composer draft and re-rendered on each frame. Samples closer
 * together than {@link MARK_MIN_STEP} are dropped as they arrive; this is the
 * backstop for a stroke that never moves far enough to trip that filter.
 */
export const MAX_MARK_POINTS = 256

/** Normalized distance below which a new sample adds nothing to a stroke. */
export const MARK_MIN_STEP = 0.004

/**
 * Pointer travel, in CSS pixels, below which a gesture is a tap.
 *
 * A tap is a comment on a place rather than a mark around an area. Measuring the
 * travel in pixels rather than in normalized units keeps that judgement the same
 * on a thumbnail-sized picture and on a full-width one, where the same
 * normalized distance covers wildly different distances on screen.
 */
export const MARK_TAP_SLOP_PX = 4

/** The badge diameter, in CSS pixels, of a numbered mark. */
export const MARK_BADGE_SIZE = 20

/**
 * The stroke width a new mark is drawn with until the user picks another.
 *
 * Literal CSS pixels, on the surface and in the composed picture: a stroke the
 * user set to 4 has to be the stroke they get, at the size they are looking at.
 * Scaling it with the picture would make the number in the control a lie.
 */
export const MARK_DEFAULT_STROKE_WIDTH = 4

/** Bounds on the stroke-width control, in CSS pixels. */
export const MARK_MIN_STROKE_WIDTH = 1
export const MARK_MAX_STROKE_WIDTH = 16

/** Colour used when the live theme cannot be read (tests, SSR). */
export const FALLBACK_MARK_COLOR = '#e5484d'

/**
 * The colour the app annotates with, read from the live theme.
 *
 * A mark is a note to the agent rather than part of the design, so it is drawn
 * in the app's own accent: it matches the numbered badges and the rest of the
 * annotation surfaces, and it is a colour the user already recognises as "this is
 * a note". Read at draw time rather than baked in, so a theme change is picked up
 * by the next mark.
 */
export function accentMarkColor(): string {
  if (typeof document === 'undefined') return FALLBACK_MARK_COLOR
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
  return value || FALLBACK_MARK_COLOR
}

/**
 * A colour a mark is drawn in: the one stored with the mark, else the accent.
 *
 * Falling back to the live accent rather than to a constant matters for the marks
 * drawn before the pen was choosable: they stored no colour, so they have to keep
 * looking like the accent marks the app has always drawn.
 */
export function markColor(value: string | undefined): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : accentMarkColor()
}

/** Clamp a stroke width into the range the control offers. */
export function clampMarkStrokeWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MARK_DEFAULT_STROKE_WIDTH
  return Math.min(MARK_MAX_STROKE_WIDTH, Math.max(MARK_MIN_STROKE_WIDTH, Math.round(value)))
}

/** Clamp a coordinate into the unit square. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function roundPoint(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * The stored form of a captured stroke.
 *
 * Out-of-range and non-finite samples are clamped rather than dropped, so a
 * pointer that left the picture and came back still draws a connected line
 * along the edge instead of a gap. Near-duplicate samples are dropped because
 * they cost bytes and render identically.
 */
export function normalizeMark(points: readonly MarkPoint[]): MarkPoint[] {
  const kept: MarkPoint[] = []
  for (const point of points) {
    const x = clampUnit(point.x)
    const y = clampUnit(point.y)
    const previous = kept[kept.length - 1]
    if (previous && Math.hypot(x - previous.x, y - previous.y) < MARK_MIN_STEP) continue
    kept.push({ x: roundPoint(x), y: roundPoint(y) })
    if (kept.length >= MAX_MARK_POINTS) break
  }
  return kept
}

/**
 * Whether a mark is a tap rather than a drawn area.
 *
 * Normalization already collapsed a stroke that never travelled far enough into
 * a single point, so one point is exactly a tap and needs no separate flag.
 */
export function isMarkTap(points: readonly MarkPoint[]): boolean {
  return points.length <= 1
}

/** The normalized bounding box a mark covers; a tap has a box of zero size. */
export function markBounds(points: readonly MarkPoint[]): {
  x: number
  y: number
  width: number
  height: number
} {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** Where a mark's numbered badge sits: its first drawn point. */
export function markBadgePoint(points: readonly MarkPoint[]): MarkPoint {
  return points[0] ?? { x: 0, y: 0 }
}

/** `"x,y x,y"` for an SVG `<polyline points>` in normalized coordinates. */
export function markPointsAttribute(points: readonly MarkPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(' ')
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

/**
 * The `text` a mark reference carries: where on the picture the mark is.
 *
 * The number the user sees on the mark is not baked in here. Labels are
 * renumbered by the store whenever a reference is removed, and the badge a mark
 * shows is that label, so the number belongs to the reference rather than to the
 * stroke   see `referenceLabelNumber` in `$lib/reference-labels`.
 *
 * A frame mark also names its moment, because the picture alone cannot say when:
 * the composed frame is an attachment beside this text, and the timecode is what
 * tells the agent which second of the file to change.
 */
export function markDescriptor(
  target: string,
  points: readonly MarkPoint[],
  options: { surface?: MarkSurface; timecode?: string } = {}
): string {
  const frame = options.surface === 'frame'
  const name = target.trim() || (frame ? 'the video' : 'the image')
  const where = frame ? 'the frame' : 'the picture'
  const at = options.timecode ? ` at ${options.timecode}` : ''
  const [point] = points
  if (isMarkTap(points)) {
    return point
      ? `Freehand mark on "${name}"${at}: a point at x ${percent(point.x)}, y ${percent(
          point.y
        )} of ${where}.`
      : `Freehand mark on "${name}"${at}.`
  }
  const bounds = markBounds(points)
  return `Freehand mark on "${name}"${at}: an area from x ${percent(
    bounds.x
  )} to ${percent(bounds.x + bounds.width)}, y ${percent(bounds.y)} to ${percent(
    bounds.y + bounds.height
  )} of ${where}.`
}
