import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { generateId, getConfigRoot } from '../utils'
import { THREAD_SCOPED_TABLES } from './thread-cleanup-registry'
import { threadOwnedDirectories } from '../thread-storage-paths'
import { rm } from 'fs/promises'
import { messageId as createMessageId } from '../id'
import { featureSlugFromTitle } from '../project-artifacts'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { HarnessUsageRepo } from '../../main/database/repositories/harness-usage-repo'
import { EngineeringLifecycleEngine } from './engineering-lifecycle-engine'
import {
  AgentMessageRepo,
  type ProviderDeltaSyncResult,
  buildLoadAllPageSql,
  buildLoadByThreadPageSql,
  buildLoadPageSql,
  buildLoadSessionPageSql,
  buildLoadUserMessagesPageSql,
  buildSaveMessagesStatements,
  buildSaveSubagentStatements,
  mapMessageRows,
  mapUserMessageRows
} from '../../main/database/repositories/agent-message-repo'
import {
  buildThreadSearchSql,
  mergeThreadSearchResults,
  ThreadRepo,
  type ThreadCapacityCandidate
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
  type AgentPart,
  type ThreadMessageCursor,
  type ThreadMessagePage,
  type UserMessageSummary,
  isOrchestrationChildThread,
  isManagedScopeRoot,
  type ScopeBoard
} from '../types'

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

function isProtectedFromAutomaticCleanup(thread: Pick<Thread, 'pinned' | 'status'>): boolean {
  return thread.pinned || thread.status === 'spec'
}

/**
 * Sentinel bucket id for threads that do not belong to a pinned-like scope.
 * All non-pinned-like scopes (including the default scope) share this single
 * regular bucket, capped at the project thread limit.
 */
const REGULAR_BUCKET = '__regular_bucket__'

/**
 * A scope gets its own thread bucket when it is pinned on the board OR its
 * root is an app-managed Git worktree. Reads the board lazily per use; the
 * scope board is a single JSON row, so this is cheap.
 */
function scopedBucketIdsFromBoard(board: ScopeBoard): Set<string> {
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
function bucketForThread(
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

type SqlStatement = { sql: string; params: unknown[] }

function placeholdersFor(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** Build one set-based cleanup transaction for a thread tree. */
function buildThreadDeletionStatements(
  threads: Thread[],
  assignmentIds: Set<string>
): SqlStatement[] {
  if (threads.length === 0) return []

  const threadIds = threads.map((thread) => thread.id)
  const threadPlaceholders = placeholdersFor(threadIds.length)
  const projectId = threads[0].projectId
  const statements: SqlStatement[] = []
  const assignmentValues = [...assignmentIds]

  // Pending turn-feedback rows are NOT resolved here: they keep their captured
  // grading payload (their thread reference is SET NULL) and are judged by the
  // LLM grader immediately after deletion — a lost-cause thread never scores
  // as a pass just because it was deleted.

  if (assignmentValues.length > 0) {
    const assignmentPlaceholders = placeholdersFor(assignmentValues.length)
    statements.push(
      {
        sql: `DELETE FROM assignment_operations WHERE assignment_id IN (${assignmentPlaceholders})`,
        params: assignmentValues
      },
      {
        sql: `DELETE FROM assignment_coordinator_snapshots WHERE assignment_id IN (${assignmentPlaceholders})`,
        params: assignmentValues
      }
    )
  }

  const capabilityPredicate =
    assignmentValues.length > 0
      ? `assignment_id IN (${placeholdersFor(assignmentValues.length)}) OR thread_id IN (${threadPlaceholders})`
      : `thread_id IN (${threadPlaceholders})`
  statements.push({
    sql: `DELETE FROM assignment_api_capabilities WHERE ${capabilityPredicate}`,
    params: assignmentValues.length > 0 ? [...assignmentValues, ...threadIds] : threadIds
  })

  // Every table that stores a bare `thread_id` column *without* a real
  // `ON DELETE CASCADE` foreign key to `threads` must be registered in
  // `THREAD_SCOPED_TABLES` (thread-cleanup-registry.ts). Tables with a real
  // FK clean themselves up via SQLite cascade (PRAGMA foreign_keys = ON is
  // set on every connection) and never need an entry here.
  for (const table of THREAD_SCOPED_TABLES) {
    if (table.projectColumn) {
      statements.push({
        sql: `DELETE FROM ${table.table} WHERE ${table.projectColumn} = ? AND ${table.threadColumn} IN (${threadPlaceholders})`,
        params: [projectId, ...threadIds]
      })
    } else {
      statements.push({
        sql: `DELETE FROM ${table.table} WHERE ${table.threadColumn} IN (${threadPlaceholders})`,
        params: threadIds
      })
    }
  }

  statements.push({
    sql: `DELETE FROM threads WHERE id IN (${threadPlaceholders})`,
    params: threadIds
  })

  return statements
}

/**
 * Re-key copied messages and their parts so they can live in a new thread
 * without colliding with the originals. Used when forking a thread or when
 * promoting a temporary (quick) chat into a regular thread.
 */
export function remapCopiedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    const newId = createMessageId()
    const remapPart = (part: AgentPart): AgentPart => {
      if (!('messageID' in part)) return part
      const previous = part.id.includes(msg.id)
        ? part.id.replace(msg.id, newId)
        : `${newId}-${part.id}`
      return { ...part, id: previous, messageID: newId }
    }
    return {
      ...msg,
      id: newId,
      parts: msg.parts.map(remapPart),
      transportParts: msg.transportParts?.map(remapPart)
    }
  })
}

