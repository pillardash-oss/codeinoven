import type { Thread } from './types'

/**
 * Where the reader should land when the thread on screen is deleted.
 *
 * Two subscribers hear `thread:deleted`: the workspace's own (registered first,
 * because the workspace mounts before the shell wires its channels) and the
 * app-level one, which owns the navigation. They must reach the same answer or
 * the first one wins by clearing the selection before the second can rescue it,
 * which is what dropped the reader on an empty shell while the thread that should
 * have replaced theirs was still reachable.
 *
 * This is a property of the deleted thread alone, so both callers can ask it
 * without reading any scheduling, selection or view state.
 */
export type DeletedThreadLanding =
  /** An auditor belongs to the Sr. Engineer thread it audits. */
  | { kind: 'coordinator'; threadId: string }
  /** An assistant task or run belongs to the assistant's own knowledge thread. */
  | { kind: 'assistant'; assistantId: string }
  /** Nothing owns this thread, so the reader has nowhere to go. */
  | { kind: 'none' }

export function deletedThreadLanding(
  thread: Pick<Thread, 'assistantId' | 'achievementRole' | 'coordinatorThreadId'>
): DeletedThreadLanding {
  // The coordinator wins over the assistant owner: an auditor also carries the
  // assistant it belongs to, and the Sr. Engineer is the thread that holds the
  // work the auditor was doing.
  if (thread.achievementRole === 'auditor' && thread.coordinatorThreadId) {
    return { kind: 'coordinator', threadId: thread.coordinatorThreadId }
  }
  if (thread.assistantId) return { kind: 'assistant', assistantId: thread.assistantId }
  return { kind: 'none' }
}
