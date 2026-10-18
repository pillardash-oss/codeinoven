/**
 * Room for popovers that open upward: the composer menus, the mention list, the
 * Engineering Toolbox, and the composer shoe's own readings.
 *
 * An upward-opening popover is clipped by the nearest ancestor that hides overflow   a
 * dock column, a thread surface   and, in the worst case, by the top or the side of the
 * window itself. A popover with a fixed width or height simply loses the content outside
 * that clip, with no scrollbar to reach it. Sizing the popover from the room it actually
 * has is what keeps it whole.
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

/** Clearance a sized popover keeps from every edge it opens toward, in pixels. */
export const POPOVER_EDGE_GAP = 8

/**
 * Where the panel caps its own height from, as set by `sizeUpwardPopover`. The
 * popover shell reads it on its frame, so the panel scrolls inside the height the
 * trigger actually has above it rather than a guess that the top of the window then
 * clips away.
 */
export const POPOVER_MAX_HEIGHT_VAR = '--popover-max-height'

/**
 * The edges a popover is bounded by: the nearest ancestor that clips it, or the
 * window. Read as one pass so a popover that is clipped horizontally and vertically
 * by different ancestors still takes both limits.
 */
interface ClipBounds {
  left: number
  right: number
  top: number
}

/**
 * The nearest ancestor that clips overflow on each axis, or the window's own edges
 * where every ancestor lets content through. Never above the window: a clipping
 * ancestor that has itself scrolled above it can only offer room already off screen.
 */
function nearestClipBounds(element: HTMLElement): ClipBounds {
  const bounds: ClipBounds = { left: 0, right: window.innerWidth, top: 0 }
  let clippedX = false
  let clippedY = false
  let node = element.parentElement
  while (node && !(clippedX && clippedY)) {
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    if (!clippedX && style.overflowX !== 'visible') {
      bounds.left = rect.left
      bounds.right = rect.right
      clippedX = true
    }
    if (!clippedY && style.overflowY !== 'visible') {
      bounds.top = rect.top
      clippedY = true
    }
    node = node.parentElement
  }
  bounds.top = Math.max(0, bounds.top)
  return bounds
}

export interface PopoverRoomOptions {
  /** Clearance kept from the edges the popover opens toward. */
  gap?: number
}

/**
 * Sizes a popover that hangs off its trigger's top-right corner (`absolute
 * bottom-full right-0`) from the room it actually has.
 *
 * Its width is capped to the nearer side's room, and the popover turns over to the
 * trigger's left edge when the right side is the roomier one. Its height is published
 * as `POPOVER_MAX_HEIGHT_VAR` for the panel to cap and scroll inside. Nothing here
 * reads the panel's height, so a panel that scrolls cannot feed its own size back into
 * the measurement.
 *
 * Call it again whenever the space can have changed without a window resize   most
 * importantly just before a panel is shown, since a dock column is dragged rather than
 * resized.
 */
export function sizeUpwardPopover(node: HTMLElement, options: PopoverRoomOptions = {}): void {
  const gap = options.gap ?? POPOVER_EDGE_GAP
  // Measure the popover in its own default state: the width its layout asks for and
  // the edge it hangs from, before this pass caps or turns it.
  node.style.maxWidth = ''
  node.style.left = ''
  node.style.right = ''
  const rect = node.getBoundingClientRect()
  if (rect.width === 0) return
  const width = Math.ceil(rect.width)
  const bounds = nearestClipBounds(node)
  const roomLeft = Math.max(0, Math.floor(rect.right - bounds.left - gap))
  const roomRight = Math.max(0, Math.floor(bounds.right - rect.left - gap))
  // Stay on the side the popover already opens from unless it cannot hold the panel
  // at all and the other side can do better.
  const flipped = roomLeft < width && roomRight > roomLeft
  node.style.maxWidth = `${Math.min(width, flipped ? roomRight : roomLeft)}px`
  if (flipped) {
    node.style.left = '0'
    node.style.right = 'auto'
  }
  node.style.setProperty(
    POPOVER_MAX_HEIGHT_VAR,
    `${Math.max(0, Math.floor(rect.bottom - bounds.top - gap))}px`
  )
}
