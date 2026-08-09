import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { generateId, getConfigRoot } from '../utils'
import { messageId as createMessageId } from '../id'
import { featureSlugFromTitle } from '../project-artifacts'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { HarnessUsageRepo } from '../../main/database/repositories/harness-usage-repo'
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
  ThreadRepo
} from '../../main/database/repositories/thread-repo'
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
  isOrchestrationChildThread
} from '../types'

/**
 * Raised when `createThread` is asked to exceed a project's thread limit while
 * every active thread is pinned. Deliberately explicit: no thread is silently
 * deleted and no thread is silently created past the bound.
 */
export class AllThreadsPinnedError extends Error {
  constructor(
    readonly projectId: string,
    readonly limit: number,
    readonly activeCount: number
  ) {
    super(
      `Cannot create a thread: every active thread is pinned (${activeCount}/${limit}). ` +
        'Unpin or delete an existing thread first.'
    )
    this.name = 'AllThreadsPinnedError'
  }
}

/** Deterministic view of a project's thread capacity for the UI. */
export interface ThreadCapacity {
  limit: number
  activeCount: number
  pinnedCount: number
  deletableCount: number
}

/** Paging/visibility controls for thread listings. */
export interface ThreadListOptions {
  limit?: number
  offset?: number
  includeArchived?: boolean
  /** Row ordering: `default` (manual reorder) or `activity` (recent-first). */
  order?: 'default' | 'activity'
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

export class ThreadManager {
  private threadRepo: ThreadRepo
  private projectRepo: ProjectRepo
  private agentMessageRepo: AgentMessageRepo
  private harnessUsageRepo: HarnessUsageRepo

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
    private onDeleted?: (threads: Thread[]) => void | Promise<void>
  ) {
    this.threadRepo = new ThreadRepo(db)
    this.projectRepo = new ProjectRepo(db)
    this.agentMessageRepo = new AgentMessageRepo(db)
    this.harnessUsageRepo = new HarnessUsageRepo(db)
  }

  /** Distinct harness ids used across a thread's session, newest first. */
  usedHarnessIds(threadId: string): string[] {
    return this.harnessUsageRepo.harnessIdsFor(threadId)
  }

  /** Cumulative per-harness usage rows for a thread. */
  harnessUsageFor(projectId: string, threadId: string): import('../types').HarnessUsage[] {
    return this.harnessUsageRepo.listByThread(projectId, threadId)
  }

  /** Accumulate a completed turn's harness usage (ledger-guarded, idempotent). */
  accumulateHarnessUsage(projectId: string, threadId: string, messages: AgentMessage[]): void {
    this.harnessUsageRepo.accumulateTurn(projectId, threadId, messages)
  }

  /** Rebuild a thread's harness usage rows from its persisted messages. */
  reconcileHarnessUsage(projectId: string, threadId: string): void {
    this.harnessUsageRepo.reconcile(projectId, threadId)
  }

  /** Rebuild harness usage for every thread that has assistant messages. */
  reconcileAllHarnessUsage(): void {
    this.harnessUsageRepo.reconcileAll()
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

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const project = this.projectRepo.get(input.projectId)
    if (!project) {
      throw new Error(`Project not found: ${input.projectId}`)
    }
    const threadLimit = project.threadLimit

    const existing = this.threadRepo.listByProject(input.projectId)
    const active = existing.filter(
      (thread) => !thread.archived && !isOrchestrationChildThread(thread)
    )
    const creatingOrchestrationChild =
      input.assignmentRole === 'worker' ||
      input.achievementRole === 'auditor' ||
      input.coordinatorThreadId !== undefined
    if (!creatingOrchestrationChild && active.length >= threadLimit) {
      const unpinned = active
        .filter((t) => !t.pinned)
        .sort((a, b) => a.lastActivity - b.lastActivity)
      const toEvict = unpinned[0]
      if (toEvict) {
        // The bounded bucket is destructive by design: permanently delete the
        // oldest unpinned logical task and every private orchestration child.
        await this.deleteThread(input.projectId, toEvict.id)
      } else {
        // Every active thread is pinned — refuse deterministically instead of
        // silently exceeding the limit.
        throw new AllThreadsPinnedError(input.projectId, threadLimit, active.length)
      }
    }

    const id = generateId()
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

    this.threadRepo.upsert(thread)

    return thread
  }

