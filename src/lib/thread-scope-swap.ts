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
 * The filesystem root a scope resolves to, as an identity the rule can compare.
 *
 * Every project-rooted scope resolves to the same registered project directory,
 * so they share one key and a move between them changes no path. A managed
 * worktree is a checkout of its own with a directory of its own, so its directory
 * name is its identity.
 */
function scopeRootKey(bucket: ScopeBucket): string {
  return isManagedScopeRoot(bucket.root) ? `worktree:${bucket.root.directoryName}` : 'project'
}

/**
 * Why a thread may not change scope right now, or `null` when the move is fine.
 *
 * A scope carries the thread's project root. While the thread works, that root is
 * the directory its run has open: a move that hands it a different checkout
 * re-derives its working directory out from under the turn. The result is a turn
 * that keeps writing into a checkout the thread no longer belongs to, plus a
 * worktree the lifecycle may then consider free while a run still lives in it.
 *
 * So the rule is about the root, not about which side of the move is a worktree:
 * a working thread may not move onto a scope that resolves anywhere else, into a
 * worktree or out of one. A move between scopes that share the project directory
 * changes no root and stays free, and every move is free once the thread settles,
 * whether it is done, interrupted, or parked on the user.
 *
 * One rule, three callers: the main-process guard that enforces it, the renderer
 * that answers a refused drag with a toast instead of a round trip, and the
 * Change Scope dialog that greys out the targets this rule refuses. The renderer
 * runs it first so the user hears about the refusal immediately, and the guard
 * runs it again because no surface may bypass it.
 */
export function scopeSwapRefusal(input: ScopeSwapRuleInput): string | null {
  const currentBucketId = input.thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
  if (input.targetBucketId === currentBucketId) return null
  if (!isThreadBusyStatus(input.thread.status)) return null

  const current = input.buckets.find((bucket) => bucket.id === currentBucketId)
  const target = input.buckets.find((bucket) => bucket.id === input.targetBucketId)
  if (!current || !target) return null
  if (scopeRootKey(current) === scopeRootKey(target)) return null

  if (isManagedScopeRoot(current.root)) {
    return `Stop this thread before moving it out of "${current.name}": that scope's worktree is the project root this run is using.`
  }

  return `Stop this thread before moving it into "${target.name}": that scope's worktree would replace the project root this run is using.`
}
