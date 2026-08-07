import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { generateId, getConfigRoot } from '../utils'
import { messageId as createMessageId } from '../id'
import { featureSlugFromTitle } from '../project-artifacts'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { AgentMessageRepo } from '../../main/database/repositories/agent-message-repo'
import { HarnessUsageRepo } from '../../main/database/repositories/harness-usage-repo'
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
  type ThreadMessagePage
} from '../types'

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
    private onDelete?: (thread: Thread) => void | Promise<void>
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
    if (existing.length >= threadLimit) {
      const unpinned = existing
        .filter((t) => !t.pinned)
        .sort((a, b) => a.lastActivity - b.lastActivity)
      const toEvict = unpinned[0]
      if (toEvict) {
        await this.deleteThread(input.projectId, toEvict.id)
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

  async listThreads(projectId: string): Promise<Thread[]> {
    return this.threadRepo.listByProject(projectId)
  }

  async reorderThreads(projectId: string, orderedIds: string[]): Promise<Thread[]> {
    const threads = orderedIds.map((threadId) => this.requireOwnedThread(projectId, threadId))
    this.threadRepo.batchUpdateSortOrder(orderedIds)
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
    await this.onDelete?.(thread)
    this.db.transaction(() => {
      this.agentMessageRepo.deleteByThread(threadId)
      this.harnessUsageRepo.deleteByThread(threadId)
      this.threadRepo.delete(threadId)
    })
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

  /** Persist the mirrored agent conversation (rich messages) for offline access. */
  async saveMessages(projectId: string, threadId: string, messages: AgentMessage[]): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    this.db.transaction(() => {
      this.agentMessageRepo.deleteConversationByThread(threadId)
      for (const msg of messages) {
        this.agentMessageRepo.upsert(msg, threadId)
      }
      this.harnessUsageRepo.reconcile(projectId, threadId)
    })
  }

  /**
   * Add or update mirrored messages without replacing the transcript.
   *
   * Provider retries can finish out of order. Their snapshots must not delete
   * user messages persisted by a newer turn while the older request was in
   * flight.
   */
  async upsertMessages(
    projectId: string,
    threadId: string,
    messages: AgentMessage[]
  ): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    this.db.transaction(() => {
      for (const msg of messages) {
        this.agentMessageRepo.upsert(msg, threadId)
      }
      this.harnessUsageRepo.reconcile(projectId, threadId)
    })
  }

  /** Load the mirrored agent conversation, or an empty list when absent. */
  async loadMessages(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.agentMessageRepo.loadByThread(threadId)
  }

  /** Load one bounded page of mirrored conversation history, newest page first. */
  async loadMessagePage(
    projectId: string,
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): Promise<ThreadMessagePage> {
    if (!this.getOwnedThread(projectId, threadId)) return { messages: [], hasOlder: false }
    return this.agentMessageRepo.loadPageByThread(threadId, before, limit)
  }

  /** Load every parent-session record, including hidden transport-only prompts. */
  async loadMessageRecords(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.agentMessageRepo.loadAllByThread(threadId)
  }

  /** Persist one provider-neutral child-agent transcript for durable audit. */
  async saveSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<void> {
    if (!this.getOwnedThread(projectId, threadId)) return
    this.db.transaction(() => {
      this.agentMessageRepo.deleteBySession(threadId, sessionId)
      for (const msg of messages) {
        this.agentMessageRepo.upsert(msg, threadId, sessionId)
      }
      this.harnessUsageRepo.reconcile(projectId, threadId)
    })
  }

  /** Load a mirrored child-agent transcript without contacting the provider. */
  async loadSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    if (!this.getOwnedThread(projectId, threadId)) return []
    return this.agentMessageRepo.loadBySession(threadId, sessionId)
  }

  async setArchived(projectId: string, threadId: string, archived: boolean): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    this.threadRepo.setArchived(threadId, archived)
    const updated: Thread = { ...existing, archived, updatedAt: Date.now() }
    this.onChange?.(updated)
    return updated
  }

  /** List threads across all projects, sorted pinned-first then by last activity. */
  async listAllThreads(): Promise<Thread[]> {
    return this.threadRepo.listAll()
  }

  /**
   * Full-text search across thread titles and conversation content
   * (user messages + agent final output). Project-scoped when projectId is set.
   */
  searchThreads(
    query: string,
    options: { projectId?: string; limit?: number } = {}
  ): import('../types').ThreadSearchResult[] {
    return this.threadRepo.search(query, options)
  }

  async forkThread(
    projectId: string,
    threadId: string,
    title: string,
    checkpointId?: string,
    messageId?: string
  ): Promise<Thread> {
    const parent = this.requireOwnedThread(projectId, threadId)
    const parentMessages = this.agentMessageRepo.loadAllByThread(threadId)
    let copied = parentMessages
    if (messageId) {
      const cutoff = parentMessages.findIndex((message) => message.id === messageId)
      if (cutoff === -1) {
        throw new Error(`Cannot fork from message ${messageId}: message not found in thread`)
      }
      copied = parentMessages.slice(0, cutoff + 1)
    }

    const featureSlug = parent.featureSlug ?? featureSlugFromTitle(parent.title)
    const forked = await this.createThread({
      projectId,
      providerId: parent.providerId,
      title,
      titleSource: 'manual',
      settings: parent.settings,
      featureSlug,
      scopeBucketId: parent.scopeBucketId,
      workingDirectory: parent.workingDirectory
    })

    if (copied.length > 0) {
      const withNewIds = copied.map((msg) => {
        const newId = createMessageId()
        return {
          ...msg,
          id: newId,
          parts: msg.parts.map((part) =>
            'messageID' in part
              ? {
                  ...part,
                  id: part.id.includes(msg.id)
                    ? part.id.replace(msg.id, newId)
                    : `${newId}-${part.id}`,
                  messageID: newId
                }
              : part
          ),
          transportParts: msg.transportParts?.map((part) =>
            'messageID' in part
              ? {
                  ...part,
                  id: part.id.includes(msg.id)
                    ? part.id.replace(msg.id, newId)
                    : `${newId}-${part.id}`,
                  messageID: newId
                }
              : part
          )
        }
      })
      await this.saveMessages(projectId, forked.id, withNewIds)
    }

    // Link fork to parent via branch metadata
    const branchMeta = {
      parentThreadId: threadId,
      checkpointId: checkpointId ?? null,
      messageId: messageId ?? null,
      forkedAt: Date.now()
    }

    const branchDir = join(getConfigRoot(), 'projects', projectId, 'threads', forked.id, 'branches')
    await mkdir(branchDir, { recursive: true })
    await writeFile(join(branchDir, 'origin.json'), JSON.stringify(branchMeta, null, 2))

    return forked
  }
}
