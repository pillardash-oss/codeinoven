/**
 * Freehand image marks: the pure half.
 *
 * A mark is a stroke the user draws on an image an inline artifact published.
 * Every point is normalized to 0..1 of the picture, so the mark survives a
 * re-render at any size and is stored without depending on the layout it was
 * drawn in. Nothing here touches the DOM: the conversation overlay and the
 * send-time rasteriser both render these same normalized points, which is what
 * keeps the mark the user sees and the mark the agent receives in step.
 */

/** One point of a mark, normalized to 0..1 of the image box. */
export interface ImageMarkPoint {
  x: number
  y: number
}

/**
 * Ceiling on the points one mark keeps.
 *
 * A slow drag can sample thousands of positions, and every one of them is
 * persisted in the composer draft and re-rendered on each frame. Samples closer
 * together than {@link IMAGE_MARK_MIN_STEP} are dropped as they arrive; this is
 * the backstop for a stroke that never moves far enough to trip that filter.
 */
export const MAX_IMAGE_MARK_POINTS = 256

/** Normalized distance below which a new sample adds nothing to a stroke. */
export const IMAGE_MARK_MIN_STEP = 0.004

/**
 * Pointer travel, in CSS pixels, below which a gesture is a tap.
 *
 * A tap is a comment on a place rather than a mark around an area. Measuring the
 * travel in pixels rather than in normalized units keeps that judgement the same
 * on a thumbnail-sized picture and on a full-width one, where the same
 * normalized distance covers wildly different distances on screen.
 */
export const IMAGE_MARK_TAP_SLOP_PX = 4

/** The stroke width, in CSS pixels, of a drawn mark in the conversation. */
export const IMAGE_MARK_STROKE_WIDTH = 2.5

/** The badge diameter, in CSS pixels, of a numbered mark. */
export const IMAGE_MARK_BADGE_SIZE = 20

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
export function normalizeImageMark(points: readonly ImageMarkPoint[]): ImageMarkPoint[] {
  const kept: ImageMarkPoint[] = []
  for (const point of points) {
    const x = clampUnit(point.x)
    const y = clampUnit(point.y)
    const previous = kept[kept.length - 1]
    if (previous && Math.hypot(x - previous.x, y - previous.y) < IMAGE_MARK_MIN_STEP) continue
    kept.push({ x: roundPoint(x), y: roundPoint(y) })
    if (kept.length >= MAX_IMAGE_MARK_POINTS) break
  }
  return kept
}

/**
 * Whether a mark is a tap rather than a drawn area.
 *
 * Normalization already collapsed a stroke that never travelled far enough into
 * a single point, so one point is exactly a tap and needs no separate flag.
 */
export function isImageMarkTap(points: readonly ImageMarkPoint[]): boolean {
  return points.length <= 1
}

/** The normalized bounding box a mark covers; a tap has a box of zero size. */
export function imageMarkBounds(points: readonly ImageMarkPoint[]): {
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
export function imageMarkBadgePoint(points: readonly ImageMarkPoint[]): ImageMarkPoint {
  return points[0] ?? { x: 0, y: 0 }
}

/** `"x,y x,y"` for an SVG `<polyline points>` in normalized coordinates. */
export function imageMarkPointsAttribute(points: readonly ImageMarkPoint[]): string {
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
 * stroke. `referenceMarkNumber` recovers it from the label at render time.
 */
export function imageMarkDescriptor(filename: string, points: readonly ImageMarkPoint[]): string {
  const name = filename.trim() || 'the image'
  const [point] = points
  if (isImageMarkTap(points)) {
    return point
      ? `Freehand mark on "${name}": a point at x ${percent(point.x)}, y ${percent(point.y)} of the picture.`
      : `Freehand mark on "${name}".`
  }
  const bounds = imageMarkBounds(points)
  return `Freehand mark on "${name}": an area from x ${percent(bounds.x)} to ${percent(
    bounds.x + bounds.width
  )}, y ${percent(bounds.y)} to ${percent(bounds.y + bounds.height)} of the picture.`
}

/**
 * The number a reference displays.
 *
 * A mark's badge and the prompt block that names it both read this, so the `1`
 * drawn on the screenshot is the `[Mark 1]` the agent is asked to address. The
 * store numbers labels by position; a label that carries no trailing number
 * (a hand-written one, a restored older draft) falls back to the position.
 */
export function referenceMarkNumber(label: string, position: number): number {
  const match = /(\d+)\s*$/u.exec(label)
  return match ? Number(match[1]) : position + 1
}
