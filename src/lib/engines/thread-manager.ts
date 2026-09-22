import { rm } from 'fs/promises'
import { generateId } from '../utils'
import { threadOwnedDirectories } from '../thread-storage-paths'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { broadcastThreadDraftUpdated } from '../../main/chat/thread-events'
import { trackDraftWrite } from '../../main/chat/draft-commit-gate'
import { validateEntityId } from '../../main/ipc/ipc-validation'
import { HarnessUsageRepo } from '../../main/database/repositories/harness-usage-repo'
import { Logger } from '../../main/system/logger'
import { EngineeringLifecycleEngine } from './engineering-lifecycle-engine'
import {
  AgentMessageRepo,
  type ProviderDeltaSyncResult
} from '../../main/database/repositories/agent-message-repo'
import {
  RECENT_THREADS_PER_PROJECT,
  ThreadRepo
} from '../../main/database/repositories/thread-repo'
import { ScopeManager } from './scope-manager'
import type { Database } from '../../main/database/database'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  scopeSliceForStatus,
  type ScopeSlice,
  type Thread,
  type CreateThreadInput,
  type ThreadStatus,
  type ThreadSettings,
  type ThreadContextUsage,
  type AgentMessage,
  type ThreadMessageCursor,
  type ThreadMessagePage,
  type UsageBearingMessage,
  type UserMessageSummary,
  isOrchestrationChildThread
} from '../types'
import {
  REGULAR_BUCKET,
  bucketForThread,
  buildThreadCapacity,
  countThreadsInBucket,
  firstEvictableInBucket,
  isProtectedFromAutomaticCleanup,
  scopedBucketIdsFromBoard,
  type ThreadCapacity,
  type ThreadListOptions
} from './thread-manager-capacity'
import { buildThreadDeletionStatements, placeholdersFor } from './thread-manager-deletion'
import { orchestrationDescendants } from './thread-manager-lineage'
import { ThreadForkService } from './thread-manager-fork'
import { ThreadSearchService } from './thread-manager-search'
import { ThreadTranscriptStore } from './thread-manager-transcripts'

export { remapCopiedMessages } from './thread-manager-fork'
export type { ThreadCapacity, ThreadListOptions } from './thread-manager-capacity'

/** Sidebar quota for the inbox (Chats) project: show all of its recent threads. */
const INBOX_PROJECT_ID = 'inbox'

/**
 * Raised when `createThread` is asked to exceed a project's thread limit while
 * every active thread is protected from automatic cleanup. Deliberately
 * explicit: no thread is silently deleted and no thread is silently created
 * past the bound.
 */
export class AllThreadsProtectedError extends Error {
  constructor(
    readonly projectId: string,
    readonly limit: number,
    readonly activeCount: number
  ) {
    super(
      `Cannot create a thread: every active thread is pinned or in spec status (${activeCount}/${limit}). ` +
        'Move a thread out of spec, unpin it, or delete an existing thread first.'
    )
    this.name = 'AllThreadsProtectedError'
  }
}

/** @deprecated Use `AllThreadsProtectedError`. */
export const AllThreadsPinnedError = AllThreadsProtectedError

/**
 * Main-process injection point that resolves a scope target into its
 * authoritative filesystem root. The persisted `Thread.workingDirectory` is
 * compatibility data; this provider is the authority at creation time.
 */
export interface ThreadScopeRootProvider {
  /**
   * Resolve the compatibility working directory for a thread in the given
   * scope. Returns null when the scope is unknown/project-rooted without a
   * local project. Throws when a managed scope root is unhealthy.
   */
  resolveCompatibilityRoot(projectId: string, scopeBucketId?: string): Promise<string | null>
}

export class ThreadManager {
  private threadRepo: ThreadRepo
  private projectRepo: ProjectRepo
  private agentMessageRepo: AgentMessageRepo
  private harnessUsageRepo: HarnessUsageRepo
  private engineeringLifecycleEngine: EngineeringLifecycleEngine
  private readonly transcripts: ThreadTranscriptStore
  private readonly forks: ThreadForkService
  private readonly searchService: ThreadSearchService

  /**
   * @param onChange Invoked after a thread's status/read state is persisted so
   * callers (main process) can push live updates to renderer windows.
   * @param onDelete Invoked before a thread's rows are removed so callers can
   * tear down live harness resources (sessions, servers, ports) first.
   */
  constructor(
    private db: Database,
    private onChange?: (thread: Thread) => void,
    private onDelete?: (thread: Thread) => void | Promise<void>,
    private onDeleted?: (threads: Thread[]) => void | Promise<void>,
    private scopeRoots?: ThreadScopeRootProvider
  ) {
    this.threadRepo = new ThreadRepo(db)
    this.projectRepo = new ProjectRepo(db)
    this.agentMessageRepo = new AgentMessageRepo(db)
    this.harnessUsageRepo = new HarnessUsageRepo(db)
    this.engineeringLifecycleEngine = new EngineeringLifecycleEngine(db)
    this.scopeManager = new ScopeManager(db)
    this.transcripts = new ThreadTranscriptStore(db, this.agentMessageRepo)
    this.forks = new ThreadForkService(db, this.projectRepo, this.engineeringLifecycleEngine, this)
    this.searchService = new ThreadSearchService(db, this.threadRepo)
  }

