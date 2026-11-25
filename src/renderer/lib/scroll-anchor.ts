/**
 * Scroll anchoring for conversation views.
 *
 * The conversation scroll container follows one contract, and every scroll
 * regression in this app has come from violating part of it:
 *
 * 1. A thread always opens at the live bottom   the latest message.
 * 2. While the reader is still at the bottom, new content (streaming turns,
 *    markdown and images finishing rendering, cards resolving) re-anchors
 *    them to the bottom. No timers, no animation-frame loops   the viewport
 *    only ever moves when the content itself changes size.
 * 3. The first upward scroll or wheel tick detaches the reader: from that
 *    moment the viewport is never moved again until they explicitly jump
 *    back to the latest message.
 * 4. Sitting on the true bottom always counts as attached, whatever moved
 *    the viewport there. Content shrinking above a reader pinned to the
 *    bottom is clamped by the browser to the new bottom, and that clamp
 *    raises `scrollTop` without the reader travelling anywhere; reading it
 *    as an upward scroll is what left a reader who had just scrolled to the
 *    latest message detached from a tail that never came back.
 */

/** Distance (px) from the live bottom within which the viewport still counts
 *  as reading the latest message. Large enough to absorb rounding and
 *  trackpad inertia, small enough that a deliberate upward scroll beyond it
 *  detaches. */
export const SCROLL_AT_BOTTOM_THRESHOLD = 48

/** The scroll geometry a decision needs, shaped like the DOM so call sites
 *  can pass an element directly. */
export interface ScrollExtents {
  readonly scrollHeight: number
  readonly scrollTop: number
  readonly clientHeight: number
}

/** True when the viewport is at (or within a small tolerance of) the live
 *  bottom   the state in which new content may re-anchor the reader. */
export function isAtLatest(extents: ScrollExtents): boolean {
  return (
    extents.scrollHeight - extents.scrollTop - extents.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  )
}

/** Whether a content resize may move the viewport. A detached reader
 *  someone who scrolled up to read history   is never fought: their viewport
 *  stays exactly where they put it while new content arrives. */
export function mayReanchorToLatest(detached: boolean): boolean {
  return !detached
}

/** Slack (px) under which a scroll position *is* the bottom: a rounding error
 *  or a sub-pixel clamp, never travel. */
const AT_TRUE_BOTTOM_SLACK = 1

/** True when no scrollable distance is left below the viewport, i.e. the
 *  viewport sits on the true bottom rather than inside the reading band.
 *  Content shorter than the viewport counts as the bottom too. */
export function isAtTrueLatest(extents: ScrollExtents): boolean {
  return extents.scrollHeight - extents.scrollTop - extents.clientHeight <= AT_TRUE_BOTTOM_SLACK
}

/** Whether one scroll event detaches the reader from the live tail.
 *
 *  An upward move inside the reading band detaches, so a trackpad nudge is
 *  never grabbed back by the tail follower. The one exception is the true
 *  bottom: the browser clamps there whenever content above shrinks (a folding
 *  trace, a re-measuring picture), and that clamp raises `scrollTop` exactly
 *  like a scroll does. A reader the clamp left on the bottom is still reading
 *  the latest message, so they stay attached   that is also what re-attaches
 *  someone who manually scrolled back down. */
export function scrollDetachesFromLatest(movedUp: boolean, extents: ScrollExtents): boolean {
  if (isAtTrueLatest(extents)) return false
  return movedUp || !isAtLatest(extents)
}
