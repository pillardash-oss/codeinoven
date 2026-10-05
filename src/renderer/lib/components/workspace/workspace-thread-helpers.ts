import { isThreadLiveWorking } from '$lib/thread-status-badge'
import { scopeState } from '$lib/stores/scope.svelte'
import {
  coordinatorHasActiveDelegates,
  coordinatorHasUnreadWorkers,
  isOrchestrationChildThread,
  type Thread
} from '$shared/types'
import type { ThreadGroup } from '$lib/stores/thread-grouping.svelte'
import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'

/** Partition the already-filtered rows once, preserving their order within each group. */
export function groupThreadsByStatus(
  threads: Thread[]
): { label: ThreadGroup; threads: Thread[] }[] {
  const groups: Record<ThreadGroup, Thread[]> = {
    Attention: [],
    Unread: [],
    Errors: [],
    Spec: [],
    Working: [],
    Done: []
  }
  for (const thread of threads) {
    let group: ThreadGroup
    if (thread.status === 'failed') group = 'Errors'
    else if (thread.status === 'awaiting_approval') group = 'Attention'
    else if (thread.status === 'spec') group = 'Spec'
    else if (
      threadHasVisibleWork(thread) ||
      thread.status === 'working-paused' ||
      thread.status === 'created' ||
      rendererRecovery.queuedMessageCount(thread.projectId, thread.id) > 0 ||
      rendererRecovery.hasStartAfterPending(thread.projectId, thread.id)
    )
      group = 'Working'
    else if (
      (!isOrchestrationChildThread(thread) &&
        (!thread.read || coordinatorHasUnreadWorkers(thread, scopeState.allScopeThreads))) ||
      temporaryChatUnread.hasUnread(thread.projectId, thread.id)
    )
      group = 'Unread'
    else group = 'Done'
    groups[group].push(thread)
  }
  return (Object.keys(groups) as ThreadGroup[])
    .filter((label) => groups[label].length > 0)
    .map((label) => ({ label, threads: groups[label] }))
}

export function filterThreadsByQuery(threads: Thread[], query: string): Thread[] {
  const q = query.trim().toLowerCase()
  if (!q) return threads
  return threads.filter((t) => t.title.toLowerCase().includes(q))
}

/**
 * Whether the thread has work to show in the header's activity stat. It reads
 * the one live-working rule, so a thread parked on the user (a question,
 * permission, or secret card) reports as waiting for the user rather than as
 * work in progress.
 */
export function threadHasVisibleWork(thread: Thread): boolean {
  return (
    isThreadLiveWorking(thread) || coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
  )
}
