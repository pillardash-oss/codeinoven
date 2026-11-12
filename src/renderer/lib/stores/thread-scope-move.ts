import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { ovenRootKey } from '$lib/oven-root-target'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { gitState } from '$lib/stores/git.svelte'
import { scopeSwapRefusal } from '$shared/thread-scope-swap'
import { DEFAULT_SCOPE_BUCKET_ID, type Thread } from '$shared/types'

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
 * Why this window would refuse to move a thread into another scope right now,
 * or `null` when the move is fine or the thread is not in hand yet.
 *
 * Shared with the Change Scope dialog, which greys out the targets this window
 * already knows it would refuse instead of letting the user pick one and then
 * undoing the choice with a toast.
 */
export function scopeMoveRefusal(
  projectId: string,
  threadId: string,
  bucketId: string
): string | null {
  const thread = findThread(projectId, threadId)
  const board = scopeState.boards.get(projectId)
  if (!thread || !board) return null
  return scopeSwapRefusal({ thread, targetBucketId: bucketId, buckets: board.buckets })
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
  const refusal = scopeMoveRefusal(projectId, threadId, bucketId)
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
  // The Git panel is anchored to a checkout (project + scope bucket), not to a
  // thread, and it only re-anchors when a thread is opened. A moved thread that
  // is the one on screen would otherwise leave the panel reading the scope it
  // came from. Moving a background row must never repoint the panel away from
  // the conversation the user is reading.
  const movedThread = result.thread
  const shownBucket =
    ovenRootKey(movedThread.projectId) ?? movedThread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  if (
    workspaceState.selectedThread?.id === movedThread.id &&
    gitState.activeProjectId === movedThread.projectId &&
    gitState.activeScopeBucketId !== shownBucket
  ) {
    gitState.notifyScopeChanged(movedThread.projectId, shownBucket)
  }
  return result.thread
}
