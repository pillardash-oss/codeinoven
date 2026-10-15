import type { Assistant } from './types'

/**
 * Assistant sidebar order.
 *
 * An assistant only moves when the user moves it. Editing one (its name, knowledge,
 * icon, schedule, connections, or the model the authoring flow keeps in step)
 * leaves its position alone, and a run never touches the assistant at all.
 *
 * Position is the manual `sortOrder` once the user has dragged the list into an
 * arrangement, and the creation time otherwise, so an untouched list reads
 * newest-created first. `AssistantManager.createAssistant` places an assistant created
 * after an arrangement above it, which keeps that reading true.
 *
 * Pinned assistants group above the rest, newest pin first, exactly as the
 * project sidebar treats pinned projects. Pinning is an explicit user action,
 * so it is the one other thing that moves a row.
 */
export function assistantOrderKey(assistant: Assistant): number {
  return assistant.sortOrder ?? assistant.createdAt
}

/** Sidebar order for two assistants: pins, then manual position, then creation. */
export function compareAssistants(a: Assistant, b: Assistant): number {
  const aPinned = a.pinned ? 1 : 0
  const bPinned = b.pinned ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned
  if (aPinned) {
    const pinDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
    if (pinDiff !== 0) return pinDiff
  }
  const positionDiff = assistantOrderKey(a) - assistantOrderKey(b)
  if (positionDiff !== 0) return positionDiff
  const createdDiff = b.createdAt - a.createdAt
  if (createdDiff !== 0) return createdDiff
  return a.id.localeCompare(b.id)
}

/**
 * The assistants in sidebar order. Both processes sort through this, so the main
 * process's list and the sidebar it renders can never disagree about what the
 * order is.
 */
export function sortAssistants(assistants: readonly Assistant[]): Assistant[] {
  return [...assistants].sort(compareAssistants)
}
