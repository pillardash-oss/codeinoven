/** Geometry of a dragged region, independent of Electron and of the DOM. */

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Region extends Point, Size {}

/** A press that moved less than this is a click, not a selection. */
const MIN_DRAG_PX = 4

/** The box between two points, clamped to the surface, or null for a click. */
export function dragRegion(from: Point, to: Point, surface: Size): Region | null {
  const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value))
  const left = clamp(Math.min(from.x, to.x), surface.width)
  const right = clamp(Math.max(from.x, to.x), surface.width)
  const top = clamp(Math.min(from.y, to.y), surface.height)
  const bottom = clamp(Math.max(from.y, to.y), surface.height)
  if (right - left < MIN_DRAG_PX || bottom - top < MIN_DRAG_PX) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * A region of the overlay in the pixels of the frame it shows.
 *
 * The ratio is measured rather than read from the scale factor: mixed-DPI
 * monitors and a window manager that trims the overlay both make that differ.
 */
export function regionInFrame(region: Region, surface: Size, frame: Size): Region {
  const scaleX = frame.width / surface.width
  const scaleY = frame.height / surface.height
  const x = Math.min(frame.width - 1, Math.round(region.x * scaleX))
  const y = Math.min(frame.height - 1, Math.round(region.y * scaleY))
  const right = Math.min(frame.width, Math.round((region.x + region.width) * scaleX))
  const bottom = Math.min(frame.height, Math.round((region.y + region.height) * scaleY))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
