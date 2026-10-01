import { isThreadLiveWorking } from '$lib/thread-status-badge'
import { scopeState } from '$lib/stores/scope.svelte'
import { coordinatorHasActiveDelegates, type Thread } from '$shared/types'

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
