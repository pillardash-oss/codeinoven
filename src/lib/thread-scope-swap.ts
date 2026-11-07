import { DEFAULT_SCOPE_BUCKET_ID, isManagedScopeRoot, type ScopeBucket, type Thread } from './types'
import { isThreadBusyStatus } from './thread-status-policy'

/**
 * The app refusing to change a thread's scope in a state the user resolves by
 * acting: stopping the turn whose checkout the move would take away.
 *
 * It is an ordinary `Error` because it must cross the manager boundary like any
 * other refusal, but the IPC transport converts it to
 * `ThreadScopeMoveResult` data instead of rejecting, because Electron logs every
 * rejected `ipcMain.handle` call and this is user feedback, not an app failure.
 */
export class ScopeSwapRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeSwapRefusal'
  }
}

export interface ScopeSwapRuleInput {
  /** The thread as it is stored now, before the move. */
  thread: Pick<Thread, 'scopeBucketId' | 'status'>
  /** The scope the write would move the thread to. */
  targetBucketId: string
  /** The project's scope board buckets, or an empty list while it is unknown. */
  buckets: readonly ScopeBucket[]
}

/**
 * Why a thread may not change scope right now, or `null` when the move is fine.
 *
 * A worktree scope is a checkout of its own: the running turn has that directory
 * open, and a move re-derives the thread's working directory out from under it.
 * The result is a turn that keeps writing into a checkout the thread no longer
 * belongs to, plus a worktree the lifecycle may then consider free while a run
 * still lives in it. So the swap waits for the turn: a working thread inside a
 * worktree scope may not be reassigned at all.
 *
 * Every other case is unchanged. A thread whose scope is the project root moves
 * freely while it works, and a worktree thread moves freely once it settles,
 * whether it is done, interrupted, or parked on the user.
 *
 * One rule, two callers: the main-process guard that enforces it, and the
 * renderer that answers a refused drag with a toast instead of a round trip. The
 * renderer runs it first so the user hears about the refusal immediately, and
 * the guard runs it again because no surface may bypass it.
 */
export function scopeSwapRefusal(input: ScopeSwapRuleInput): string | null {
  const currentBucketId = input.thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  if (input.targetBucketId === currentBucketId) return null
  if (!isThreadBusyStatus(input.thread.status)) return null

  const current = input.buckets.find((bucket) => bucket.id === currentBucketId)
  if (!current || !isManagedScopeRoot(current.root)) return null

  return `Stop this thread before moving it to another scope: "${current.name}" is an isolated worktree.`
}
