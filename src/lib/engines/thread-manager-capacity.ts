import { DEFAULT_SCOPE_BUCKET_ID, isManagedScopeRoot, type ScopeBoard, type Thread } from '../types'
import { isThreadAwaitingUserStatus, isThreadBusyStatus } from '../thread-status-policy'
import type { ThreadCapacityCandidate } from '../../main/database/repositories/thread-repo'

/**
 * Sentinel bucket id for threads that do not belong to a pinned-like scope.
 * All non-pinned-like scopes (including the default scope) share this single
 * regular bucket, capped at the project thread limit.
 */
export const REGULAR_BUCKET = '__regular_bucket__'

/**
 * Threads that automatic cleanup never evicts, because deleting one would throw
 * away work the user has not finished with:
 *
 * - `pinned`: the user asked for it to stay.
 * - Unread: the result is waiting to be seen, so the dot the user was promised
 *   would vanish before they ever opened it. A `completed` thread the user has
 *   not read is exactly this case, and so is any other row still flagged unread.
 * - Working: `planning`, `executing` and `working-paused` (waiting to retry) are
 *   producing or about to produce work, so evicting one kills a live run.
 * - Parked on the user: `awaiting_approval` is a permission, question or secret
 *   card on screen. Nothing is running, but ending that thread silently discards
 *   the decision the run is blocked on. A live run flag cannot answer this, so
 *   the status policy is the authority.
 * - `spec`: the artifact is finished and parked between stages.
 * - An orchestration coordinator: the orchestration it owns lives on its row and
 *   the thread parks in `spec` between stages anyway, so evicting it would
 *   destroy in-flight work. Workers and auditors are already kept out of the
 *   candidate list, so only the coordinator needs the guard here.
 *
 * An archived thread is invincible by a stronger rule than this predicate: the
 * candidate query never returns one (nor any thread whose subtree holds one),
 * so it cannot reach an eviction decision at all.
 */
export function isProtectedFromAutomaticCleanup(
  thread: Pick<Thread, 'pinned' | 'read' | 'status' | 'assignmentRole' | 'achievementRole'>
): boolean {
  return (
    thread.pinned ||
    thread.read === false ||
    isThreadBusyStatus(thread.status) ||
    isThreadAwaitingUserStatus(thread.status) ||
    thread.status === 'spec' ||
    thread.assignmentRole === 'coordinator' ||
    thread.achievementRole === 'coordinator'
  )
}

/**
 * A scope gets its own thread bucket when it is pinned on the board OR its
 * root is an app-managed Git worktree. Reads the board lazily per use; the
 * scope board is a single JSON row, so this is cheap.
 */
export function scopedBucketIdsFromBoard(board: ScopeBoard): Set<string> {
  const ids = new Set<string>()
  for (const bucket of board.buckets) {
    if (bucket.pinned === true || isManagedScopeRoot(bucket.root)) ids.add(bucket.id)
  }
  return ids
}

/**
 * The bucket a thread belongs to: its own scope id when the scope is
 * pinned-like, otherwise the shared regular bucket.
 */
export function bucketForThread(
  candidate: Pick<ThreadCapacityCandidate, 'scopeBucketId'>,
  scopedBuckets: Set<string>
): string {
  return scopedBuckets.has(candidate.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
    ? (candidate.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
    : REGULAR_BUCKET
}

/** Deterministic view of a project's thread capacity for the UI. */
export interface ThreadCapacity {
  limit: number
  activeCount: number
  pinnedCount: number
  protectedCount: number
  deletableCount: number
  /** Threads in pinned-like scopes, each kept in its own per-scope bucket. */
  pinnedScopeCount: number
}

/** Paging/visibility controls for thread listings. */
export interface ThreadListOptions {
  limit?: number
  offset?: number
  includeArchived?: boolean
  /** Row ordering: `default` (manual reorder) or `activity` (recent-first). */
  order?: 'default' | 'activity'
}

/** Number of capacity candidates that belong to the given bucket. */
export function countThreadsInBucket(
  candidates: ThreadCapacityCandidate[],
  scopedBuckets: Set<string>,
  bucket: string
): number {
  return candidates.filter((candidate) => bucketForThread(candidate, scopedBuckets) === bucket)
    .length
}

/**
 * Every unprotected candidate in a bucket, in the order the repo returned it
 * (oldest activity first). Eviction walks this list so a thread that cannot be
 * deleted costs one attempt instead of disabling the project's capacity bound.
 */
export function evictableInBucket(
  candidates: ThreadCapacityCandidate[],
  scopedBuckets: Set<string>,
  bucket: string
): ThreadCapacityCandidate[] {
  return candidates.filter(
    (candidate) =>
      bucketForThread(candidate, scopedBuckets) === bucket &&
      !isProtectedFromAutomaticCleanup(candidate)
  )
}

/**
 * Deterministic capacity view for the shared regular bucket. Pinned-like
 * scopes live in their own per-scope buckets and are reported separately.
 */
export function buildThreadCapacity(
  limit: number,
  active: Thread[],
  scopedBuckets: Set<string>
): ThreadCapacity {
  const regular = active.filter(
    (thread) =>
      bucketForThread({ scopeBucketId: thread.scopeBucketId }, scopedBuckets) === REGULAR_BUCKET
  )
  return {
    limit,
    activeCount: regular.length,
    pinnedCount: regular.filter((thread) => thread.pinned).length,
    protectedCount: regular.filter((thread) => isProtectedFromAutomaticCleanup(thread)).length,
    deletableCount: regular.filter((thread) => !isProtectedFromAutomaticCleanup(thread)).length,
    pinnedScopeCount: active.length - regular.length
  }
}
