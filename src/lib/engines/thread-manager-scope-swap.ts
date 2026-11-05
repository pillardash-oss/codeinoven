import { DEFAULT_SCOPE_BUCKET_ID, isManagedScopeRoot, type ScopeBoard, type Thread } from '../types'
import { isThreadBusyStatus } from '../thread-status-policy'

export interface ScopeSwapGuardInput {
  /** The thread as it is stored now, before the move. */
  thread: Pick<Thread, 'projectId' | 'scopeBucketId' | 'status'>
  /** The scope the write would move the thread to. */
  targetBucketId: string
  /** Reads the project's scope board; the caller passes its own reader. */
  boardFor: (projectId: string) => Promise<ScopeBoard>
}

/**
 * Refuse to change the scope of a thread whose current scope is an app-managed
 * Git worktree while that thread is still working.
 *
 * A worktree scope is a checkout of its own: the running turn has that
 * directory open, and the move would re-derive the thread's working directory
 * out from under it. The result is a turn that keeps writing into a checkout
 * the thread no longer belongs to, plus a worktree the lifecycle may then
 * consider free while a run still lives in it.
 *
 * So the swap waits for the turn: a working thread inside a worktree scope may
 * not be reassigned at all. Every other case is unchanged. A thread whose scope
 * is the project root (or any scope hoisted to the project root) moves freely
 * while it works, and a worktree thread moves freely once it settles, whether
 * it is done, interrupted, or parked on the user.
 *
 * This lives behind every scope write, not only the UI that asked for it: the
 * composer, the scope board's drag and drop, the "Change Scope" dialog and the
 * agent-facing scope tool all reach the same thread writer, so none of them can
 * bypass the rule.
 */
export async function assertScopeSwapAllowed(input: ScopeSwapGuardInput): Promise<void> {
  const currentBucketId = input.thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  if (input.targetBucketId === currentBucketId) return
  if (!isThreadBusyStatus(input.thread.status)) return

  const board = await input.boardFor(input.thread.projectId)
  const current = board.buckets.find((bucket) => bucket.id === currentBucketId)
  if (!current || !isManagedScopeRoot(current.root)) return

  throw new Error(
    `Stop this thread before moving it to another scope: "${current.name}" is an isolated worktree.`
  )
}
