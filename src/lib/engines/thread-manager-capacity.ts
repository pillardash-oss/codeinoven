import { DEFAULT_SCOPE_BUCKET_ID, isManagedScopeRoot, type ScopeBoard, type Thread } from '../types'
import type { ThreadCapacityCandidate } from '../../main/database/repositories/thread-repo'

/**
 * Sentinel bucket id for threads that do not belong to a pinned-like scope.
 * All non-pinned-like scopes (including the default scope) share this single
 * regular bucket, capped at the project thread limit.
 */
export const REGULAR_BUCKET = '__regular_bucket__'

/** Threads that automatic cleanup never evicts: pinned or in spec status. */
export function isProtectedFromAutomaticCleanup(
  thread: Pick<Thread, 'pinned' | 'status'>
): boolean {
  return thread.pinned || thread.status === 'spec'
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

/** First unprotected candidate in a bucket, in the order the repo returned it. */
export function firstEvictableInBucket(
  candidates: ThreadCapacityCandidate[],
  scopedBuckets: Set<string>,
  bucket: string
): ThreadCapacityCandidate | undefined {
  return candidates.find(
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
