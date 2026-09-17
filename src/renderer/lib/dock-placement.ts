/**
 * Edge snapping for docked panels: the minimized dock chip rows that float above
 * the workspace.
 *
 * A dock row is draggable anywhere on screen; when the user lets go it snaps to
 * the nearest viewport edge and stays there, so a dock that overlaps the browser
 * or another dock can be pulled out of the way. Each dock remembers its
 * placement per owner key in localStorage, which is what makes the spot survive
 * an app restart.
 *
 * The placement is a pure function of the dock's size, the viewport, and the
 * saved edge/offset, so the component only owns the gesture and this module owns
 * the geometry. Every dock surface (the dockable modal, the PR dock, the
 * worktree dock) funnels through here instead of re-deriving snap math.
 */

/** The viewport edges a dock row can snap to. */
export type DockEdge = 'top' | 'right' | 'bottom' | 'left'

/** A dock row's measured footprint. */
export interface DockSize {
  width: number
  height: number
}

/** A dock row's on-screen rectangle, in viewport pixels. */
export interface DockBox extends DockSize {
  x: number
  y: number
}

/** The viewport the dock row is placed in. */
export interface DockViewport {
  width: number
  height: number
}

/**
 * Where a dock row sits: the edge it is snapped to, plus where along that edge
 * its center is. `offset` is in px on the edge axis (y for the left/right edges,
 * x for the top/bottom edges). `null` means the row has never been moved and is
 * pinned to the far end of the bottom edge, the bottom-right corner every dock
 * starts in.
 */
export interface DockPlacement {
  edge: DockEdge
  offset: number | null
}

/** Gap a dock row keeps from the viewport edge it is snapped to. */
export const DOCK_MARGIN = 16

export const DEFAULT_DOCK_PLACEMENT: DockPlacement = { edge: 'bottom', offset: null }

/** Suffix appended to the owner's storage key for the saved placement. */
const PLACEMENT_KEY_SUFFIX = '.dockPlacement'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

/** Whether `edge` runs vertically, so its dock extent is the row's height. */
function isVertical(edge: DockEdge): boolean {
  return edge === 'left' || edge === 'right'
}

/** The dock's extent along the edge it is snapped to. */
function extentAlong(edge: DockEdge, size: DockSize): number {
  return isVertical(edge) ? size.height : size.width
}

/** The viewport's extent along that same axis. */
function axisExtent(edge: DockEdge, viewport: DockViewport): number {
  return isVertical(edge) ? viewport.height : viewport.width
}

/** The dock's center along its edge axis. */
function centerAlong(edge: DockEdge, box: DockBox): number {
  return isVertical(edge) ? box.y + box.height / 2 : box.x + box.width / 2
}

/**
 * The centers a dock of `length` may take along an axis of `axis` without
 * leaving the viewport, margins included. When the dock is longer than the
 * viewport the maximum collapses onto the minimum, so it stays pinned at the
 * start edge instead of drifting off screen.
 */
function centerRange(edge: DockEdge, length: number, axis: number): { min: number; max: number } {
  const min = DOCK_MARGIN + length / 2
  return { min, max: Math.max(min, axis - DOCK_MARGIN - length / 2) }
}

/** The rectangle `placement` puts the dock row in. */
export function dockBox(placement: DockPlacement, size: DockSize, viewport: DockViewport): DockBox {
  const edge = placement.edge
  const length = extentAlong(edge, size)
  const range = centerRange(edge, length, axisExtent(edge, viewport))
  const center =
    placement.offset === null ? range.max : clamp(placement.offset, range.min, range.max)
  const start = center - length / 2

  if (isVertical(edge)) {
    return {
      x: edge === 'left' ? DOCK_MARGIN : viewport.width - size.width - DOCK_MARGIN,
      y: start,
      width: size.width,
      height: size.height
    }
  }
  return {
    x: start,
    y: edge === 'top' ? DOCK_MARGIN : viewport.height - size.height - DOCK_MARGIN,
    width: size.width,
    height: size.height
  }
}

/** Keep a dragged dock fully on screen, its edge margins included. */
export function clampDockPosition(
  x: number,
  y: number,
  size: DockSize,
  viewport: DockViewport
): { x: number; y: number } {
  return {
    x: clamp(x, DOCK_MARGIN, viewport.width - size.width - DOCK_MARGIN),
    y: clamp(y, DOCK_MARGIN, viewport.height - size.height - DOCK_MARGIN)
  }
}

/** The edge whose line is closest to the dock's center. */
export function nearestDockEdge(box: DockBox, viewport: DockViewport): DockEdge {
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2
  const distances: Array<{ edge: DockEdge; distance: number }> = [
    { edge: 'left', distance: centerX },
    { edge: 'right', distance: viewport.width - centerX },
    { edge: 'top', distance: centerY },
    { edge: 'bottom', distance: viewport.height - centerY }
  ]
  return distances.reduce((nearest, candidate) =>
    candidate.distance < nearest.distance ? candidate : nearest
  ).edge
}

/** The placement that snaps the dock row to `edge` where it currently sits. */
export function dockPlacementOnEdge(
  edge: DockEdge,
  box: DockBox,
  viewport: DockViewport
): DockPlacement {
  const range = centerRange(edge, extentAlong(edge, box), axisExtent(edge, viewport))
  return { edge, offset: clamp(centerAlong(edge, box), range.min, range.max) }
}

/** The placement a dock row takes when the user lets go of it. */
export function dockPlacementForDrop(box: DockBox, viewport: DockViewport): DockPlacement {
  return dockPlacementOnEdge(nearestDockEdge(box, viewport), box, viewport)
}

function isDockEdge(value: unknown): value is DockEdge {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
}

function placementKey(ownerKey: string): string {
  return `${ownerKey}${PLACEMENT_KEY_SUFFIX}`
}

/** Read a dock's saved placement, falling back to the bottom-right default. */
export function loadDockPlacement(ownerKey: string): DockPlacement {
  if (typeof window === 'undefined') return DEFAULT_DOCK_PLACEMENT
  try {
    const raw = window.localStorage.getItem(placementKey(ownerKey))
    if (!raw) return DEFAULT_DOCK_PLACEMENT
    const parsed = JSON.parse(raw) as Partial<DockPlacement>
    if (!isDockEdge(parsed.edge)) return DEFAULT_DOCK_PLACEMENT
    const offset = parsed.offset
    return {
      edge: parsed.edge,
      offset: typeof offset === 'number' && Number.isFinite(offset) ? offset : null
    }
  } catch {
    return DEFAULT_DOCK_PLACEMENT
  }
}

/** Remember a dock's placement so it is still there after a restart. */
export function saveDockPlacement(ownerKey: string, placement: DockPlacement): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(placementKey(ownerKey), JSON.stringify(placement))
  } catch {
    // Placement is cosmetic; unavailable storage must not break the app.
  }
}
