import { isBoundAssistantTask } from '$shared/bound-scope'
import type { Thread } from '$shared/types'

/**
 * How a project-board row states that an assistant dispatched it.
 *
 * Origin is written once, on the row itself, when the dispatch is accepted. The
 * badge therefore reads a persisted fact rather than inferring one from a colour,
 * a status, or the dispatch ledger, and it can never drift from the dispatch that
 * actually created the thread.
 *
 * The badge states origin only. What the thread is doing is the row's status
 * indicator's job, and repeating it here would make one row say two things.
 */

export interface DispatchBadge {
  /** Visible text, and the badge's whole claim. */
  label: string
  /** The same claim in a full sentence, for the tooltip and the accessible name. */
  title: string
}

/** The badge a row wears, or `null` for a thread nobody dispatched. */
export function dispatchBadgeFor(thread: Thread): DispatchBadge | null {
  const origin = thread.dispatchOrigin
  if (!origin) return null
  const name = origin.assistantName?.trim()
  if (name) {
    return {
      label: `Dispatched by ${name}`,
      title: `This thread was dispatched by the assistant ${name}.`
    }
  }
  return {
    label: 'Dispatched',
    title: 'This thread was dispatched by an assistant.'
  }
}

/**
 * Whether a thread belongs on a project's board.
 *
 * A bound assistant task keeps its single home on the Assistant view even though
 * it works in the project's checkout, so it is never cross-listed onto that
 * project's board. Only a real project thread does, which is what an orchestrated
 * dispatch creates. One transcript therefore appears on exactly one board.
 */
export function belongsOnProjectBoard(thread: Thread, projectId: string): boolean {
  if (thread.projectId !== projectId) return false
  return !isBoundAssistantTask(thread)
}

/** The board's thread set for one project: one row per transcript, no bound tasks. */
export function boardThreadsFor(threads: readonly Thread[], projectId: string): Thread[] {
  const seen = new Set<string>()
  const rows: Thread[] = []
  for (const thread of threads) {
    if (!belongsOnProjectBoard(thread, projectId)) continue
    if (seen.has(thread.id)) continue
    seen.add(thread.id)
    rows.push(thread)
  }
  return rows
}
