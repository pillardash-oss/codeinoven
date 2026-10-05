/**
 * Where a Peek Window comes from and goes back to, worked out in the main process.
 *
 * A peek is opened by a click inside a page, and a page is a native
 * `WebContentsView`, so the click reaches main and never the application
 * renderer. Main is therefore the only side that can say where on screen the link
 * the user clicked is, and the surface's flight is built from that answer: it
 * grows out of the link on open and shrinks back into it on close.
 *
 * Two coordinate spaces meet here, and mixing them up puts the flight in the
 * wrong corner of the window:
 *
 *   - the point Electron reports for a right-click, and the point this module
 *     derives from the pointer for the window-open gesture a shift-click
 *     produces, are in the view's own pixels, the same space `browser:show`
 *     places the native view in;
 *   - `document.elementFromPoint` in the page speaks the page's CSS pixels, which
 *     the page's own zoom factor scales away from the view's, and which are
 *     measured from the page's own corner rather than the window's.
 *
 * So the probe point is a view point divided by the page's zoom, its answer is a
 * page rectangle scaled by that zoom and then moved to where the page is on
 * screen, and every reader of the result (the open request's origin, the
 * renderer's flight, the panel it lands on) works in the window's pixels.
 */

import type { BrowserViewBounds } from '../../../lib/ipc/browser'

/** A point, in whichever space the caller is working in. */
export interface BrowserPeekPoint {
  x: number
  y: number
}

/** A rectangle, in whichever space the caller is working in. */
export interface BrowserPeekRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Upper bound on the page probe, in milliseconds.
 *
 * The probe only decides which rectangle a flight starts from, so it may never
 * hold the peek up. A page mid-navigation, a page whose document is not there
 * yet, or a page busy enough that `executeJavaScript` does not settle all wait no
 * longer than this, and the click point is used instead.
 */
export const PEEK_ORIGIN_PROBE_TIMEOUT_MS = 150

/**
 * The largest share of a page a flight may start from, per dimension.
 *
 * A link is normally a line of text, and growing the window out of that line is
 * the whole point of the animation. Some pages make a whole card, or the whole
 * page, a single anchor, and a flight out of a rectangle that size would move
 * nothing at all; a box larger than this share is cut back to a box of that size
 * around the click, which is still on the link.
 */
const MAX_ORIGIN_SHARE = 0.5

/** Side of the square a peek grows from when the page names no link, in view pixels. */
const FALLBACK_ORIGIN_SIZE = 20

/**
 * The widest picture of a page an exit flight is drawn from.
 *
 * The picture is shown shrinking from a panel that covers most of the window, so
 * it wants to be sharp at that size and no larger: it crosses the IPC boundary as
 * a base64 PNG and is decoded by the renderer on the frame the flight starts.
 */
export const PEEK_SNAPSHOT_MAX_WIDTH = 1_280

/**
 * The script that finds the link under a point.
 *
 * Deliberately anchor-only: the same probe serves a Peek opened from the page's
 * own menu, where the element under the cursor is usually the paragraph, the card
 * or the whole body, and a flight out of one of those says nothing about where
 * the user clicked. A link inside a frame leaves this document's own tree, so a
 * page that keeps its links in an iframe falls back to the click point.
 */
export function peekProbeScript(point: BrowserPeekPoint): string {
  return `(() => {
    const element = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
    const anchor = element && typeof element.closest === 'function' ? element.closest('a[href]') : null;
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  })()`
}

/**
 * Read the probe's answer, which comes from a page and is therefore untrusted:
 * anything that is not a finite rectangle is reported as no answer at all.
 */
export function parsePeekProbeAnswer(value: unknown): BrowserPeekRect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rect: BrowserPeekRect = { x: 0, y: 0, width: 0, height: 0 }
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const coordinate = record[key]
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) return null
    rect[key] = coordinate
  }
  if (rect.width <= 0 || rect.height <= 0) return null
  return rect
}

/** The page's own point for a point in the view, since a zoomed page answers in
 *  CSS pixels that its zoom factor scales away from the view's. */
export function peekProbePoint(point: BrowserPeekPoint, zoomFactor: number): BrowserPeekPoint {
  const zoom = usableZoom(zoomFactor)
  return { x: point.x / zoom, y: point.y / zoom }
}

/** `point` when it lies inside `frame`, else null. A pointer that is not over a
 *  page must never be reported as if it were, or a peek opened by a script would
 *  fly out of wherever the mouse happened to rest. */
