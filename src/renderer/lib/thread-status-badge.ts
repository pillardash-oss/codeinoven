import { isThreadWorking, type Thread } from '$shared/types'
import { threadStatusPolicy } from '$shared/thread-status-policy'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import type { ActionStatusBadge } from '$lib/actions/types'

/**
 * Whether a thread is doing live work right now. Once the run state has been
 * settled by a live session (a mounted ThreadView or streamed activity) that
 * flag is authoritative   a stale persisted `planning`/`executing` status must
 * not keep the spinner alive after the turn actually finished. Before anything
 * settles (a fresh app start), the persisted status is the only signal and
 * stands in for genuinely in-flight work. Every status surface reads this one
 * rule so a thread never looks working on one surface and idle on another.
 */
export function isThreadLiveWorking(thread: Thread): boolean {
  return agentRuns.hasSettled(thread.projectId, thread.id)
    ? agentRuns.isBusy(thread.projectId, thread.id)
    : Boolean(thread.sessionId) && isThreadWorking(thread)
}

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
    default: {
      // Planning/executing that the live flag has already settled as idle, plus
      // any future status: carry the policy tone so the dot keeps its colour
      // instead of falling back to the neutral one.
      const policy = threadStatusPolicy(thread.status)
      return { label: policy.label, tone: policy.tone }
    }
  }
}
