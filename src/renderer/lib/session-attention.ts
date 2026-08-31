import type { AgentSessionStatus } from '$shared/types'

/**
 * Every status that means a turn has stopped producing on its own and a
 * pending permission/question/queued-message may be waiting for the user —
 * both must reconcile the authoritative attention queues (agent:listPermissions/
 * agent:listQuestions), not just the raw push events those queues also
 * receive. A push can be missed (dropped event, stale sessionId at the
 * moment it arrived); this is the fallback that self-heals it. `waiting` is
 * the status a paused permission/question turn reports and was missing this
 * reconciliation until it was added — regressing this list silently brings
 * that bug back for whichever state falls off it.
 */
export function reconcilesPendingAttention(state: AgentSessionStatus['state']): boolean {
  return state === 'idle' || state === 'waiting'
}