  async getThread(projectId: string, threadId: string): Promise<Thread | null> {
    const thread = this.getOwnedThread(projectId, threadId)
    if (thread && !thread.titleSource) {
      thread.titleSource = 'default'
    }
    return thread
  }

  async listThreads(projectId: string, options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listByProject(projectId, options)
  }

  async reorderThreads(projectId: string, orderedIds: string[]): Promise<Thread[]> {
    this.threadRepo.batchUpdateSortOrder(orderedIds)
    const threads = orderedIds.map((threadId) => this.requireOwnedThread(projectId, threadId))
    for (const thread of threads) {
      this.onChange?.(thread)
    }
    return threads
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

    const updatedThreads: Thread[] = []
    for (let index = 0; index < canonicalOrder.length; index++) {
      const existing = canonicalOrder[index]
      if (existing.scopeSortOrder !== index) {
        const updated: Thread = { ...existing, scopeSortOrder: index }
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
      >
    >
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = {
      ...existing,
      title: input.title ?? existing.title,
      titleSource: input.titleSource ?? existing.titleSource,
      providerId: input.providerId ?? existing.providerId,
      workingDirectory: input.workingDirectory ?? existing.workingDirectory,
      scopeBucketId: input.scopeBucketId ?? existing.scopeBucketId,
      lastActivity: input.lastActivity ?? existing.lastActivity,
      read: input.read ?? existing.read,
      assignmentId: input.assignmentId ?? existing.assignmentId,
      assignmentRole: input.assignmentRole ?? existing.assignmentRole,
      assignmentTaskId: input.assignmentTaskId ?? existing.assignmentTaskId,
      coordinatorThreadId: input.coordinatorThreadId ?? existing.coordinatorThreadId,
      achievementRole: input.achievementRole ?? existing.achievementRole,
      auditorThreadId: input.auditorThreadId ?? existing.auditorThreadId,
      userInputLocked: input.userInputLocked ?? existing.userInputLocked,
      scopeSortOrder:
        input.scopeBucketId !== undefined &&
        input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
          ? undefined
          : existing.scopeSortOrder,
      updatedAt: Date.now()
    }

    this.threadRepo.upsert(updated)
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

    this.threadRepo.upsert(updated)
    this.onChange?.(updated)
    return updated
  }
  async deleteThread(projectId: string, threadId: string): Promise<void> {
    const thread = this.requireOwnedThread(projectId, threadId)
    const deletionOrder = [...this.orchestrationDescendants(projectId, threadId), thread]
    const assignmentIds = this.assignmentIdsFor(deletionOrder)
    for (const candidate of deletionOrder) {
      await this.onDelete?.(candidate)
    }
    this.db.transaction(() => {
      for (const assignmentId of assignmentIds) {
        this.deleteAssignmentRows(assignmentId)
      }
      for (const candidate of deletionOrder) {
        this.deleteThreadRows(candidate)
      }
    })
    await this.onDeleted?.(deletionOrder)
  }

  private orchestrationDescendants(projectId: string, coordinatorThreadId: string): Thread[] {
    const threads = this.threadRepo.listByProject(projectId)
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

  private assignmentIdsFor(threads: Thread[]): Set<string> {
    const assignmentIds = new Set(
      threads.flatMap((thread) => (thread.assignmentId ? [thread.assignmentId] : []))
    )
    for (const thread of threads) {
      const workflow = this.db.get<{ assignment_id: string }>(
        'SELECT assignment_id FROM assignment_workflow WHERE project_id=? AND coordinator_thread_id=?',
        thread.projectId,
        thread.id
      )
      if (workflow) assignmentIds.add(workflow.assignment_id)
      const versions = this.db.all<{ assignment_id: string }>(
        'SELECT DISTINCT assignment_id FROM assignment_versions WHERE project_id=? AND coordinator_thread_id=?',
        thread.projectId,
        thread.id
      )
      for (const version of versions) assignmentIds.add(version.assignment_id)
    }
    return assignmentIds
  }

  private deleteAssignmentRows(assignmentId: string): void {
    this.db.run('DELETE FROM assignment_operations WHERE assignment_id=?', assignmentId)
    this.db.run('DELETE FROM assignment_coordinator_snapshots WHERE assignment_id=?', assignmentId)
    this.db.run('DELETE FROM assignment_api_capabilities WHERE assignment_id=?', assignmentId)
  }

  private deleteThreadRows(thread: Thread): void {
    const { projectId, id: threadId } = thread
    this.db.run('DELETE FROM spec_workflow WHERE project_id=? AND thread_id=?', projectId, threadId)
    this.db.run('DELETE FROM spec_versions WHERE project_id=? AND thread_id=?', projectId, threadId)
    this.db.run('DELETE FROM plans WHERE thread_id=?', threadId)
    this.db.run('DELETE FROM checklists WHERE thread_id=?', threadId)
    this.db.run('DELETE FROM audit_reports WHERE project_id=? AND thread_id=?', projectId, threadId)
    this.db.run(
      'DELETE FROM turn_checkpoints WHERE project_id=? AND thread_id=?',
      projectId,
      threadId
    )
    this.db.run('DELETE FROM active_turns WHERE project_id=? AND thread_id=?', projectId, threadId)
    this.db.run('DELETE FROM provider_sync_cursors WHERE thread_id=?', threadId)
    this.db.run('DELETE FROM assignment_api_capabilities WHERE thread_id=?', threadId)
    this.agentMessageRepo.deleteByThread(threadId)
    this.harnessUsageRepo.deleteByThread(threadId)
    this.threadRepo.delete(threadId)
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

    this.threadRepo.upsert(updated)
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

    this.threadRepo.upsert(updated)
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
    this.threadRepo.upsert(updated)
    this.onChange?.(updated)
    return updated
  }

  async setPinned(projectId: string, threadId: string, pinned: boolean): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    this.threadRepo.setPinned(threadId, pinned)
    const updated: Thread = { ...existing, pinned, updatedAt: Date.now() }
    this.onChange?.(updated)
    return updated
  }

  async markRead(projectId: string, threadId: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    if (existing.read) return existing

    this.threadRepo.markRead(threadId)
    const updated: Thread = { ...existing, read: true }
    this.onChange?.(updated)
    return updated
  }

  /** Persist the thread's agent settings (harness, model, thinking, permissions). */
  async updateSettings(
    projectId: string,
    threadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

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

    this.threadRepo.upsert(updated)
    this.onChange?.(updated)
    return updated
  }

  /**
   * Persist the thread's last-known usage snapshot. No onChange broadcast: the
   * meter commits too often (every quiet second of a long turn) for every write
   * to re-render the sidebar, and the snapshot is only needed to seed the next
   * mount. The row is deleted with the thread, so no orphan cleanup is needed.
   */
  setContextUsage(projectId: string, threadId: string, contextUsage: ThreadContextUsage): void {
    this.requireOwnedThread(projectId, threadId)
    this.threadRepo.updateContextUsage(threadId, contextUsage)
  }

  async setLoopIteration(
    projectId: string,
    threadId: string,
    loopIteration: number
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    const updated: Thread = { ...existing, loopIteration, updatedAt: Date.now() }
    this.threadRepo.upsert(updated)
    this.onChange?.(updated)
    return updated
  }

  /** Bind a harness session id to the thread. */
  async setSessionId(projectId: string, threadId: string, sessionId: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = { ...existing, sessionId, updatedAt: Date.now() }

    this.threadRepo.upsert(updated)
    return updated
  }

  /** Unbind the harness session — the next prompt starts a fresh one. */
  async clearSessionId(projectId: string, threadId: string): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    const updated: Thread = { ...existing, updatedAt: Date.now() }
    delete updated.sessionId

    this.threadRepo.upsert(updated)
    return updated
  }

  /**
   * Persist the mirrored agent conversation (rich messages) for offline access.
   * Runs as one atomic transaction on the worker's connection when available
   * (falls back to the primary connection).
   */
  async saveMessages(projectId: string, threadId: string, messages: AgentMessage[]): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    const outcome = await this.db.transactionViaWorker(
      buildSaveMessagesStatements(threadId, messages)
    )
    if (!outcome.ok) {
      // Fallback: identical batching semantics on the primary connection.
      this.db.transaction(() => {
        for (const statement of buildSaveMessagesStatements(threadId, messages)) {
          this.db.run(statement.sql, ...statement.params)
        }
      })
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
    return this.db.syncProviderDeltasViaWorker(threadId, resolvedSessionId, messages)
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
    const page = await this.pagedMessageRows((after) =>
      buildLoadUserMessagesPageSql(threadId, after)
    )
    if (!page.ok) return this.agentMessageRepo.loadUserMessagesByThread(threadId)
    return mapUserMessageRows(page.rows)
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
    return this.threadRepo.listAll(options)
  }

  /**
   * Deterministic thread-capacity view for the current project. Exposes the
   * limit, active/pinned counts, and how many threads could be deleted to make
   * room — so the UI can explain an all-pinned refusal.
   */
  async getThreadCapacity(projectId: string): Promise<ThreadCapacity> {
    const project = this.projectRepo.get(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const threads = this.threadRepo.listByProject(projectId)
    const logicalThreads = threads.filter((thread) => !isOrchestrationChildThread(thread))
    const active = logicalThreads.filter((thread) => !thread.archived)
    return {
      limit: project.threadLimit,
      activeCount: active.length,
      pinnedCount: active.filter((t) => t.pinned).length,
      deletableCount: active.filter((t) => !t.pinned).length
    }
  }

  /** Permanently remove every legacy archived row and its logical task tree. */
  async purgeArchivedThreads(): Promise<number> {
    const archived = (await this.listAllThreads({ includeArchived: true })).filter(
      (thread) => thread.archived
    )
    const archivedIds = new Set(archived.map((thread) => thread.id))
    let deleted = 0
    for (const thread of archived) {
      if (!archivedIds.has(thread.id)) continue
      const root = thread.coordinatorThreadId
        ? (archived.find((candidate) => candidate.id === thread.coordinatorThreadId) ?? thread)
        : thread
      const tree = [root, ...this.orchestrationDescendants(root.projectId, root.id)]
      await this.deleteThread(root.projectId, root.id)
      for (const candidate of tree) {
        if (archivedIds.delete(candidate.id)) deleted++
      }
    }
    return deleted
  }

  /** Permanently remove records left behind by deletion paths from older builds. */
  purgeOrphanedThreadRows(): number {
    const threadTables = [
      'spec_workflow',
      'spec_versions',
      'plans',
      'checklists',
      'audit_reports',
      'turn_checkpoints',
      'active_turns',
      'provider_sync_cursors',
      'harness_usage',
      'assignment_api_capabilities'
    ] as const
    let deleted = 0
    this.db.transaction(() => {
      for (const table of threadTables) {
        const row = this.db.get<{ count: number }>(
          `SELECT count(*) AS count FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM threads WHERE threads.id=${table}.thread_id)`
        )
        deleted += row?.count ?? 0
        this.db.run(
          `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM threads WHERE threads.id=${table}.thread_id)`
        )
      }
      for (const table of ['assignment_operations', 'assignment_coordinator_snapshots'] as const) {
        const where = `NOT EXISTS (SELECT 1 FROM threads WHERE threads.assignment_id=${table}.assignment_id) AND NOT EXISTS (SELECT 1 FROM assignment_workflow WHERE assignment_workflow.assignment_id=${table}.assignment_id) AND NOT EXISTS (SELECT 1 FROM assignment_versions WHERE assignment_versions.assignment_id=${table}.assignment_id)`
        const row = this.db.get<{ count: number }>(
          `SELECT count(*) AS count FROM ${table} WHERE ${where}`
        )
        deleted += row?.count ?? 0
        this.db.run(`DELETE FROM ${table} WHERE ${where}`)
      }
    })
    return deleted
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
    const parentMessages = this.agentMessageRepo.loadAllByThread(threadId)
    let copied = parentMessages
    if (messageId) {
      const cutoff = parentMessages.findIndex((message) => message.id === messageId)
      if (cutoff === -1) {
        throw new Error(`Cannot fork from message ${messageId}: message not found in thread`)
      }
      copied = parentMessages.slice(0, cutoff + 1)
    }

    const destinationPath = this.projectRepo.get(destinationProjectId)?.path ?? ''
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
      scopeBucketId: destinationProjectId === projectId ? parent.scopeBucketId : undefined,
      workingDirectory:
        destinationProjectId === projectId ? parent.workingDirectory : destinationPath
    })

    if (copied.length > 0) {
      const withNewIds = remapCopiedMessages(copied)
      await this.saveMessages(destinationProjectId, forked.id, withNewIds)
    }

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

    return forked
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
