import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { isThreadLiveWorking } from '$lib/thread-status-badge'
import { isLongScheduledRetryWait } from '$shared/provider-issue'
import { isThreadRetryPaused, type Thread } from '$shared/types'

/**
 * True while the thread belongs in the working-activity count.
 *
 * The one live-working rule is `isThreadLiveWorking`, which also keeps a thread
 * parked on the user out of the working count however busy its bound session
 * still looks: a permission, question, or secret card waiting for an answer is
 * needs-attention activity, not work in progress, and only the status change
 * that answers it leaves that state.
 *
 * A scheduled auto-retry parked beyond the shared wake window is not "working"
 * either: the badge drops it so the user can tell the thread left the active
 * pool.
 */
export function threadWorkingForIndicator(thread: Thread, now = Date.now()): boolean {
  const retryAt = agentRuns.retryAt(thread.projectId, thread.id)
  if (retryAt !== null && isLongScheduledRetryWait(retryAt, now)) return false
  return isThreadLiveWorking(thread)
}

export function threadBusyForIndicator(thread: Thread): boolean {
  return isThreadRetryPaused(thread) || threadWorkingForIndicator(thread)
}
