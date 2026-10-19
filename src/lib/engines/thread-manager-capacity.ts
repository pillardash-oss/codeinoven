import { DEFAULT_SCOPE_BUCKET_ID, isManagedScopeRoot, type ScopeBoard, type Thread } from '../types'
import type { ThreadCapacityCandidate } from '../../main/database/repositories/thread-repo'

/**
 * Sentinel bucket id for threads that do not belong to a pinned-like scope.
 * All non-pinned-like scopes (including the default scope) share this single
 * regular bucket, capped at the project thread limit.
 */
export const REGULAR_BUCKET = '__regular_bucket__'

/**
 * Threads that automatic cleanup never evicts: pinned, in `spec` status, or
 * driving an Assignment/Achievement orchestration.
 *
 * A coordinator is protected without a pin: the orchestration it owns lives on
 * its row, and the thread parks in `spec` between stages anyway, so evicting it
 * would destroy in-flight work. Workers and auditors are already kept out of the
 * candidate list, so only the coordinator needs the guard here.
 *
 * An archived thread is invincible by a stronger rule than this predicate: the
 * candidate query never returns one (nor any thread whose subtree holds one),
 * so it cannot reach an eviction decision at all.
 */
export function isProtectedFromAutomaticCleanup(
  thread: Pick<Thread, 'pinned' | 'status' | 'assignmentRole' | 'achievementRole'>
): boolean {
  return (
    thread.pinned ||
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
