/**
 * Scroll anchoring for conversation views.
 *
 * The conversation scroll container follows one contract, and every scroll
 * regression in this app has come from violating part of it:
 *
 * 1. A thread always opens at the live bottom — the latest message.
 * 2. While the reader is still at the bottom, new content (streaming turns,
 *    markdown and images finishing rendering, cards resolving) re-anchors
 *    them to the bottom. No timers, no animation-frame loops — the viewport
 *    only ever moves when the content itself changes size.
 * 3. The first upward scroll or wheel tick detaches the reader: from that
 *    moment the viewport is never moved again until they explicitly jump
 *    back to the latest message.
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
 *  bottom — the state in which new content may re-anchor the reader. */
export function isAtLatest(extents: ScrollExtents): boolean {
  return (
    extents.scrollHeight - extents.scrollTop - extents.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  )
}

/** Whether a content resize may move the viewport. A detached reader —
 *  someone who scrolled up to read history — is never fought: their viewport
 *  stays exactly where they put it while new content arrives. */
export function mayReanchorToLatest(detached: boolean): boolean {
  return !detached
}
