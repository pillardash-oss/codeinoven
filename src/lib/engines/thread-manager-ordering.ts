import type { ScopeSlice, Thread } from '../types'
import { DEFAULT_SCOPE_BUCKET_ID, scopeSliceForStatus } from '../types'
import type { ThreadRepo } from '../../main/database/repositories/thread-repo'

/**
 * Owns the manual ordering of every thread list.
 *
 * A thread's position is a persisted, cross-surface contract: the list, the
 * pinned strip and a scope slice all read the same anchor columns, so every
 * rule that writes one lives here instead of in the manager. The service never
 * reads an announcement target of its own; it reports each rewritten row to the
 * injected `onChange` account.
 */
export class ThreadOrderingService {
  /**
   * @param requireOwned Ownership guard for the rows a reorder names. A caller
   * that names a thread of another project is a bug, and this is what fails it.
   * @param onChange Invoked with every row whose order actually changed.
   */
  constructor(
    private readonly threadRepo: ThreadRepo,
    private readonly requireOwned: (projectId: string, threadId: string) => Thread,
    private readonly onChange: (thread: Thread) => void
  ) {}

  async reorderThreads(projectId: string, orderedIds: string[]): Promise<Thread[]> {
    this.threadRepo.batchUpdateSortOrder(orderedIds)
    const ordered = orderedIds.map((threadId) => this.requireOwned(projectId, threadId))

    // Pinned threads keep a single pin-time order across every surface: rewrite
    // pinned_at so the first pinned thread in the new list is most-recent.
    const pinned = ordered.filter((thread) => thread.pinned)
    if (pinned.length > 0) {
      const base = Date.now()
      this.threadRepo.batchUpdatePinnedAt(
        pinned.map((thread) => thread.id),
        base
      )
      pinned.forEach((thread, index) => {
        thread.pinnedAt = base - index
      })
    }

    for (const thread of ordered) {
      this.onChange(thread)
    }
    return ordered
  }

  /**
   * Persist a single thread's manual drag-reorder anchor.
   *
   * `sortOrder` acts as a "frozen recency" anchor: it stores a timestamp placed
   * between the dragged thread's new neighbors. The renderer orders threads by
   * `sortOrder ?? lastActivity` descending, so a dragged thread holds its
   * position, while any thread that receives genuinely newer activity (a
   * larger `lastActivity`, since epoch time only grows) naturally sorts above
   * it   and can be dragged back above again. Unlike the batch reorder, this
   * touches only the dragged thread and never wipes other threads' anchors.
   */
  async setSortOrder(projectId: string, threadId: string, sortOrder: number): Promise<Thread> {
    const existing = this.requireOwned(projectId, threadId)
    const now = Date.now()
    this.threadRepo.setSortOrder(threadId, sortOrder, now)
    const updated: Thread = { ...existing, sortOrder, lastActivity: now, updatedAt: now }
    this.onChange(updated)
    return updated
  }

  /**
   * Manual reorder of the pinned threads for a project. This is the single way
   * pin order changes: the first id becomes most-recently pinned (top). Only
   * pinned_at is rewritten   nothing else, so it stays consistent across every
   * surface and a newly pinned thread always lands on top.
   */
  async reorderPinnedThreads(projectId: string, orderedPinnedIds: string[]): Promise<Thread[]> {
    if (new Set(orderedPinnedIds).size !== orderedPinnedIds.length) {
      throw new Error('Pinned order must contain unique IDs')
    }
    const owned = orderedPinnedIds.map((threadId) => this.requireOwned(projectId, threadId))
    if (owned.some((thread) => !thread.pinned)) {
      throw new Error('Pinned reorder list must contain only pinned threads')
    }
    const base = Date.now()
    this.threadRepo.batchUpdatePinnedAt(
      owned.map((thread) => thread.id),
      base
    )
    const updated: Thread[] = []
    owned.forEach((thread, index) => {
      const next = { ...thread, pinnedAt: base - index }
      this.onChange(next)
      updated.push(next)
    })
    return updated
  }