export function peekPointInFrame(
  point: BrowserPeekPoint,
  frame: BrowserPeekRect
): BrowserPeekPoint | null {
  if (point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height) return null
  return point
}

/**
 * The rectangle a peek flight starts from, in the view's own pixels.
 *
 * The link the probe found wins, cut back to a sane share of the page and clipped
 * to the frame, so a link that is half scrolled off the top starts its flight at
 * the part on screen. Anything the probe could not answer, or answered with a
 * rectangle that is not on screen at all, becomes the click itself, widened into
 * a square: the window still grows out of the exact pixel the user pressed.
 *
 * `link` is in the page's own pixels and the answer is in the window's, which is
 * the space the caller passes `point` and `frame` in.
 */
export function resolvePeekOrigin(input: {
  /** The anchor the probe found, in the page's CSS pixels, or null. */
  link: BrowserPeekRect | null
  /** The click, in the window's pixels, inside `frame`. */
  point: BrowserPeekPoint
  /** The rectangle the page is displayed at, in the window's pixels. */
  frame: BrowserPeekRect
  /** The page's zoom factor, which turns CSS pixels back into the view's. */
  zoomFactor: number
}): BrowserViewBounds {
  const point = clampPoint(input.point, input.frame)
  const fallback = squareAround(point, FALLBACK_ORIGIN_SIZE)
  const zoom = usableZoom(input.zoomFactor)
  const link = input.link
    ? capAroundPoint(placeAtFrame(scaleRect(input.link, zoom), input.frame), point, input.frame)
    : null
  const clipped = intersectRect(link ?? fallback, input.frame)
  const box =
    clipped && clipped.width >= 1 && clipped.height >= 1
      ? clipped
      : intersectRect(fallback, input.frame)
  const final = box && box.width >= 1 && box.height >= 1 ? box : { ...point, width: 1, height: 1 }
  return {
    x: Math.round(final.x),
    y: Math.round(final.y),
    width: Math.max(1, Math.round(final.width)),
    height: Math.max(1, Math.round(final.height))
  }
}

function usableZoom(zoomFactor: number): number {
  return Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
}

function scaleRect(rect: BrowserPeekRect, zoom: number): BrowserPeekRect {
  return {
    x: rect.x * zoom,
    y: rect.y * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom
  }
}

/** Move a rectangle of the page's own space to where the page is on screen, so
 *  it can be compared with anything in the window's. */
function placeAtFrame(rect: BrowserPeekRect, frame: BrowserPeekRect): BrowserPeekRect {
  return { x: rect.x + frame.x, y: rect.y + frame.y, width: rect.width, height: rect.height }
}

function squareAround(point: BrowserPeekPoint, size: number): BrowserPeekRect {
  return { x: point.x - size / 2, y: point.y - size / 2, width: size, height: size }
}

function clampPoint(point: BrowserPeekPoint, frame: BrowserPeekRect): BrowserPeekPoint {
  return {
    x: Math.min(Math.max(point.x, frame.x), frame.x + Math.max(0, frame.width - 1)),
    y: Math.min(Math.max(point.y, frame.y), frame.y + Math.max(0, frame.height - 1))
  }
}

/** Cut a rectangle down to `MAX_ORIGIN_SHARE` of the frame per dimension, keeping
 *  the click inside it. A rectangle already below the cap is returned untouched. */
function capAroundPoint(
  rect: BrowserPeekRect,
  point: BrowserPeekPoint,
  frame: BrowserPeekRect
): BrowserPeekRect {
  const maxWidth = frame.width * MAX_ORIGIN_SHARE
  const maxHeight = frame.height * MAX_ORIGIN_SHARE
  const width = Math.min(rect.width, maxWidth)
  const height = Math.min(rect.height, maxHeight)
  if (width === rect.width && height === rect.height) return rect
  // Anchored on the click rather than on the rectangle's own corner: the click is
  // the one point of the link the user is certain about, and it is inside both.
  return {
    x: Math.min(Math.max(point.x - width / 2, rect.x), rect.x + rect.width - width),
    y: Math.min(Math.max(point.y - height / 2, rect.y), rect.y + rect.height - height),
    width,
    height
  }
}

function intersectRect(a: BrowserPeekRect, b: BrowserPeekRect): BrowserPeekRect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}
