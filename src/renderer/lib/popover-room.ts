/**
 * Room for popovers that open upward: the composer menus, the mention list, the
 * Engineering Toolbox.
 *
 * An upward-opening popover is clipped by the nearest ancestor that hides vertical
 * overflow   a dock column, a thread surface   and, in the worst case, by the top of
 * the window itself. A popover with a fixed height simply loses its first rows to that
 * clip, with no scrollbar to reach them. Sizing the popover from the room it actually
 * has is what lets it scroll inside its own box instead.
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
  const clipTop = Math.max(0, nearestClipTop(element))
  return Math.max(0, Math.floor(edgeY - clipTop - gap))
}

/**
 * Top of the nearest ancestor that clips vertical overflow, or the viewport top when
 * every ancestor lets content through. Never negative: a clipping ancestor that has
 * itself scrolled above the window can only offer room that is already off screen.
 */
function nearestClipTop(element: HTMLElement): number {
  let node = element.parentElement
  while (node) {
    if (getComputedStyle(node).overflowY !== 'visible') return node.getBoundingClientRect().top
    node = node.parentElement
  }
  return 0
}