  /**
   * Manual reorder of pinned threads across every project (Threads view). The
   * first id becomes most-recently pinned (top). Only pinned_at is rewritten  
   * nothing else   so pin order stays consistent across every surface and a
   * newly pinned thread always lands on top.
   */
  async reorderPinnedThreadsGlobal(orderedPinnedIds: string[]): Promise<Thread[]> {
    if (new Set(orderedPinnedIds).size !== orderedPinnedIds.length) {
      throw new Error('Pinned order must contain unique IDs')
    }
    const owned = orderedPinnedIds.map((threadId) => {
      const thread = this.threadRepo.get(threadId)
      if (!thread) {
        throw new Error(`Thread not found: ${threadId}`)
      }
      return thread
    })
    if (owned.some((thread) => !thread.pinned)) {
      throw new Error('Pinned reorder list must contain only pinned threads')
    }
    const base = Date.now()
    this.threadRepo.batchUpdatePinnedAt(
      owned.map((thread) => thread.id),
      base
    )
    const updated: Thread[] = []
    owned.forEach((thread, index) => {
      const next = { ...thread, pinnedAt: base - index }
      this.onChange(next)
      updated.push(next)
    })
    return updated
  }

  async reorderScopeThreads(
    projectId: string,
    bucketId: string,
    slice: ScopeSlice,
    orderedIds: string[]
  ): Promise<Thread[]> {
    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new Error('Scope thread order must contain unique IDs')
    }

    const partition = (await this.threadRepo.listByProjectViaWorker(projectId))
      .filter((thread) => {
        if (thread.archived) return false
        if ((thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID) !== bucketId) return false
        if (slice === 'unread') {
          return thread.status === 'completed' && !thread.read
        }
        if (slice === 'pinned') {
          return thread.pinned
        }
        return scopeSliceForStatus(thread.status) === slice
      })
      .sort((a, b) => {
        if (a.lastActivity !== b.lastActivity) return b.lastActivity - a.lastActivity
        return a.id.localeCompare(b.id)
      })
    const partitionById = new Map(partition.map((thread) => [thread.id, thread]))
    const requested = orderedIds.map((threadId) => {
      const thread = partitionById.get(threadId)
      if (!thread) {
        throw new Error(`Thread ${threadId} does not belong to the requested scope slice`)
      }
      return thread
    })
    const requestedIds = new Set(orderedIds)
    const canonicalOrder = [
      ...requested,
      ...partition.filter((thread) => !requestedIds.has(thread.id))
    ]

    this.threadRepo.batchUpdateScopeSortOrder(
      bucketId,
      slice,
      canonicalOrder.map((t) => t.id)
    )

    // Reordering the pinned slice is a manual pin reorder: rewrite pinned_at so
    // the first pinned thread is most-recent, keeping pin order consistent with
    // every other surface.
    let pinnedBase = 0
    if (slice === 'pinned' && canonicalOrder.length > 0) {
      pinnedBase = Date.now()
      this.threadRepo.batchUpdatePinnedAt(
        canonicalOrder.map((t) => t.id),
        pinnedBase
      )
    }

    const updatedThreads: Thread[] = []
    for (let index = 0; index < canonicalOrder.length; index++) {
      const existing = canonicalOrder[index]
      if (
        existing.scopeSortOrder !== index ||
        (slice === 'pinned' && existing.pinnedAt !== pinnedBase - index)
      ) {
        const updated: Thread = {
          ...existing,
          scopeSortOrder: index,
          ...(slice === 'pinned' ? { pinnedAt: pinnedBase - index } : {})
        }
        this.onChange(updated)
        updatedThreads.push(updated)
      } else {
        updatedThreads.push(existing)
      }
    }
    return updatedThreads
  }
}