  /** Reads scope boards to keep pinned scopes outside the thread bucket. */
  private readonly scopeManager: ScopeManager

  /**
   * Set by the ChatEngine so deleting a thread closes its open ranking
   * snapshot conversation for immediate grading before the thread foreign
   * key is detached   deletion is the conversation close signal.
   */
  onThreadsDeletedForRanking?: (projectId: string, threadIds: string[]) => void

  /** Distinct harness ids used across a thread's session, newest first. */
  /** Distinct harness ids used across a thread's session, newest first. */
  usedHarnessIds(threadId: string): string[] {
    return this.harnessUsageRepo.harnessIdsFor(threadId)
  }

  /** Cumulative per-harness usage rows for a thread. */
  harnessUsageFor(projectId: string, threadId: string): import('../types').HarnessUsage[] {
    return this.harnessUsageRepo.listByThread(projectId, threadId)
  }

  /** Efficiency and cost-coverage KPIs for a thread's completed successful user turns. */
  efficiencyKpisFor(
    _projectId: string,
    threadId: string
  ): Promise<import('../types').UsageEfficiencyKpis> {
    return this.harnessUsageRepo.efficiencyKpisForThread(threadId)
  }

  /** Accumulate a completed turn's harness usage (ledger-guarded, idempotent). */
  accumulateHarnessUsage(
    projectId: string,
    threadId: string,
    messages: readonly UsageBearingMessage[]
  ): Promise<{ ok: boolean; error?: string }> {
    return this.harnessUsageRepo.accumulateTurn(projectId, threadId, messages)
  }

