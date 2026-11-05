import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { scopeSwapRefusal } from '$shared/thread-scope-swap'
import type { Thread } from '$shared/types'

/** The thread this window already holds, when it has one to judge by. */
function findThread(projectId: string, threadId: string): Thread | null {
  const scoped = scopeState.allScopeThreads.find(
    (candidate) => candidate.id === threadId && candidate.projectId === projectId
  )
  if (scoped) return scoped
  const selected = workspaceState.selectedThread
  return selected?.id === threadId ? selected : null
}

/**
 * Move a thread into another scope, and keep both stores in step.
 *
 * Returns the moved thread, or `null` when the app refused the move. A refusal
 * is user feedback rather than a failure: the sentence is toasted here, once per
 * reason (sonner's `id` collapses the duplicates a multi-thread operation would
 * otherwise stack), and nothing is recorded as an app error.
 *
 * The rule is checked here first, from the board this window already holds, so a
 * drop on an impossible target answers immediately instead of taking an IPC round
 * trip to be told the same thing. Main enforces the identical rule again on
 * every scope write, and its refusal arrives as data on the same channel.
 *
 * A genuine failure still rejects, and the caller's own error handling keeps it.
 */
export async function moveThreadToScope(
  projectId: string,
  threadId: string,
  bucketId: string
): Promise<Thread | null> {
  const thread = findThread(projectId, threadId)
  const board = scopeState.boards.get(projectId)
  const refusal =
    thread && board
      ? scopeSwapRefusal({ thread, targetBucketId: bucketId, buckets: board.buckets })
      : null
  if (refusal) {
    toast(refusal, { id: refusal })
    return null
  }

  const result = await invoke('thread:moveScope', projectId, threadId, bucketId)
  if (!result.ok) {
    toast(result.refusal, { id: result.refusal })
    return null
  }

  scopeState.updateThread(result.thread)
  workspaceState.updateThread(result.thread)
  return result.thread
}
