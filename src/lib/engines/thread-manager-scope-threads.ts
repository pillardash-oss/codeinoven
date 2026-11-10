import type { Thread } from '../types'
import { DEFAULT_SCOPE_BUCKET_ID, isOrchestrationChildThread } from '../types'
import type { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { ThreadRepo } from '../../main/database/repositories/thread-repo'
import {
  REGULAR_BUCKET,
  bucketForThread,
  isProtectedFromAutomaticCleanup,
  scopedBucketIdsFromBoard
} from './thread-manager-capacity'
import type { ScopeManager } from './scope-manager'

/**
 * Owns the threads a scope owns as a set: how many there are, deleting them all
 * when the scope's checkout is removed, and moving them back into the Default
 * scope when it is, together with the capacity sweep that move owes the
 * destination bucket.
 *
 * A scope's removal is a bulk operation on rows a user never picked one by one,
 * so it lives here rather than in the manager: the single-thread paths stay in
 * {@link ThreadSweepService}, and this one composes them per scope.
 */
export class ThreadScopeThreadsService {
  /**
   * @param deleteThread The manager's own deletion path, so a scope sweep tears
   * each thread down exactly as a user delete does.
   * @param updateThread The manager's own update path, so a move re-derives its
   * scope-derived columns under the same guards a manual move does.
   */
  constructor(
    private readonly threadRepo: ThreadRepo,
    private readonly projectRepo: ProjectRepo,
    private readonly scopeManager: ScopeManager,
    private readonly deleteThread: (projectId: string, threadId: string) => Promise<void>,
    private readonly updateThread: (
      projectId: string,
      threadId: string,
      input: Pick<Thread, 'scopeBucketId'>
    ) => Promise<Thread>
  ) {}

  private async scopeOwnedThreads(projectId: string, bucketId: string): Promise<Thread[]> {
    const threads = await this.threadRepo.listByProjectViaWorker(projectId, {
      includeArchived: false
    })
    return threads.filter(
      (thread) => (thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID) === bucketId
    )
  }

  async countThreadsInScope(projectId: string, bucketId: string): Promise<number> {
    return (await this.scopeOwnedThreads(projectId, bucketId)).filter(
      (thread) => !isOrchestrationChildThread(thread)
    ).length
  }

  /**
   * Delete every thread owned by a scope. Parent threads go through
   * `deleteThread` so their orchestration descendants and disk artifacts are
   * swept; leftover children (orphans whose coordinator lived outside the
   * scope) are removed individually.
   */
  async deleteThreadsInScope(projectId: string, bucketId: string): Promise<number> {
    const owned = await this.scopeOwnedThreads(projectId, bucketId)
    const roots = owned.filter((thread) => !isOrchestrationChildThread(thread))
    let deleted = roots.length
    for (const root of roots) {
      await this.deleteThread(projectId, root.id)
    }
    const remaining = await this.scopeOwnedThreads(projectId, bucketId)
    for (const thread of remaining) {
      try {
        await this.deleteThread(projectId, thread.id)
        deleted += 1
      } catch {
        // Already swept by a parent deletion; treat as removed.
      }
    }
    return deleted
  }

  /**
   * Move every thread owned by a scope into the Default scope's regular bucket
   * and enforce the project thread limit there, evicting the oldest Default
   * threads that exceed it (freshly moved and protected threads are never
   * evicted). Returns how many were moved and evicted.
   */
  async moveThreadsOutOfScope(
    projectId: string,
    fromBucketId: string
  ): Promise<{ moved: number; evicted: number }> {
    const protectedIds = new Set<string>()
    let moved = 0
    const owned = await this.scopeOwnedThreads(projectId, fromBucketId)
    for (const root of owned.filter((thread) => !isOrchestrationChildThread(thread))) {
      await this.updateThread(projectId, root.id, { scopeBucketId: DEFAULT_SCOPE_BUCKET_ID })
      protectedIds.add(root.id)
      moved += 1
    }
    // Sweep orphans the parent move did not cover (children whose coordinator
    // lived outside the scope).
    const leftovers = await this.scopeOwnedThreads(projectId, fromBucketId)
    for (const thread of leftovers) {
      await this.updateThread(projectId, thread.id, { scopeBucketId: DEFAULT_SCOPE_BUCKET_ID })
      protectedIds.add(thread.id)
      moved += 1
    }
    const evicted = await this.enforceRegularBucketCapacity(projectId, protectedIds)
    return { moved, evicted }
  }

  /**
   * Evict the oldest unprotected threads in the shared regular bucket until the
   * project thread limit is respected. `protectedIds` are never evicted.
   * Returns how many threads were removed.
   */
  private async enforceRegularBucketCapacity(
    projectId: string,
    protectedIds: ReadonlySet<string> = new Set()
  ): Promise<number> {
    const project = await this.projectRepo.getViaWorker(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const scopedBuckets = scopedBucketIdsFromBoard(this.scopeManager.getBoard(projectId))
    const candidates = await this.threadRepo.listCapacityCandidatesViaWorker(projectId)
    const regular = candidates.filter(
      (candidate) =>
        bucketForThread(candidate, scopedBuckets) === REGULAR_BUCKET &&
        !protectedIds.has(candidate.id)
    )
    let overage =
      candidates.filter((candidate) => bucketForThread(candidate, scopedBuckets) === REGULAR_BUCKET)
        .length - project.threadLimit
    const evictionCandidates = regular.sort(
      (left, right) => left.lastActivity - right.lastActivity || left.id.localeCompare(right.id)
    )
    let evicted = 0
    for (const candidate of evictionCandidates) {
      if (overage <= 0) break
      if (isProtectedFromAutomaticCleanup(candidate)) continue
      try {
        await this.deleteThread(projectId, candidate.id)
        evicted += 1
      } catch {
        // Race with another sweep; the limit is best-effort here.
      }
      overage -= 1
    }
    return evicted
  }
}
