import type { Thread } from '$shared/types'
import { threadStatusPolicy } from '$shared/thread-status-policy'
import type { ActionStatusBadge } from '$lib/actions/types'

/**
 * Canonical mapping from a thread's resolved state to a command-palette status
 * badge. Mirrors the StatusBadge selectors used by ThreadRow so every thread
 * surface stays colour-consistent. `isWorking` should already reflect any
 * live-settled run state (see agentRuns) so a planning/executing thread shows
 * the spinner instead of a stale persisted status.
 */
export function statusBadgeForThread(thread: Thread, isWorking: boolean): ActionStatusBadge | null {
  if (isWorking) {
    return {
      label: thread.status === 'planning' ? 'Working · Planning' : 'Working',
      tone: 'working',
      variant: 'spinner'
    }
  }

  switch (thread.status) {
    case 'working-paused':
      return { label: 'Waiting to retry', tone: 'working-paused', variant: 'spinner' }
    case 'awaiting_approval':
      return { label: 'Needs approval', kind: 'attention', animated: true }
    case 'spec':
      return { label: 'Spec ready', stage: 'spec' }
    case 'failed':
      return { label: 'Needs attention · error', kind: 'error' }
    case 'interrupted':
      return { label: 'Needs attention · interrupted', tone: 'done' }
    case 'completed':
      return thread.read
        ? { label: 'Done', stage: 'done' }
        : { label: 'Done · unread', kind: 'completed' }
    case 'created':
      return { label: 'New', stage: 'todo' }
    default:
      return { label: threadStatusPolicy(thread.status).label }
  }
}
