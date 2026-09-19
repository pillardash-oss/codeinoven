/**
 * Geometry for the thread hover popover.
 *
 * Two surfaces render this popover, the sidebar's ThreadRow and the searchable
 * ThreadSearchResultRow, and each positions it itself. The surface styling and
 * the placement math therefore live here so the box and the maths can never
 * drift apart.
 *
 * Everything is expressed in `rem` because the popover inherits the user's base
 * font size setting: both its width and the text inside it scale together, so
 * the width has to be resolved against the live root font size before it can be
 * used in the pixel based placement maths.
 */

/** Fallback root font size, used before/if the live value cannot be read. */
const ROOT_FONT_SIZE_FALLBACK_PX = 16

/**
 * Rendered popover width, padding included. Wide enough for a 24 character
 * thread id to sit on a single line next to its 4rem label with room to spare,
 * at every base font size the appearance settings allow (12px to 18px).
 */
export const THREAD_HOVER_POPOVER_WIDTH_REM = 18

/**
 * Height assumed before the popover has been measured. Only the first paint
 * uses it: the real box is measured on the next tick and the position is
 * corrected, so this only needs to be in the right neighbourhood.
 */
export const THREAD_HOVER_POPOVER_ESTIMATED_HEIGHT_REM = 21

/** Space kept between the hovered row and the popover. */
const POPOVER_GAP_PX = 8

/** Space kept between the popover and the window edges. */
const VIEWPORT_MARGIN_PX = 8

/** Current base font size in pixels, the reference every `rem` resolves against. */
function rootFontSizePx(): number {
  const resolved = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(resolved) && resolved > 0 ? resolved : ROOT_FONT_SIZE_FALLBACK_PX
}

/**
 * Popover size in CSS pixels for the current base font size, for the placement
 * maths that works on measured pixel rects.
 */
export function resolveThreadHoverPopoverSize(): { width: number; height: number } {
  const root = rootFontSizePx()
  return {
    width: THREAD_HOVER_POPOVER_WIDTH_REM * root,
    height: THREAD_HOVER_POPOVER_ESTIMATED_HEIGHT_REM * root
  }
}

/**
 * Classes for the popover surface. The width is applied through
 * `threadHoverPopoverStyle` from `THREAD_HOVER_POPOVER_WIDTH_REM` so the
 * rendered box and the placement maths read the same value.
 */
export const THREAD_HOVER_POPOVER_SURFACE_CLASS =
  'fixed z-60 max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border bg-surface p-3 shadow-lg'

/** Inline position and width for the popover surface. */
export function threadHoverPopoverStyle(x: number, y: number): string {
  return `left: ${x}px; top: ${y}px; width: ${THREAD_HOVER_POPOVER_WIDTH_REM}rem`
}

/**
 * Places the popover beside its anchor row, preferring the row's right edge and
 * flipping to the left when there is more room there, clamped to the viewport
 * on both axes so it never leaves the window.
 */
export function calculateThreadHoverPopoverPosition(
  anchor: DOMRect,
  width: number,
  height: number
): { x: number; y: number } {
  const availableRight = window.innerWidth - anchor.right - VIEWPORT_MARGIN_PX
  const availableLeft = anchor.left - VIEWPORT_MARGIN_PX
  const placeRight = availableRight >= width || availableRight >= availableLeft
  const preferredX = placeRight
    ? anchor.right + POPOVER_GAP_PX
    : anchor.left - POPOVER_GAP_PX - width
  const maxX = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - width - VIEWPORT_MARGIN_PX)
  const maxY = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - height - VIEWPORT_MARGIN_PX)

  return {
    x: Math.max(VIEWPORT_MARGIN_PX, Math.min(preferredX, maxX)),
    y: Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor.top, maxY))
  }
}