  /**
   * Sub-agent turns of a thread that reported usage, as a narrow projection for
   * the usage ledger. Never contacts a provider.
   */
  listSubagentUsageMessages(projectId: string, threadId: string): Promise<UsageBearingMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return Promise.resolve([])
    return this.transcripts.listSubagentUsageMessages(threadId)
  }

  private getOwnedThread(projectId: string, threadId: string): Thread | null {
    const thread = this.threadRepo.get(threadId)
    return thread?.projectId === projectId ? thread : null
  }

  private requireOwnedThread(projectId: string, threadId: string): Thread {
    const thread = this.getOwnedThread(projectId, threadId)
    if (!thread) {
      throw new Error(`Thread not found in project ${projectId}: ${threadId}`)
    }
    return thread
  }

  /** The full synchronous `createThread`, used by internal orchestrators. */
  async createThread(input: CreateThreadInput): Promise<Thread> {
    const { thread, finalize } = this.prepareCreateThread(input)
    await finalize()
    return thread
  }

  /**
   * Split the create so the renderer-facing path can return the thread
   * immediately and finalize persistence in the background:
   *
   * - The synchronous half only builds the thread object and stable id.
   * - The `finalize` half validates the project, enforces capacity, performs
   *   the lazy eviction, and persists the row through the database worker.
   *   Eviction failure never breaks the new thread; it is surfaced through
   *   `onEvictionError` so the caller can audit it while the create proceeds.
   */
  prepareCreateThread(
    input: CreateThreadInput,
    options: { onEvictionError?: (error: unknown) => void } = {}
  ): { thread: Thread; finalize: () => Promise<void> } {
    const creatingOrchestrationChild =
      input.assignmentRole === 'worker' ||
      input.achievementRole === 'auditor' ||
      input.coordinatorThreadId !== undefined
    const id = input.id ?? generateId()
    const now = Date.now()

    const thread: Thread = {
      id,
      projectId: input.projectId,
      providerId: input.providerId,
      title: input.title,
      titleSource: input.titleSource ?? 'default',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      settings: input.settings,
      featureSlug: input.featureSlug,
      scopeBucketId: input.scopeBucketId,
      assignmentId: input.assignmentId,
      assignmentRole: input.assignmentRole,
      assignmentTaskId: input.assignmentTaskId,
      coordinatorThreadId: input.coordinatorThreadId,
      achievementRole: input.achievementRole,
      auditorThreadId: input.auditorThreadId,
      userInputLocked: input.userInputLocked,
      createdAt: now,
      updatedAt: now,
      lastActivity: now,
      workingDirectory: input.workingDirectory ?? ''
    }

    const finalize = async (): Promise<void> => {
      // Project validation and capacity reads are deliberately inside the
      // async half. Renderer-facing creates can return the stable thread id
      // before either SQLite query begins, while internal callers still await
      // this function and receive the same deterministic errors.
      const project = await this.projectRepo.getViaWorker(input.projectId)
      if (!project) {
        throw new Error(`Project not found: ${input.projectId}`)
      }
      const scopedBuckets = scopedBucketIdsFromBoard(this.scopeManager.getBoard(input.projectId))
      // The new thread lands in its own bucket: either its pinned-like scope's
      // bucket or the shared regular bucket. Capacity is enforced per bucket,
      // so eviction only ever displaces threads from the same bucket.
      const newThreadBucket = bucketForThread({ scopeBucketId: input.scopeBucketId }, scopedBuckets)
      const active = await this.threadRepo.listCapacityCandidatesViaWorker(input.projectId)
      const bucketCount = countThreadsInBucket(active, scopedBuckets, newThreadBucket)
      let toEvictId: string | undefined
      if (!creatingOrchestrationChild && bucketCount >= project.threadLimit) {
        const toEvict = firstEvictableInBucket(active, scopedBuckets, newThreadBucket)
        toEvictId = toEvict?.id
        if (!toEvictId) {
          throw new AllThreadsProtectedError(input.projectId, project.threadLimit, bucketCount)
        }
      }

      // The new thread lands first so the optimistic create always yields a
      // persisted row; the bounded bucket delete is best-effort cleanup that
      // must never roll back the creation it is making room for.
      await this.resolveCompatibilityRoot(input.projectId, input.scopeBucketId, thread)
      await this.threadRepo.upsertViaWorker(thread)
      if (toEvictId) {
        try {
          await this.deleteThread(input.projectId, toEvictId)
        } catch (error) {
          options.onEvictionError?.(error)
        }
      }
    }

    return { thread, finalize }
  }

  /**
   * Synchronize a thread's compatibility working directory with its scope's
   * authoritative root. Renderer-supplied directories never win when the
   * scope resolves; unhealthy managed scopes fail closed.
   */
  private async resolveCompatibilityRoot(
    projectId: string,
    scopeBucketId: string | undefined,
    thread: Thread
  ): Promise<void> {
    if (!this.scopeRoots || !scopeBucketId) return
    const resolved = await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
    if (resolved) thread.workingDirectory = resolved
  }

  async getThread(projectId: string, threadId: string): Promise<Thread | null> {
    const thread = this.getOwnedThread(projectId, threadId)
    if (thread && !thread.titleSource) {
      thread.titleSource = 'default'
    }
    return thread
  }

  /** Worker-backed snapshot used to reconcile a failed optimistic operation. */
  async getThreadViaWorker(projectId: string, threadId: string): Promise<Thread | null> {
    const thread = await this.threadRepo.getViaWorker(threadId)
    return thread?.projectId === projectId ? thread : null
  }

  async listThreads(projectId: string, options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listByProject(projectId, options)
  }

  async reorderThreads(projectId: string, orderedIds: string[]): Promise<Thread[]> {
    this.threadRepo.batchUpdateSortOrder(orderedIds)
    const ordered = orderedIds.map((threadId) => this.requireOwnedThread(projectId, threadId))

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
      this.onChange?.(thread)
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
    const existing = this.requireOwnedThread(projectId, threadId)
    this.threadRepo.setSortOrder(threadId, sortOrder)
    const updated: Thread = { ...existing, sortOrder, updatedAt: Date.now() }
    this.onChange?.(updated)
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
    const owned = orderedPinnedIds.map((threadId) => this.requireOwnedThread(projectId, threadId))
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
      this.onChange?.(next)
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
      this.onChange?.(next)
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

    const partition = this.threadRepo
      .listByProject(projectId)
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
        this.onChange?.(updated)
        updatedThreads.push(updated)
      } else {
        updatedThreads.push(existing)
      }
    }
    return updatedThreads
  }

  async updateThread(
    projectId: string,
    threadId: string,
    input: Partial<
      Pick<
        Thread,
        | 'title'
        | 'titleSource'
        | 'providerId'
        | 'workingDirectory'
        | 'scopeBucketId'
        | 'lastActivity'
        | 'read'
        | 'assignmentId'
        | 'assignmentRole'
        | 'assignmentTaskId'
        | 'coordinatorThreadId'
        | 'achievementRole'
        | 'auditorThreadId'
        | 'userInputLocked'
        | 'independentAudit'
        | 'independentAuditInitialized'
        | 'activeAuditId'
        | 'activeAuditVersion'
      >
    >
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    // Moving a thread to a different scope counts as activity on it: the
    // thread jumps to the top of the destination scope instead of arriving
    // with a stale timestamp (which would also make it the immediate
    // candidate for automatic eviction).
    const movedScopes =
      input.scopeBucketId !== undefined &&
      input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)

    const updated: Thread = {
      ...existing,
      lastActivity: movedScopes ? Date.now() : (input.lastActivity ?? existing.lastActivity),
      title: input.title ?? existing.title,
      titleSource: input.titleSource ?? existing.titleSource,
      providerId: input.providerId ?? existing.providerId,
      workingDirectory: input.workingDirectory ?? existing.workingDirectory,
      scopeBucketId: input.scopeBucketId ?? existing.scopeBucketId,
      read: input.read ?? existing.read,
      assignmentId: input.assignmentId ?? existing.assignmentId,
      assignmentRole: input.assignmentRole ?? existing.assignmentRole,
      assignmentTaskId: input.assignmentTaskId ?? existing.assignmentTaskId,
      coordinatorThreadId: input.coordinatorThreadId ?? existing.coordinatorThreadId,
      achievementRole: input.achievementRole ?? existing.achievementRole,
      auditorThreadId: input.auditorThreadId ?? existing.auditorThreadId,
      userInputLocked: input.userInputLocked ?? existing.userInputLocked,
      independentAudit: input.independentAudit ?? existing.independentAudit,
      independentAuditInitialized:
        input.independentAuditInitialized ?? existing.independentAuditInitialized,
      activeAuditId: input.activeAuditId ?? existing.activeAuditId,
      activeAuditVersion: input.activeAuditVersion ?? existing.activeAuditVersion,
      scopeSortOrder:
        input.scopeBucketId !== undefined &&
        input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
          ? undefined
          : existing.scopeSortOrder,
      updatedAt: Date.now()
    }

    // Moving a thread between scopes re-derives its compatibility working
    // directory from the destination scope before anything can act on it.
    if (
      this.scopeRoots &&
      input.scopeBucketId !== undefined &&
      input.workingDirectory === undefined &&
      input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
    ) {
      const resolved = await this.scopeRoots.resolveCompatibilityRoot(
        projectId,
        updated.scopeBucketId
      )
      if (resolved) updated.workingDirectory = resolved
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /** Set the git branch associated with this thread. */
  async setBranch(projectId: string, threadId: string, branch: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = {
      ...existing,
      branch,
      updatedAt: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }
  async deleteThread(projectId: string, threadId: string): Promise<void> {
    const projectThreads = await this.threadRepo.listForDeletionViaWorker(projectId)
    const thread = projectThreads.find((candidate) => candidate.id === threadId)
    if (!thread) {
      throw new Error(`Thread not found in project ${projectId}: ${threadId}`)
    }
    const deletionOrder = [...orchestrationDescendants(projectThreads, threadId), thread]
    const assignmentIds = await this.assignmentIdsFor(deletionOrder)
    for (const candidate of deletionOrder) {
      await this.onDelete?.(candidate)
    }
    this.onThreadsDeletedForRanking?.(
      projectId,
      deletionOrder.map((candidate) => candidate.id)
    )
    const outcome = await this.db.transactionViaWorker(
      buildThreadDeletionStatements(deletionOrder, assignmentIds)
    )
    if (!outcome.ok) {
      throw new Error(outcome.error ?? 'thread deletion failed')
    }
    for (const candidate of deletionOrder) {
      this.transcripts.forgetUserMessages(projectId, candidate.id)
    }
    await this.removeThreadDiskArtifacts(deletionOrder)
    await this.onDeleted?.(deletionOrder)
  }

  /**
   * Delete every thread in a project through the same path as
   * `deleteThread` (session teardown, DB row cleanup, disk artifacts), so
   * project deletion never has to duplicate or fall behind that logic.
   * Only walks coordinator/standalone threads   orchestration children are
   * swept as part of their coordinator's deletion.
   */
  async deleteAllThreadsInProject(projectId: string): Promise<void> {
    const projectThreads = await this.threadRepo.listForDeletionViaWorker(projectId)
    const roots = projectThreads.filter((thread) => !isOrchestrationChildThread(thread))
    for (const root of roots) {
      await this.deleteThread(projectId, root.id)
    }
  }

  /** All non-archived threads whose scope bucket equals `bucketId`. */
  private scopeOwnedThreads(projectId: string, bucketId: string): Thread[] {
    return this.threadRepo
      .listByProject(projectId, { includeArchived: false })
      .filter((thread) => (thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID) === bucketId)
  }

  /** Number of user-visible (non-orchestration-child) threads owned by a scope. */
  async countThreadsInScope(projectId: string, bucketId: string): Promise<number> {
    return this.scopeOwnedThreads(projectId, bucketId).filter(
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
    const owned = this.scopeOwnedThreads(projectId, bucketId)
    const roots = owned.filter((thread) => !isOrchestrationChildThread(thread))
    let deleted = roots.length
    for (const root of roots) {
      await this.deleteThread(projectId, root.id)
    }
    const remaining = this.scopeOwnedThreads(projectId, bucketId)
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
    const owned = this.scopeOwnedThreads(projectId, fromBucketId)
    for (const root of owned.filter((thread) => !isOrchestrationChildThread(thread))) {
      await this.updateThread(projectId, root.id, { scopeBucketId: DEFAULT_SCOPE_BUCKET_ID })
      protectedIds.add(root.id)
      moved += 1
    }
    // Sweep orphans the parent move did not cover (children whose coordinator
    // lived outside the scope).
    const leftovers = this.scopeOwnedThreads(projectId, fromBucketId)
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

  /** Remove app-owned scratch directories a deleted thread wrote to. Best-effort. */
  private async removeThreadDiskArtifacts(threads: Thread[]): Promise<void> {
    for (const thread of threads) {
      const project = this.projectRepo.get(thread.projectId)
      const dirs = threadOwnedDirectories(project, thread.projectId, thread.id)
      for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /**
   * Ids of every orchestration descendant of `threadId`   worker sub-agent
   * threads dispatched by this coordinator, transitively. Used to attribute
   * sub-agent checkpoint work to the parent thread's turn.
   */
  async listDescendantThreadIds(projectId: string, threadId: string): Promise<string[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const threads = await this.threadRepo.listForDeletionViaWorker(projectId)
    return orchestrationDescendants(threads, threadId).map((thread) => thread.id)
  }

  private async assignmentIdsFor(threads: Thread[]): Promise<Set<string>> {
    const assignmentIds = new Set(
      threads.flatMap((thread) => (thread.assignmentId ? [thread.assignmentId] : []))
    )
    if (threads.length === 0) return assignmentIds
    const threadIds = threads.map((thread) => thread.id)
    const placeholders = placeholdersFor(threadIds.length)
    const projectId = threads[0].projectId
    const result = await this.db.queryViaWorker(
      `SELECT assignment_id FROM assignment_workflow
       WHERE project_id = ? AND coordinator_thread_id IN (${placeholders})
       UNION
       SELECT assignment_id FROM assignment_versions
       WHERE project_id = ? AND coordinator_thread_id IN (${placeholders})`,
      [projectId, ...threadIds, projectId, ...threadIds],
      1_000
    )
    for (const row of result.rows) {
      const assignmentId = row['assignment_id']
      if (typeof assignmentId === 'string') assignmentIds.add(assignmentId)
    }
    return assignmentIds
  }

  async setStatus(
    projectId: string,
    threadId: string,
    status: ThreadStatus,
    opts?: { read?: boolean; error?: string; errorDetail?: string }
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    // Carry the failure's diagnostic text on the in-memory thread snapshot so
    // downstream consumers (error notifications, panels) can show what actually
    // went wrong. Never persisted: `threadUpsertParams` serializes an explicit
    // column list, so `lastError` is dropped on write and resets on restart.
    const lastError =
      status === 'failed'
        ? (() => {
            const detail = opts?.errorDetail?.trim()
            const message =
              opts?.error?.trim() ||
              existing.lastError ||
              (detail ? detail.split('\n', 1)[0]?.trim() || undefined : undefined)
            if (!message) return undefined
            return detail && detail !== message ? `${message}\n\n${detail}` : message
          })()
        : undefined

    const updated: Thread = {
      ...existing,
      status,
      scopeSortOrder:
        scopeSliceForStatus(existing.status) === scopeSliceForStatus(status)
          ? existing.scopeSortOrder
          : undefined,
      read: opts?.read ?? existing.read,
      lastError,
      updatedAt: Date.now(),
      lastActivity: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  async dismissSpecReview(
    projectId: string,
    threadId: string,
    specId: string,
    specVersion: number
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const now = Date.now()
    const updated: Thread = {
      ...existing,
      status: 'completed',
      scopeSortOrder:
        scopeSliceForStatus(existing.status) === 'done' ? existing.scopeSortOrder : undefined,
      read: true,
      dismissedSpecId: specId,
      dismissedSpecVersion: specVersion,
      updatedAt: now,
      lastActivity: now
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /**
   * Detach a worker thread from its Assignment after its task is re-dispatched
   * to a fresh worker. Keep its coordinator lineage so the retired child stays
   * hidden from ordinary thread surfaces and remains inspectable through Scope.
   * Clearing its Assignment identity still prevents a late harness error from
   * reporting as the task's current worker.
   */
  async unlinkAssignmentThread(projectId: string, threadId: string): Promise<void> {
    this.requireOwnedThread(projectId, threadId)
    this.threadRepo.updateField(threadId, 'assignment_id', null)
    this.threadRepo.updateField(threadId, 'assignment_role', null)
    this.threadRepo.updateField(threadId, 'assignment_task_id', null)
    const updated = this.threadRepo.get(threadId)
    if (updated) this.onChange?.(updated)
  }

  async setAuditState(
    projectId: string,
    threadId: string,
    auditState: Thread['auditState'],
    report?: { id: string; version: number }
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    const now = Date.now()
    const updated: Thread = {
      ...existing,
      auditState,
      ...(report
        ? { activeAuditId: report.id, activeAuditVersion: report.version }
        : auditState === undefined
          ? { activeAuditId: undefined, activeAuditVersion: undefined }
          : {}),
      updatedAt: now,
      lastActivity: now
    }
    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /**
   * Latch a deliberate user stop so no automatic resume may revive this
   * thread. The flag lives inside the persisted settings, so it survives app
   * restarts, forks, and the settings round-trips of `updateThread`.
   */
  async markStoppedByUser(projectId: string, threadId: string): Promise<void> {
    try {
      const existing = await this.getThread(projectId, threadId)
      if (!existing?.settings) return
      const settings: ThreadSettings = {
        ...existing.settings,
        stoppedByUserAt: Date.now()
      }
      await this.threadRepo.upsertViaWorker({ ...existing, settings })
      this.onChange?.({ ...existing, settings })
    } catch (error) {
      Logger.error('Stop latch could not be persisted', {
        projectId,
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** A deliberate user stop the thread has not outlived with a new prompt yet. */
  async wasStoppedByUser(projectId: string, threadId: string): Promise<boolean> {
    const thread = await this.getThread(projectId, threadId)
    return thread?.settings?.stoppedByUserAt !== undefined
  }

  /** A real user prompt re-arms automatic resumes on the thread. */
  async clearStoppedByUser(projectId: string, threadId: string): Promise<void> {
    try {
      const existing = await this.getThread(projectId, threadId)
      if (!existing || existing.settings?.stoppedByUserAt === undefined) return
      const { stoppedByUserAt: _cleared, ...settings } = existing.settings
      const updated: Thread = { ...existing, settings, updatedAt: Date.now() }
      await this.threadRepo.upsertViaWorker(updated)
      this.onChange?.(updated)
    } catch (error) {
      Logger.error('Stop latch could not be cleared', {
        projectId,
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  async setPinned(projectId: string, threadId: string, pinned: boolean): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const pinnedAt = pinned ? Date.now() : undefined
    this.threadRepo.setPinned(threadId, pinned, pinnedAt)
    const updated: Thread = { ...existing, pinned, pinnedAt, updatedAt: Date.now() }
    this.onChange?.(updated)
    return updated
  }

  async markRead(projectId: string, threadId: string): Promise<Thread> {
    const result = await this.threadRepo.markReadViaWorker(projectId, threadId)
    if (!result) {
      throw new Error(`Thread not found in project ${projectId}: ${threadId}`)
    }
    if (result.changed) this.onChange?.(result.thread)
    return result.thread
  }

  /**
   * Persist a thread's draft state: the edge-triggered `drafting` flag and the
   * debounce-committed draft content. Broadcasts a lightweight draft event so
   * every renderer keeps its draft indicators in sync
   * without the expensive full-thread reconcile that `broadcastThreadUpdate`
   * triggers - commits land while the user is actively typing.
   */
  async setDraftState(
    projectId: string,
    threadId: string,
    drafting: boolean,
    draftJson: string | null
  ): Promise<void> {
    validateEntityId(threadId, 'Thread ID')
    // Tracked by the draft-commit gate so shutdown can await the write before
    // the database closes (an in-flight commit hitting a closed DB throws).
    return trackDraftWrite(
      this.threadRepo
        .setDraftStateViaWorker(projectId, threadId, drafting, draftJson)
        .then((updated) => {
          if (updated) broadcastThreadDraftUpdated(projectId, threadId, drafting, draftJson)
        })
    )
  }

  /** Every thread currently flagged as drafting in the DB, quota-independent. */
  async listDraftingThreads(): Promise<Thread[]> {
    return this.threadRepo.listDraftingThreadsViaWorker()
  }

  /** Persist the thread's agent settings (harness, model, thinking, permissions). */
  async updateSettings(
    projectId: string,
    threadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    // The independent audit owns the thread's workflow: engineering modes are
    // locked out for the thread's lifetime once it is enabled.
    if (
      existing.independentAudit === true &&
      (settings.assignmentMode === true || settings.loopMode === true)
    ) {
      throw new Error('Engineering modes are locked while the independent audit is enabled.')
    }

    const loopWasEnabled = existing.settings?.loopMode === true
    const loopIsEnabled = settings.loopMode === true
    const updated: Thread = {
      ...existing,
      settings,
      loopIteration: loopIsEnabled
        ? loopWasEnabled
          ? (existing.loopIteration ?? 0)
          : 0
        : existing.loopIteration,
      updatedAt: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /**
   * Persist the thread's last-known usage snapshot. No onChange broadcast: the
   * meter commits too often (every quiet second of a long turn) for every write
   * to re-render the sidebar, and the snapshot is only needed to seed the next
   * mount. The row is deleted with the thread, so no orphan cleanup is needed.
   *
   * The write runs on the database worker with ownership inlined into the SQL
   * guard, so this hot path never reads a full thread row (or its harness_usage
   * GROUP BY) on the main thread just to decide whether to persist.
   */
  async setContextUsage(
    projectId: string,
    threadId: string,
    contextUsage: ThreadContextUsage
  ): Promise<void> {
    await this.threadRepo.updateContextUsageViaWorker(projectId, threadId, contextUsage)
  }

  async setLoopIteration(
    projectId: string,
    threadId: string,
    loopIteration: number
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    const updated: Thread = { ...existing, loopIteration, updatedAt: Date.now() }
    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /**
   * Enable or disable the independent (spec-less) audit for a thread.
   *
   * Enabling requires prior work (a bound session or mirrored conversation),
   * excludes orchestration threads, and is rejected while an Engineering
   * lifecycle selection is active   the two workflows are mutually exclusive.
   * Once the first audit run has started (`independentAuditInitialized`), the
   * audit stays enabled for the thread's lifetime. The flag is deliberately a
   * `Thread` field, not a `ThreadSettings` entry, so forks and new threads
   * never inherit it.
   */
  async setIndependentAudit(
    projectId: string,
    threadId: string,
    enabled: boolean
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    if (isOrchestrationChildThread(existing)) {
      throw new Error('Independent audit is not available on orchestration threads.')
    }
    if (!enabled && existing.independentAuditInitialized === true) {
      throw new Error('The independent audit has started and stays enabled for this thread.')
    }
    if (enabled && existing.independentAudit !== true) {
      const lifecycle = this.engineeringLifecycleEngine.get(projectId, threadId)
      if ((lifecycle && lifecycle.selection !== 'none') || lifecycle?.startedAt !== undefined) {
        throw new Error(
          'Independent audit excludes Engineering modes   turn them off first or fork the thread.'
        )
      }
      const hasWork =
        existing.sessionId !== undefined ||
        this.agentMessageRepo.countConversationByThread(threadId) > 0
      if (!hasWork) {
        throw new Error('The independent audit becomes available once the thread has work.')
      }
    }
    const updated: Thread = {
      ...existing,
      independentAudit: enabled,
      updatedAt: Date.now()
    }
    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }

  /** Bind a harness session id to the thread, recording the harness that owns it. */
  async setSessionId(
    projectId: string,
    threadId: string,
    sessionId: string,
    harnessId?: string,
    accountId?: string
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = {
      ...existing,
      sessionId,
      ...(harnessId ? { sessionHarnessId: harnessId } : {}),
      ...(accountId ? { sessionAccountId: accountId } : {}),
      updatedAt: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    return updated
  }

  /** Unbind the harness session   the next prompt starts a fresh one. */
  async clearSessionId(projectId: string, threadId: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = { ...existing, updatedAt: Date.now() }
    delete updated.sessionId
    delete updated.sessionHarnessId
    delete updated.sessionAccountId

    await this.threadRepo.upsertViaWorker(updated)
    return updated
  }

  /**
   * Persist the mirrored agent conversation (rich messages) for offline access.
   * Runs as one atomic transaction on the worker's connection when available
   * (falls back to the primary connection).
   */
  async saveMessages(projectId: string, threadId: string, messages: AgentMessage[]): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    return this.transcripts.saveMessages(threadId, messages)
  }

  /**
   * Add or update mirrored messages without replacing the transcript.
   *
   * Provider retries can finish out of order. Their snapshots must not delete
   * user messages persisted by a newer turn while the older request was in
   * flight.
   *
   * The provider transcript is synchronized incrementally: only new or changed
   * messages are written inside one transaction, keyed by a persisted provider
   * cursor for the thread's current harness session. In production this runs on
   * the database maintenance worker so the reconciliation never blocks the
   * main process; the primary connection is the fallback. Returns the delta
   * outcome.
   */
  async upsertMessages(
    projectId: string,
    threadId: string,
    messages: AgentMessage[],
    sessionId?: string
  ): Promise<ProviderDeltaSyncResult> {
    const thread = this.getOwnedThread(projectId, threadId)
    if (!thread) {
      return {
        applied: 0,
        skipped: 0,
        collisions: 0,
        total: 0,
        cursor: null,
        noop: false
      }
    }
    return this.transcripts.upsertMessages(
      projectId,
      threadId,
      sessionId ?? thread.sessionId ?? '',
      messages
    )
  }

  /** Load the mirrored agent conversation, or an empty list when absent. */
  async loadMessages(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.transcripts.loadMessages(threadId)
  }

  /** Load one bounded page of mirrored conversation history, newest page first. */
  async loadMessagePage(
    projectId: string,
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): Promise<ThreadMessagePage> {
    if (!this.getOwnedThread(projectId, threadId)) return { messages: [], hasOlder: false }
    return this.transcripts.loadMessagePage(threadId, before, limit)
  }

  /** Load a contiguous mirrored window centered on an arbitrary message id. */
  async loadMessagePageAround(
    projectId: string,
    threadId: string,
    anchorId: string,
    limit: number
  ): Promise<ThreadMessagePage> {
    if (!this.getOwnedThread(projectId, threadId)) {
      return { messages: [], hasOlder: false, hasNewer: false }
    }
    return this.transcripts.loadMessagePageAround(threadId, anchorId, limit)
  }

  /** Load every mirrored user-authored conversation message, oldest to newest. */
  async loadUserMessages(projectId: string, threadId: string): Promise<UserMessageSummary[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.transcripts.loadUserMessages(projectId, threadId)
  }

  /** Load every parent-session record, including hidden transport-only prompts. */
  async loadMessageRecords(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.transcripts.loadMessageRecords(threadId)
  }

  /**
   * Persist one provider-neutral child-agent transcript for durable audit.
   * Runs as one atomic worker transaction when available.
   */
  async saveSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    return this.transcripts.saveSubagentMessages(threadId, sessionId, messages)
  }

  /** Load a mirrored child-agent transcript without contacting the provider. */
  async loadSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.transcripts.loadSubagentMessages(threadId, sessionId)
  }

  /** List threads across all projects, sorted pinned-first then by last activity. */
  async listAllThreads(options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listAllViaWorker(options)
  }

  /** Bounded first-paint list without optional harness-usage decoration. */
  async listThreadsForHydration(options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listAllForHydrationViaWorker(options)
  }

  /** Thread list for the sidebar: worker-backed like listThreadsForHydration,
   *  but with harness-usage decoration so multi-harness rows can render their
   *  second line. The usage query is a single batched GROUP BY on the worker,
   *  so it does not reintroduce the main-thread stall this path once had. */
  async listThreadsForSidebar(options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listAllViaWorker(options)
  }

  /**
   * Bounded per-project recent-thread list for sidebar hydration. The inbox
   * (Chats) project gets its configured `thread_limit` quota; every other
   * project gets `RECENT_THREADS_PER_PROJECT`. Older rows stay reachable via
   * `listProjectThreads` paging. Unread threads bypass every quota so they
   * always surface in the first-paint slice regardless of age.
   */
  async listRecentPerProject(): Promise<Thread[]> {
    return this.threadRepo.listRecentPerProjectViaWorker((projectId) =>
      projectId === INBOX_PROJECT_ID ? Number.MAX_SAFE_INTEGER : RECENT_THREADS_PER_PROJECT
    )
  }

  /** Paged threads for one project: the project filter is applied in SQL
   *  before the limit, so "load more" always reaches the project's older rows. */
  async listProjectThreads(projectId: string, options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listByProjectViaWorker(projectId, {
      includeArchived: false,
      order: 'activity',
      ...options
    })
  }

  /**
   * Deterministic thread-capacity view for the current project. Exposes the
   * limit, active/protected counts, and how many threads could be deleted to
   * make room   so the UI can explain a protected-capacity refusal.
   */
  async getThreadCapacity(projectId: string): Promise<ThreadCapacity> {
    const project = this.projectRepo.get(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const threads = this.threadRepo.listByProject(projectId)
    const logicalThreads = threads.filter((thread) => !isOrchestrationChildThread(thread))
    const active = logicalThreads.filter((thread) => !thread.archived)
    const scopedBuckets = scopedBucketIdsFromBoard(this.scopeManager.getBoard(projectId))
    // Threads in pinned-like scopes live in their own per-scope buckets and are
    // reported separately; the regular bucket holds every other thread.
    return buildThreadCapacity(project.threadLimit, active, scopedBuckets)
  }

  /**
   * Full-text search across thread titles and conversation content
   * (user messages + agent final output). Project-scoped when projectId is set.
   * Runs the FTS queries on the worker's connection (serialized) with a
   * primary-connection fallback.
   */
  async searchThreads(
    query: string,
    options: { projectId?: string; limit?: number } = {}
  ): Promise<import('../types').ThreadSearchResult[]> {
    return this.searchService.search(query, options)
  }

  /**
   * Fork a thread into a new conversation. When `targetProjectId` is provided
   * the fork is created in that project instead of the source project   used to
   * continue a standalone chat inside a real project.
   */
  async forkThread(
    projectId: string,
    threadId: string,
    title: string,
    checkpointId?: string,
    messageId?: string,
    targetProjectId?: string
  ): Promise<Thread> {
    const parent = this.requireOwnedThread(projectId, threadId)
    return this.forks.fork({
      projectId,
      parent,
      title,
      checkpointId,
      messageId,
      targetProjectId
    })
  }
}