/**
 * Keep the latest completed compaction and everything after it. A compaction
 * replaces the harness context that preceded it, so older mirrored messages
 * are unnecessary when creating a new branch from this history.
 */
function historyFromLatestCompaction(messages: AgentMessage[]): AgentMessage[] {
  const latestCompactionIndex = messages.findLastIndex((message) =>
    message.parts.some(
      (part) =>
        part.type === 'compaction-summary' ||
        (part.type === 'compaction' &&
          typeof part.summary === 'string' &&
          part.summary.trim().length > 0)
    )
  )
  return latestCompactionIndex === -1 ? messages : messages.slice(latestCompactionIndex)
}

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

  /**
   * Per-thread cache of the full user-message jump list (keyed by
   * `${projectId}:${threadId}`), populated on first async worker-backed load
   * and busted only when a new user message is applied to that thread or the
   * thread is deleted — repeated menu-opens never re-scan the database.
   */
  private readonly userMessageHistoryCache = new Map<string, UserMessageSummary[]>()

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
  }

  /** Reads scope boards to keep pinned scopes outside the thread bucket. */
  private readonly scopeManager: ScopeManager

  /**
   * Set by the ChatEngine so deleting a thread closes its open ranking
   * snapshot conversation for immediate grading before the thread foreign
   * key is detached — deletion is the conversation close signal.
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
    messages: AgentMessage[]
  ): Promise<{ ok: boolean; error?: string }> {
    return this.harnessUsageRepo.accumulateTurn(projectId, threadId, messages)
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
      const bucketCount = active.filter(
        (candidate) => bucketForThread(candidate, scopedBuckets) === newThreadBucket
      ).length
      let toEvictId: string | undefined
      if (!creatingOrchestrationChild && bucketCount >= project.threadLimit) {
        const toEvict = active.find(
          (candidate) =>
            bucketForThread(candidate, scopedBuckets) === newThreadBucket &&
            !isProtectedFromAutomaticCleanup(candidate)
        )
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
   * it — and can be dragged back above again. Unlike the batch reorder, this
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
   * pinned_at is rewritten — nothing else, so it stays consistent across every
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
   * first id becomes most-recently pinned (top). Only pinned_at is rewritten —
   * nothing else — so pin order stays consistent across every surface and a
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
    const deletionOrder = [...this.orchestrationDescendants(projectThreads, threadId), thread]
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
      this.userMessageHistoryCache.delete(this.userMessageHistoryCacheKey(projectId, candidate.id))
    }
    await this.removeThreadDiskArtifacts(deletionOrder)
    await this.onDeleted?.(deletionOrder)
  }

  /**
   * Delete every thread in a project through the same path as
   * `deleteThread` (session teardown, DB row cleanup, disk artifacts), so
   * project deletion never has to duplicate or fall behind that logic.
   * Only walks coordinator/standalone threads — orchestration children are
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

  private orchestrationDescendants(threads: Thread[], coordinatorThreadId: string): Thread[] {
    const byCoordinator = new Map<string, Thread[]>()
    for (const thread of threads) {
      if (!thread.coordinatorThreadId) continue
      const children = byCoordinator.get(thread.coordinatorThreadId) ?? []
      children.push(thread)
      byCoordinator.set(thread.coordinatorThreadId, children)
    }
    const descendants: Thread[] = []
    const visit = (parentId: string): void => {
      const children = (byCoordinator.get(parentId) ?? []).sort(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )
      for (const child of children) {
        visit(child.id)
        descendants.push(child)
      }
    }
    visit(coordinatorThreadId)
    return descendants
  }

  /**
   * Ids of every orchestration descendant of `threadId` — worker sub-agent
   * threads dispatched by this coordinator, transitively. Used to attribute
   * sub-agent checkpoint work to the parent thread's turn.
   */
  async listDescendantThreadIds(projectId: string, threadId: string): Promise<string[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const threads = await this.threadRepo.listForDeletionViaWorker(projectId)
    return this.orchestrationDescendants(threads, threadId).map((thread) => thread.id)
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
    opts?: { read?: boolean }
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = {
      ...existing,
      status,
      scopeSortOrder:
        scopeSliceForStatus(existing.status) === scopeSliceForStatus(status)
          ? existing.scopeSortOrder
          : undefined,
      read: opts?.read ?? existing.read,
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
   * lifecycle selection is active — the two workflows are mutually exclusive.
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
      if (
        (lifecycle && lifecycle.selection !== 'none') ||
        lifecycle?.startedAt !== undefined
      ) {
        throw new Error(
          'Independent audit excludes Engineering modes — turn them off first or fork the thread.'
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
    harnessId?: string
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = {
      ...existing,
      sessionId,
      ...(harnessId ? { sessionHarnessId: harnessId } : {}),
      updatedAt: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    return updated
  }

  /** Unbind the harness session — the next prompt starts a fresh one. */
  async clearSessionId(projectId: string, threadId: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = { ...existing, updatedAt: Date.now() }
    delete updated.sessionId
    delete updated.sessionHarnessId

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
    // Batch the statements so one huge transcript never materializes a single
    // multi-megabyte transaction payload in memory. Every batch is its own
    // transaction; the delete+upsert sequence below preserves the same
    // end state because the delete always precedes the first upsert batch.
    const statements = buildSaveMessagesStatements(threadId, messages)
    const BATCH = 64
    for (let offset = 0; offset < statements.length; offset += BATCH) {
      const batch = statements.slice(offset, offset + BATCH)
      const outcome = await this.db.transactionViaWorker(batch)
      if (!outcome.ok) {
        // Fallback: identical batching semantics on the primary connection.
        this.db.transaction(() => {
          for (const statement of batch) {
            this.db.run(statement.sql, ...statement.params)
          }
        })
      }
    }
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
    const resolvedSessionId = sessionId ?? thread.sessionId ?? ''
    const result = await this.db.syncProviderDeltasViaWorker(threadId, resolvedSessionId, messages)
    if (result.applied > 0 && messages.some((message) => message.role === 'user')) {
      this.userMessageHistoryCache.delete(this.userMessageHistoryCacheKey(projectId, threadId))
    }
    return result
  }

  private userMessageHistoryCacheKey(projectId: string, threadId: string): string {
    return `${projectId}:${threadId}`
  }

  /** Load the mirrored agent conversation, or an empty list when absent. */
  async loadMessages(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const page = await this.pagedMessageRows((after) => buildLoadByThreadPageSql(threadId, after))
    if (!page.ok) return this.agentMessageRepo.loadByThread(threadId)
    return mapMessageRows(page.rows)
  }

  /** Load one bounded page of mirrored conversation history, newest page first. */
  async loadMessagePage(
    projectId: string,
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): Promise<ThreadMessagePage> {
    if (!this.getOwnedThread(projectId, threadId)) return { messages: [], hasOlder: false }
    const built = buildLoadPageSql(threadId, before)
    const result = await this.db.queryViaWorker(built.sql, built.params, limit + 1)
    if (result.ok) {
      const hasOlder = result.rows.length > limit
      const pageRows = hasOlder ? result.rows.slice(0, limit) : result.rows
      return { messages: mapMessageRows(pageRows).reverse(), hasOlder }
    }
    return this.agentMessageRepo.loadPageByThread(threadId, before, limit)
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
    return this.loadPageAroundViaWorker(threadId, anchorId, limit)
  }

  /** Load every mirrored user-authored conversation message, oldest to newest. */
  async loadUserMessages(projectId: string, threadId: string): Promise<UserMessageSummary[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const cacheKey = this.userMessageHistoryCacheKey(projectId, threadId)
    const cached = this.userMessageHistoryCache.get(cacheKey)
    if (cached) return cached
    const page = await this.pagedMessageRows((after) =>
      buildLoadUserMessagesPageSql(threadId, after)
    )
    if (!page.ok) return this.agentMessageRepo.loadUserMessagesByThread(threadId)
    const history = mapUserMessageRows(page.rows)
    this.userMessageHistoryCache.set(cacheKey, history)
    return history
  }

  /** Load every parent-session record, including hidden transport-only prompts. */
  async loadMessageRecords(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const page = await this.pagedMessageRows((after) => buildLoadAllPageSql(threadId, after))
    if (!page.ok) return this.agentMessageRepo.loadAllByThread(threadId)
    return mapMessageRows(page.rows, true)
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
    const outcome = await this.db.transactionViaWorker(
      buildSaveSubagentStatements(threadId, sessionId, messages)
    )
    if (!outcome.ok) {
      this.db.transaction(() => {
        for (const statement of buildSaveSubagentStatements(threadId, sessionId, messages)) {
          this.db.run(statement.sql, ...statement.params)
        }
      })
    }
  }

  /** Load a mirrored child-agent transcript without contacting the provider. */
  async loadSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    const page = await this.pagedMessageRows((after) =>
      buildLoadSessionPageSql(threadId, sessionId, after)
    )
    if (!page.ok) return this.agentMessageRepo.loadBySession(threadId, sessionId)
    return mapMessageRows(page.rows)
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
   * Deterministic thread-capacity view for the current project. Exposes the
   * limit, active/protected counts, and how many threads could be deleted to
   * make room — so the UI can explain a protected-capacity refusal.
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
    const regular = active.filter(
      (thread) =>
        bucketForThread({ scopeBucketId: thread.scopeBucketId }, scopedBuckets) === REGULAR_BUCKET
    )
    return {
      limit: project.threadLimit,
      activeCount: regular.length,
      pinnedCount: regular.filter((t) => t.pinned).length,
      protectedCount: regular.filter((t) => isProtectedFromAutomaticCleanup(t)).length,
      deletableCount: regular.filter((t) => !isProtectedFromAutomaticCleanup(t)).length,
      pinnedScopeCount: active.length - regular.length
    }
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
    const raw = query.trim()
    if (!raw) return []
    const built = buildThreadSearchSql(raw, options)
    const title = await this.db.queryViaWorker(built.title.sql, built.title.params, built.limit)
    if (!title.ok) return this.threadRepo.search(query, options)
    if (!built.fts) {
      return mergeThreadSearchResults(title.rows, [], raw, built.limit)
    }
    const message = await this.db.queryViaWorker(
      built.fts.sql,
      built.fts.params,
      Math.min(built.limit * 4, 200)
    )
    if (!message.ok) return this.threadRepo.search(query, options)
    return mergeThreadSearchResults(title.rows, message.rows, raw, built.limit)
  }

  /**
   * Fork a thread into a new conversation. When `targetProjectId` is provided
   * the fork is created in that project instead of the source project — used to
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
    const destinationProjectId = targetProjectId ?? projectId
    if (destinationProjectId !== projectId) {
      const destination = this.projectRepo.get(destinationProjectId)
      if (!destination) throw new Error(`Project not found: ${destinationProjectId}`)
    }
    // Forking can copy a large transcript. Use the worker-backed paged reader
    // instead of running the unbounded repository query on Electron's main
    // connection while active agent streams remain responsive.
    const parentMessages = await this.loadMessageRecords(projectId, threadId)
    let copied = parentMessages
    if (messageId) {
      const cutoff = parentMessages.findIndex((message) => message.id === messageId)
      if (cutoff === -1) {
        throw new Error(`Cannot fork from message ${messageId}: message not found in thread`)
      }
      copied = parentMessages.slice(0, cutoff + 1)
    }
    copied = historyFromLatestCompaction(copied)

    const destinationPath = this.projectRepo.get(destinationProjectId)?.path ?? ''
    const forkScopeBucketId = destinationProjectId === projectId ? parent.scopeBucketId : undefined
    const forked = await this.createThread({
      projectId: destinationProjectId,
      providerId: parent.providerId,
      title,
      titleSource: 'manual',
      settings: parent.settings,
      // Forks into another project (e.g. a chat continued in a project) never
      // inherit the parent's feature work-directory or scope bucket.
      featureSlug:
        destinationProjectId === projectId
          ? (parent.featureSlug ?? featureSlugFromTitle(parent.title))
          : undefined,
      scopeBucketId: forkScopeBucketId,
      workingDirectory:
        destinationProjectId === projectId ? parent.workingDirectory : destinationPath
    })
    // Same-scope forks re-resolve their compatibility directory from the
    // destination scope inside `createThread`, so a stale parent directory
    // can never override the authoritative root.
    // A fork of an Engineering thread must open with the same switches lit:
    // carry the parent's stage selection (and Auto Pilot) into the fork so
    // the toolbox reflects exactly what the user had turned on.
    {
      const sourceLifecycle = this.engineeringLifecycleEngine.get(projectId, threadId)
      if (sourceLifecycle && sourceLifecycle.selection !== 'none') {
        try {
          this.engineeringLifecycleEngine.select(destinationProjectId, forked.id, {
            stages: sourceLifecycle.selectedStages ?? [],
            autopilot: sourceLifecycle.autopilot === true
          })
        } catch {
          // Lifecycle inheritance is cosmetic — never fail the fork on it.
        }
      }
    }
    if (copied.length > 0) {
      // Yield the main-process event loop before the copy so an active agent
      // stream (or the renderer) is never starved by the fork's serialization
      // work, even for a large legacy transcript.
      await new Promise<void>((resolve) => setImmediate(resolve))
      const withNewIds = remapCopiedMessages(copied)
      await this.saveMessages(destinationProjectId, forked.id, withNewIds)
    }

    // A fork carries the parent's history, so it is a completed thread, not an
    // empty "New Thread" draft. Keep it out of the todo slice and out of the
    // renderer's empty-new-thread reuse logic; it becomes active again only
    // when the user actually writes on it.
    const completed = await this.setStatus(destinationProjectId, forked.id, 'completed', {
      read: true
    })

    // Link fork to parent via branch metadata
    const branchMeta = {
      parentThreadId: threadId,
      checkpointId: checkpointId ?? null,
      messageId: messageId ?? null,
      forkedAt: Date.now()
    }

    const branchDir = join(
      getConfigRoot(),
      'projects',
      destinationProjectId,
      'threads',
      forked.id,
      'branches'
    )
    await mkdir(branchDir, { recursive: true })
    await writeFile(join(branchDir, 'origin.json'), JSON.stringify(branchMeta, null, 2))

    return completed
  }

  // ── Worker-routed paged reads ───────────────────────────────────────────

  /** Bounded page size for worker transcript reads. */
  private static readonly TRANSCRIPT_PAGE_SIZE = 1000
  /** Safety cap on the number of cursor pages read through the worker. */
  private static readonly MAX_TRANSCRIPT_PAGES = 100_000

  /**
   * Read the full row set by cursor-paging through the worker in bounded
   * chunks, so no single worker query is unbounded (no `maxRows = 0`). Returns
   * `ok: false` when the worker path is unavailable so the caller can fall back.
   */
  private async pagedMessageRows(
    buildPage: (after: ThreadMessageCursor | undefined) => { sql: string; params: unknown[] }
  ): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false }> {
    const rows: Record<string, unknown>[] = []
    let after: ThreadMessageCursor | undefined
    for (let page = 0; page < ThreadManager.MAX_TRANSCRIPT_PAGES; page++) {
      const built = buildPage(after)
      const result = await this.db.queryViaWorker(
        built.sql,
        built.params,
        ThreadManager.TRANSCRIPT_PAGE_SIZE
      )
      if (!result.ok) return { ok: false }
      rows.push(...result.rows)
      if (!result.truncated || result.rows.length === 0) break
      if (result.rows.length < ThreadManager.TRANSCRIPT_PAGE_SIZE) break
      const last = result.rows[result.rows.length - 1]
      after = { createdAt: Number(last.created_at), id: String(last.id) }
    }
    return { ok: true, rows }
  }

  /** Centered window around a message id, read through bounded worker queries. */
  private async loadPageAroundViaWorker(
    threadId: string,
    anchorId: string,
    limit: number
  ): Promise<ThreadMessagePage> {
    const anchor = await this.db.queryViaWorker(
      'SELECT created_at FROM agent_messages WHERE thread_id = ? AND id = ?',
      [threadId, anchorId],
      1
    )
    if (!anchor.ok || anchor.rows.length === 0) {
      return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    }
    const anchorCreatedAt = Number(anchor.rows[0].created_at)
    const half = Math.max(1, Math.floor(limit / 2))
    const cursor = (older: boolean): string =>
      older
        ? ` AND (created_at < ? OR (created_at = ? AND id < ?))`
        : ` AND (created_at > ? OR (created_at = ? AND id > ?))`
    const order = (older: boolean): string => (older ? 'DESC, id DESC' : 'ASC, id ASC')
    const older = await this.db.queryViaWorker(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation','working_trace')${cursor(true)}
       ORDER BY created_at ${order(true)}`,
      [threadId, anchorCreatedAt, anchorCreatedAt, anchorId],
      half + 1
    )
    if (!older.ok) return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const newer = await this.db.queryViaWorker(
      `SELECT * FROM agent_messages
       WHERE thread_id = ? AND session_id IS NULL
         AND visibility IN ('conversation','working_trace')${cursor(false)}
       ORDER BY created_at ${order(false)}`,
      [threadId, anchorCreatedAt, anchorCreatedAt, anchorId],
      half + 1
    )
    if (!newer.ok) return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const anchorRow = await this.db.queryViaWorker(
      'SELECT * FROM agent_messages WHERE thread_id = ? AND id = ?',
      [threadId, anchorId],
      1
    )
    if (!anchorRow.ok)
      return this.agentMessageRepo.loadPageAroundByThread(threadId, anchorId, limit)
    const olderRows = older.rows
    const newerRows = newer.rows
    const hasOlder = olderRows.length > half
    const hasNewer = newerRows.length > half
    const rows = [
      ...olderRows.slice(0, half).reverse(),
      ...(anchorRow.rows.length > 0 ? [anchorRow.rows[0]] : []),
      ...newerRows.slice(0, half)
    ]
    return { messages: mapMessageRows(rows), hasOlder, hasNewer }
  }
}
