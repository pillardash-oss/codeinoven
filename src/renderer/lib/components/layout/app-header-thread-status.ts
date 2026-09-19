import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { isLongScheduledRetryWait } from '$shared/provider-issue'
import { isThreadRetryPaused, isThreadWorking, type Thread } from '$shared/types'

/**
 * True while the thread belongs in the working-activity count. A scheduled
 * auto-retry parked beyond the shared wake window is not "working": the
 * badge drops it so the user can tell the thread left the active pool.
 */
export function threadWorkingForIndicator(thread: Thread, now = Date.now()): boolean {
  const retryAt = agentRuns.retryAt(thread.projectId, thread.id)
  if (retryAt !== null && isLongScheduledRetryWait(retryAt, now)) return false
  return agentRuns.hasSettled(thread.projectId, thread.id)
    ? agentRuns.isBusy(thread.projectId, thread.id)
    : Boolean(thread.sessionId) && isThreadWorking(thread)
}

export function threadBusyForIndicator(thread: Thread): boolean {
  return isThreadRetryPaused(thread) || threadWorkingForIndicator(thread)
}
