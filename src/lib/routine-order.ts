import type { Routine } from './types'

/**
 * Routine sidebar order.
 *
 * A routine only moves when the user moves it. Editing one (its name, how-to,
 * icon, schedule, connections, or the model the authoring flow keeps in step)
 * leaves its position alone, and a run never touches the routine at all.
 *
 * Position is the manual `sortOrder` once the user has dragged the list into an
 * arrangement, and the creation time otherwise, so an untouched list reads
 * newest-created first. `RoutineManager.createRoutine` places a routine created
 * after an arrangement above it, which keeps that reading true.
 *
 * Pinned routines group above the rest, newest pin first, exactly as the
 * project sidebar treats pinned projects. Pinning is an explicit user action,
 * so it is the one other thing that moves a row.
 */
export function routineOrderKey(routine: Routine): number {
  return routine.sortOrder ?? routine.createdAt
}

/** Sidebar order for two routines: pins, then manual position, then creation. */
export function compareRoutines(a: Routine, b: Routine): number {
  const aPinned = a.pinned ? 1 : 0
  const bPinned = b.pinned ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned
  if (aPinned) {
    const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    if (pinDiff !== 0) return pinDiff
  }
  const positionDiff = routineOrderKey(a) - routineOrderKey(b)
  if (positionDiff !== 0) return positionDiff
  const createdDiff = b.createdAt - a.createdAt
  if (createdDiff !== 0) return createdDiff
  return a.id.localeCompare(b.id)
}

/**
 * The routines in sidebar order. Both processes sort through this, so the main
 * process's list and the sidebar it renders can never disagree about what the
 * order is.
 */
export function sortRoutines(routines: readonly Routine[]): Routine[] {
  return [...routines].sort(compareRoutines)
}
