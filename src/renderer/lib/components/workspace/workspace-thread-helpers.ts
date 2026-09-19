import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { coordinatorHasActiveDelegates, isThreadWorking, type Thread } from '$shared/types'

export function filterThreadsByQuery(threads: Thread[], query: string): Thread[] {
  const q = query.trim().toLowerCase()
  if (!q) return threads
  return threads.filter((t) => t.title.toLowerCase().includes(q))
}

export function threadHasVisibleWork(thread: Thread): boolean {
  const settledWorking = agentRuns.hasSettled(thread.projectId, thread.id)
    ? agentRuns.isBusy(thread.projectId, thread.id)
    : Boolean(thread.sessionId) && isThreadWorking(thread)
  return settledWorking || coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
}
