/**
 * Where the toaster renders while the in-app browser's page is on screen.
 *
 * The page is a native `WebContentsView` and it composites above every DOM node
 * of the window (see `browser-visibility.svelte.ts`), so the toaster's usual top
 * right corner is covered by a page whenever one is showing. Moving the toast is
 * the alternative to detaching the page, which is what the app used to do and
 * what blanked the browser for the lifetime of every toast.
 *
 * The lanes, in the order they are tried, with the geometry each one assumes:
 *
 *   right         356 wide, 24 from the window's right edge   the normal lane
 *   left          356 wide, 12 clear of the 40px view rail
 *   narrow-right  anchored right, grown inward until it reaches a page edge
 *   narrow-left   anchored left, grown outward to a page edge
 *   compact       one line, inside the 48px application header
 *
 * Only one band of the window is guaranteed free: the header, because the page
 * is placed inside `main`, below it (`src/renderer/App.svelte`). The compact lane
 * is therefore always available, which is why no layout can leave a toast
 * covered.
 *
 * Everything here is a pure function of the window's width and the frames that
 * are on screen, so the lane re-resolves exactly when one of those changes and
 * never on its own.
 */

import type { BrowserViewBounds } from '$shared/ipc-contract'

/** The application's view rail, at the window's left edge. */
const RAIL_WIDTH = 40

/** Clearance kept between a lane and the rail, and between a lane and a page. */
const LANE_GAP = 12

/** The toaster's own distance from the window edge, from its `offset` prop. */
const EDGE_OFFSET = 24

/** The toaster's own distance from the top of the window, from its `offset` prop. */
const LANE_TOP = 56

/**
 * The height a lane is assumed to need.
 *
 * A lane is picked before a card is measured, so this is deliberately taller than
 * any card this app builds (icon row, description, full width action button).
 * Over-reserving only moves the toast to a narrower lane sooner; under-reserving
 * would let a card poke into the page below the lane.
 */
const LANE_PROBE_HEIGHT = 160

/** The toast card's width at full size, from svelte-sonner's `TOAST_WIDTH`. */
export const TOAST_WIDTH = 356

/** Below this a card stops reading as a card, so a lane this narrow is not used. */
const MIN_LANE_WIDTH = 200

/** Clearance the compact lane keeps from both window edges. */
const COMPACT_MARGIN = 48

/** The lanes the toaster can render in. */
export type ToastLane = 'right' | 'left' | 'narrow-right' | 'narrow-left' | 'compact'

/** The lane to render in, and the width to render it at. */
export interface ToastLanePlacement {
  lane: ToastLane
  /** Card width in CSS pixels, published to CSS as `--toast-lane-width`. */
  width: number
}

function intersects(a: BrowserViewBounds, b: BrowserViewBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function laneAt(x: number, width: number): BrowserViewBounds {
  return { x, y: LANE_TOP, width, height: LANE_PROBE_HEIGHT }
}

/**
 * The lane to render in, given the window's width and every native rectangle on
 * screen.
 *
 * Full width lanes are tested before narrow ones, so the toast only shrinks when
 * no page-free band is wide enough for it. A page parked offscreen is not in
 * `frames` at all, which is what keeps this from reacting to a view nobody can
 * see.
 */
export function resolveToastLane(
  viewportWidth: number,
  frames: readonly BrowserViewBounds[]
): ToastLanePlacement {
  const width = Math.round(viewportWidth)
  if (frames.length === 0) return { lane: 'right', width: TOAST_WIDTH }

  const rightEdge = width - EDGE_OFFSET
  const leftEdge = RAIL_WIDTH + LANE_GAP
  const right = laneAt(rightEdge - TOAST_WIDTH, TOAST_WIDTH)
  if (!frames.some((frame) => intersects(frame, right))) {
    return { lane: 'right', width: TOAST_WIDTH }
  }
  const left = laneAt(leftEdge, TOAST_WIDTH)
  if (!frames.some((frame) => intersects(frame, left))) {
    return { lane: 'left', width: TOAST_WIDTH }
  }

  // Neither side has room for a full width card, so grow one from each window
  // edge until it meets the nearest page. The two limits are the extremes over
  // every frame, which is the conservative answer when pages sit on both sides.
  const rightLimit = Math.max(...frames.map((frame) => frame.x + frame.width)) + LANE_GAP
  const leftLimit = Math.min(...frames.map((frame) => frame.x)) - LANE_GAP
  const rightWidth = rightEdge - rightLimit
  const leftWidth = leftLimit - leftEdge

  if (rightWidth >= leftWidth && rightWidth >= MIN_LANE_WIDTH) {
    return { lane: 'narrow-right', width: Math.min(TOAST_WIDTH, rightWidth) }
  }
  if (leftWidth >= MIN_LANE_WIDTH) {
    return { lane: 'narrow-left', width: Math.min(TOAST_WIDTH, leftWidth) }
  }

  // No side of the page has room: the application header is the one band a page
  // can never reach, so the toast goes there as a single line.
  return {
    lane: 'compact',
    width: Math.min(TOAST_WIDTH, Math.max(MIN_LANE_WIDTH, width - COMPACT_MARGIN * 2))
  }
}
