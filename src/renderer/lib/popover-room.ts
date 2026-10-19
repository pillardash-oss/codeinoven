/**
 * Room for popovers that open upward: the composer menus, the mention list, the
 * Engineering Toolbox.
 *
 * An upward-opening popover is clipped by the nearest ancestor that hides vertical
 * overflow   a dock column, a thread surface   and, in the worst case, by the top of
 * the window itself. A popover with a fixed height simply loses its first rows to that
 * clip, with no scrollbar to reach them. Sizing the popover from the room it actually
 * has is what lets it scroll inside its own box instead.
 *
 * A popover whose box the app does not own the room for   the shoe's own readings, which
 * open from a composer that any pane may narrow   is portaled and positioned by the
 * app's overlay primitive instead, so that no ancestor can clip it at all.
 */

/**
 * The room an upward-opening popover has, in pixels: the distance from `edgeY`, the y
 * the popover's bottom edge sits at, up to the top of the nearest clipping ancestor of
 * `element`, minus `gap`.
 *
 * The edge is passed in rather than read from `element` so this works for both shapes an
 * upward popover takes here: one anchored to the top of a sibling trigger, and one that
 * is bottom-anchored and therefore opens from its own bottom edge. Measuring the edge
 * rather than the popover's height also keeps that height from feeding back into the
 * number. `gap` is the clearance the popover keeps from the edge it opens toward.
 */
export function roomAbove(element: HTMLElement, edgeY: number, gap: number): number {
  return Math.max(0, Math.floor(edgeY - nearestClipBounds(element).top - gap))
}

/**
 * Where an upward popover's box ends at the top: the nearest ancestor that clips
 * overflow, or the window's own top where every ancestor lets content through. Never
 * above the window: a clipping ancestor that has itself scrolled above it can only
 * offer room already off screen.
 */
interface ClipBounds {
  top: number
}

function nearestClipBounds(element: HTMLElement): ClipBounds {
  const bounds: ClipBounds = { top: 0 }
  let clipped = false
  let node = element.parentElement
  while (node && !clipped) {
    if (getComputedStyle(node).overflowY !== 'visible') {
      bounds.top = node.getBoundingClientRect().top
      clipped = true
    }
    node = node.parentElement
  }
  bounds.top = Math.max(0, bounds.top)
  return bounds
}
