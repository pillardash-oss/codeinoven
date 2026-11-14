import { isThreadBusyStatus } from '../thread-status-policy'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID } from '../ipc/browser'
import { broadcastThreadDraftUpdated } from '../../main/chat/thread-events'
import { trackDraftWrite } from '../../main/chat/draft-commit-gate'
import { validateEntityId } from '../../main/ipc/ipc-validation'
import { HarnessUsageRepo } from '../../main/database/repositories/harness-usage-repo'
import { Logger } from '../../main/system/logger'
import { withAuthoredWorkKind } from '../design/authored-work-kinds'
import type { AuthoredWorkKind } from '../ipc/design'
import { EngineeringLifecycleEngine } from './engineering-lifecycle-engine'
import {
  AgentMessageRepo,
  type ProviderDeltaSyncResult
} from '../../main/database/repositories/agent-message-repo'
import {
  RECENT_THREADS_PER_PROJECT,
  ThreadRepo,
  type ThreadSearchOptions
} from '../../main/database/repositories/thread-repo'
import { ScopeManager } from './scope-manager'
import type { Database } from '../../main/database/database'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  type ScopeSlice,
  type Thread,
  type ThreadAnnounceOptions,
  type CreateThreadInput,
  type ThreadStatus,
  type ThreadSettings,
  type ThreadContextUsage,
  type AgentMessage,
  type AssistantPreview,
  type ThreadMessageCursor,
  type ThreadMessagePage,
  type UsageBearingMessage,
  type UserMessageSummary,
  isOrchestrationChildThread,
  isAssistantSetupThread,
  ASSISTANT_SPACE_ID
} from '../types'
import {
  buildThreadCapacity,
  scopedBucketIdsFromBoard,
  type ThreadCapacity,
  type ThreadListOptions
} from './thread-manager-capacity'
import { assertScopeSwapAllowed } from './thread-manager-scope-swap'
import { orchestrationDescendants } from './thread-manager-lineage'
import { ThreadForkService } from './thread-manager-fork'
import { ThreadSearchService, type IntentSearchProvider } from './thread-manager-search'
import { ThreadOrderingService } from './thread-manager-ordering'
import { ThreadStatusService } from './thread-manager-status'
import { ThreadCreationService, type ThreadEvictionOutcome } from './thread-manager-creation'
import {
  ThreadScopeBindingService,
  type ThreadScopeRootProvider
} from './thread-manager-scope-binding'
import { ThreadTranscriptStore } from './thread-manager-transcripts'
import { ThreadSweepService, type ThreadSweepSummary } from './thread-manager-sweep'
import { ThreadScopeThreadsService } from './thread-manager-scope-threads'
import { recoverBrowserTranscript } from '../../main/chat/browser-transcript-recovery'
import { StorageEngine } from '../../main/storage/storage-engine'
import { turnStreamPath } from '../../main/chat/turn-stream'

export { remapCopiedMessages } from './thread-manager-fork'
export type { ThreadCapacity, ThreadListOptions } from './thread-manager-capacity'
export {
  AllThreadsPinnedError,
  AllThreadsProtectedError,
  type ThreadEvictionOutcome
} from './thread-manager-creation'
export type { ThreadScopeRootProvider } from './thread-manager-scope-binding'
export type { ThreadDeletionProject, ThreadSweepSummary } from './thread-manager-sweep'

/** Sidebar quota for the inbox (Chats) project: show all of its recent threads. */
const INBOX_PROJECT_ID = 'inbox'

/**
 * How deep the assistant space hydrates.
 *
 * The assistant space is not a project: it holds every assistant's tasks and their
 * runs, and the sidebar groups them per assistant. A project-sized slice cannot
 * represent it, because the pinned `Getting started` host of every assistant sorts
 * ahead of every task and fills the window on its own, so an assistant's older
 * tasks never arrived and its row under-counted them. This is bounded rather than
 * unlimited because runs accumulate: deep enough for a full assistant tree, small
 * enough that one broadcast never carries a project's whole history.
 */
const ASSISTANT_SPACE_RECENT_THREADS = 120

export class ThreadManager {
  private threadRepo: ThreadRepo
  private projectRepo: ProjectRepo
  private agentMessageRepo: AgentMessageRepo
  private harnessUsageRepo: HarnessUsageRepo
  private engineeringLifecycleEngine: EngineeringLifecycleEngine
  private readonly transcripts: ThreadTranscriptStore
  private browserTranscriptStorage: StorageEngine | null = null
  private readonly browserTranscriptRecoveries = new Map<
    string,
    { size: number; stamp: string; task: Promise<void> }
  >()
  private readonly forks: ThreadForkService
  private readonly searchService: ThreadSearchService
  private readonly ordering: ThreadOrderingService
  private readonly status: ThreadStatusService
  private readonly scopeBinding: ThreadScopeBindingService
  private readonly creation: ThreadCreationService
  private readonly sweep: ThreadSweepService
  private readonly scopeThreads: ThreadScopeThreadsService

  /**
   * @param onChange Invoked after a thread's status/read state is persisted so
   * callers (main process) can push live updates to renderer windows.
   * @param onDelete Invoked before a thread's rows are removed so callers can
   * tear down live harness resources (sessions, servers, ports) first.
   */
  constructor(
    private db: Database,
    private onChange?: (thread: Thread, options?: ThreadAnnounceOptions) => void,
    private onDelete?: (thread: Thread) => void | Promise<void>,
    private onDeleted?: (threads: Pick<Thread, 'projectId' | 'id'>[]) => void | Promise<void>,
    scopeRoots?: ThreadScopeRootProvider
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
    this.ordering = new ThreadOrderingService(
      this.threadRepo,
      (projectId, threadId) => this.requireOwnedThread(projectId, threadId),
      (thread) => this.onChange?.(thread)
    )
    this.status = new ThreadStatusService(
      this.threadRepo,
      (projectId, threadId) => this.requireOwnedThread(projectId, threadId),
      (thread) => this.announce(thread),
      (projectId, threadId) => this.getThread(projectId, threadId),
      (thread) => this.onChange?.(thread)
    )
    this.scopeBinding = new ThreadScopeBindingService(
      this.projectRepo,
      this.scopeManager,
      scopeRoots
    )
    this.creation = new ThreadCreationService(
      this.threadRepo,
      this.projectRepo,
      this.scopeManager,
      this.scopeBinding,
      (projectId, threadId) => this.deleteThread(projectId, threadId)
    )
    this.sweep = new ThreadSweepService(
      db,
      this.threadRepo,
      this.projectRepo,
      this.transcripts,
      (thread) => this.onDelete?.(thread),
      (threads) => this.onDeleted?.(threads)
    )
    this.scopeThreads = new ThreadScopeThreadsService(
      this.threadRepo,
      this.projectRepo,
      this.scopeManager,
      (projectId, threadId) => this.deleteThread(projectId, threadId),
      (projectId, threadId, input) => this.updateThread(projectId, threadId, input)
    )
  }

  /**
   * Announce a persisted thread, and the coordinator that owns it when the
   * write was delegated work.
   *
   * A worker or auditor write advances its Sr. Engineer row's `last_activity`
   * in the same statement (the `threads_coordinator_activity` trigger), so the
   * Sr. Engineer bubbles up the status list the moment one of its workers is
   * touched, a plain prompt to a worker included. The trigger keeps the
   * database column current on its own, but a renderer only re-sorts a row it
   * has been told about, so the refreshed coordinator is announced here.
   */
  private async announce(thread: Thread, options?: ThreadAnnounceOptions): Promise<void> {
    this.onChange?.(thread, options)
    if (!thread.coordinatorThreadId) return
    try {
      const coordinator = await this.threadRepo.getViaWorker(thread.coordinatorThreadId)
      if (coordinator) this.onChange?.(coordinator)
    } catch (error) {
      // The write already landed; a failed refresh must never fail the caller.
      Logger.dev('Coordinator activity announce failed', {
        threadId: thread.id,
        coordinatorThreadId: thread.coordinatorThreadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Reads scope boards to keep pinned scopes outside the thread bucket. */
  private readonly scopeManager: ScopeManager

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
  async listSubagentUsageMessages(
    projectId: string,
    threadId: string
  ): Promise<UsageBearingMessage[]> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return []
    return this.transcripts.listSubagentUsageMessages(threadId)
  }

  private getOwnedThread(projectId: string, threadId: string): Thread | null {
    const thread = this.threadRepo.get(threadId)
    return thread?.projectId === projectId ? thread : null
  }

  /**
   * Worker-backed ownership guard for the async read paths.
   *
   * The synchronous `getOwnedThread` remains for the mutators, which validate
   * and write in the same tick. Every async reader    message pages, history,
   * transcripts, sub-agent usage    goes through this one instead, so the two
   * statements a guard costs (`threads` by id plus its harness-usage
   * decoration) never run on the Electron main thread.
   */
  private getOwnedThreadViaWorker(projectId: string, threadId: string): Promise<Thread | null> {
    return this.getThreadViaWorker(projectId, threadId)
  }

  private requireOwnedThread(projectId: string, threadId: string): Thread {
    const thread = this.getOwnedThread(projectId, threadId)
    if (!thread) {
      throw new Error(`Thread not found in project ${projectId}: ${threadId}`)
    }
    return thread
  }

  /** The full synchronous `createThread`, used by internal orchestrators. */
  /** The full synchronous `createThread`, used by internal orchestrators. */
  async createThread(input: CreateThreadInput): Promise<Thread> {
    return this.creation.create(input)
  }

  /**
   * Split the create so the renderer-facing path can return the thread
   * immediately and finalize persistence in the background. The two halves are
   * owned by {@link ThreadCreationService}; this stays the manager's door to it.
   */
  prepareCreateThread(
    input: CreateThreadInput,
    options: { onEviction?: (outcome: ThreadEvictionOutcome) => void } = {}
  ): { thread: Thread; finalize: () => Promise<void> } {
    return this.creation.prepare(input, options)
  }

  /**
   * Ensure the global browser's single hidden thread exists.
   *
   * A per-tab agent conversation is a temporary side chat, and every side chat
   * resolves its project scope against a parent thread. The global browser owns
   * one such parent for all of its tabs, so this reserved row is what lets a
   * tab's agent sidebar start a harness session without a real project folder.
   * It is hidden behind the hidden browser project, so it never appears in any
   * thread list. Idempotent: the row is created once and then only read.
   */
  async ensureGlobalBrowserThread(): Promise<Thread> {
    const existing = await this.getThread(GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID)
    if (existing) return existing
    return this.createThread({
      id: GLOBAL_BROWSER_THREAD_ID,
      projectId: GLOBAL_BROWSER_PROJECT_ID,
      providerId: '',
      title: 'Browser',
      workingDirectory: ''
    })
  }

  /**
   * One thread, read on the database worker.
   *
   * Every caller is already async, and this is the most frequently read
   * statement in the process   the chat engine reconciles a thread's status on
   * each working signal   so a contended or stalled read must never land on the
   * Electron main thread. Only the ownership check and the `titleSource`
   * default stay here; the row itself comes from the worker connection, with
   * the primary connection kept as the worker's own fallback.
   */
  async getThread(projectId: string, threadId: string): Promise<Thread | null> {
    const thread = await this.getThreadViaWorker(projectId, threadId)
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

  /**
   * A thread by id, whatever project it lives in.
   *
   * A fork records the id of the thread it came from, and that thread may sit in
   * another project (a chat continued inside a project, an assistant task handed
   * off). Resolving it through the worker keeps the seek off the main thread.
   */
  async getThreadById(threadId: string): Promise<Thread | null> {
    return this.threadRepo.getViaWorker(threadId)
  }

  /**
   * Thread list for one project, read on the database worker for the same
   * reason as `getThread`: the sidebar and the git flows ask for it whenever a
   * scope board opens, and a stalled read there freezes the whole app.
   */
  async listThreads(projectId: string, options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listByProjectViaWorker(projectId, options)
  }

  async reorderThreads(projectId: string, orderedIds: string[]): Promise<Thread[]> {
    return this.ordering.reorderThreads(projectId, orderedIds)
  }

  async setSortOrder(projectId: string, threadId: string, sortOrder: number): Promise<Thread> {
    return this.ordering.setSortOrder(projectId, threadId, sortOrder)
  }

  async reorderPinnedThreads(projectId: string, orderedPinnedIds: string[]): Promise<Thread[]> {
    return this.ordering.reorderPinnedThreads(projectId, orderedPinnedIds)
  }

  async reorderPinnedThreadsGlobal(orderedPinnedIds: string[]): Promise<Thread[]> {
    return this.ordering.reorderPinnedThreadsGlobal(orderedPinnedIds)
  }

  async reorderScopeThreads(
    projectId: string,
    bucketId: string,
    slice: ScopeSlice,
    orderedIds: string[]
  ): Promise<Thread[]> {
    return this.ordering.reorderScopeThreads(projectId, bucketId, slice, orderedIds)
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
        | 'authoredWorkKind'
        | 'authoredWorkKinds'
        | 'implementationBrainstorm'
        | 'scopeBucketId'
        | 'boundScope'
        | 'lastActivity'
        | 'read'
        | 'assignmentId'
        | 'assignmentRole'
        | 'assignmentTaskId'
        | 'coordinatorThreadId'
        | 'achievementRole'
        | 'auditorThreadId'
        | 'achievementGoal'
        | 'userInputLocked'
        | 'engineering'
        | 'independentAudit'
        | 'independentAuditInitialized'
        | 'activeAuditId'
        | 'activeAuditVersion'
        | 'assistantId'
        | 'assistantIconType'
        | 'assistantIcon'
        | 'assistantGettingStarted'
        | 'groupParticipants'
        | 'groupTitle'
        | 'lastRunAt'
        | 'scheduleOverride'
        | 'scheduled'
      >
    >
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    // An assistant's Getting started thread is its behavior record: the
    // conversation that wrote the instructions the assistant follows on every run.
    // It belongs to that assistant, and to that place, for life. Nothing renames it,
    // moves it, or hands it to another assistant, because a behavior thread that
    // changes owner is how one assistant's instructions, name and schedule once
    // landed on a different assistant entirely.
    if (isAssistantSetupThread(existing)) {
      if (
        (input.title !== undefined && input.title !== existing.title) ||
        (input.titleSource !== undefined && input.titleSource !== existing.titleSource)
      ) {
        throw new Error('The Getting started thread cannot be renamed')
      }
      if (input.assistantId !== undefined && input.assistantId !== existing.assistantId) {
        throw new Error('The Getting started thread cannot be moved to another assistant')
      }
      if (
        input.scopeBucketId !== undefined &&
        input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
      ) {
        throw new Error('The Getting started thread cannot be moved out of its scope')
      }
    }

    // Only an assistant task has a home and a workspace that can differ. A
    // project thread already names its own scope, so accepting a binding for
    // one would create a second, contradictory answer to the same question.
    if (input.boundScope !== undefined) {
      if (existing.projectId !== ASSISTANT_SPACE_ID) {
        throw new Error('Only an assistant task can be bound to a project scope')
      }
      if (input.boundScope) await this.scopeBinding.assertBoundScopeTarget(input.boundScope)
    }

    // Moving a thread to a different scope counts as activity on it: the
    // thread jumps to the top of the destination scope instead of arriving
    // with a stale timestamp (which would also make it the immediate
    // candidate for automatic eviction).
    const movedScopes =
      input.scopeBucketId !== undefined &&
      input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)

    // A working thread inside a worktree scope may not be reassigned: its run
    // lives in that checkout, and the move would repoint it mid-turn.
    if (movedScopes && input.scopeBucketId !== undefined) {
      await assertScopeSwapAllowed({
        thread: existing,
        targetBucketId: input.scopeBucketId,
        boardFor: (projectId) => this.scopeManager.getBoardSnapshot(projectId)
      })
    }

    const updated: Thread = {
      ...existing,
      lastActivity: movedScopes ? Date.now() : (input.lastActivity ?? existing.lastActivity),
      sortOrder:
        movedScopes ||
        (input.lastActivity !== undefined && input.lastActivity > existing.lastActivity)
          ? undefined
          : existing.sortOrder,
      title: input.title ?? existing.title,
      titleSource: input.titleSource ?? existing.titleSource,
      providerId: input.providerId ?? existing.providerId,
      workingDirectory: input.workingDirectory ?? existing.workingDirectory,
      authoredWorkKind: input.authoredWorkKind ?? existing.authoredWorkKind,
      authoredWorkKinds: input.authoredWorkKinds ?? existing.authoredWorkKinds,
      scopeBucketId: input.scopeBucketId ?? existing.scopeBucketId,
      // A rebind is an explicit user action, so it replaces the pair outright;
      // omitting the field leaves the existing binding untouched.
      boundScope: input.boundScope !== undefined ? input.boundScope : existing.boundScope,
      read: input.read ?? existing.read,
      assignmentId: input.assignmentId ?? existing.assignmentId,
      assignmentRole: input.assignmentRole ?? existing.assignmentRole,
      assignmentTaskId: input.assignmentTaskId ?? existing.assignmentTaskId,
      coordinatorThreadId: input.coordinatorThreadId ?? existing.coordinatorThreadId,
      achievementRole: input.achievementRole ?? existing.achievementRole,
      // An explicit goal replaces the previous one (a new Achievement run can
      // restate the goal); omitting it keeps what the thread already recorded.
      achievementGoal: input.achievementGoal ?? existing.achievementGoal,
      auditorThreadId: input.auditorThreadId ?? existing.auditorThreadId,
      userInputLocked: input.userInputLocked ?? existing.userInputLocked,
      // The Engineering marker is durable: once set it stays set, so a later
      // partial update that omits it (or passes false) can never clear it.
      engineering: input.engineering === true ? true : existing.engineering,
      independentAudit: input.independentAudit ?? existing.independentAudit,
      independentAuditInitialized:
        input.independentAuditInitialized ?? existing.independentAuditInitialized,
      activeAuditId: input.activeAuditId ?? existing.activeAuditId,
      activeAuditVersion: input.activeAuditVersion ?? existing.activeAuditVersion,
      assistantId: input.assistantId ?? existing.assistantId,
      assistantIconType: input.assistantIconType ?? existing.assistantIconType,
      assistantIcon: input.assistantIcon ?? existing.assistantIcon,
      groupParticipants: input.groupParticipants ?? existing.groupParticipants,
      groupTitle: input.groupTitle ?? existing.groupTitle,
      ...(input.assistantGettingStarted ? { assistantGettingStarted: true } : {}),
      lastRunAt: input.lastRunAt ?? existing.lastRunAt,
      scheduleOverride:
        input.scheduleOverride !== undefined ? input.scheduleOverride : existing.scheduleOverride,
      scheduled: input.scheduled !== undefined ? input.scheduled : existing.scheduled,
      scopeSortOrder:
        input.scopeBucketId !== undefined &&
        input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
          ? undefined
          : existing.scopeSortOrder,
      updatedAt: Date.now()
    }

    // Rebinding a task re-derives its directory from the destination scope, on
    // the same rule a scope move follows, before anything can act on it.
    if (
      this.scopeBinding.hasScopeRoots &&
      input.boundScope !== undefined &&
      input.workingDirectory === undefined &&
      (input.boundScope?.projectId ?? null) !== (existing.boundScope?.projectId ?? null)
    ) {
      const resolved = await this.scopeBinding.resolveRoot(
        input.boundScope.projectId,
        input.boundScope.scopeBucketId
      )
      if (resolved) updated.workingDirectory = resolved
    }

    // Moving a thread between scopes re-derives its compatibility working
    // directory from the destination scope before anything can act on it.
    if (
      this.scopeBinding.hasScopeRoots &&
      input.scopeBucketId !== undefined &&
      input.workingDirectory === undefined &&
      input.scopeBucketId !== (existing.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
    ) {
      const resolved = await this.scopeBinding.resolveRoot(projectId, updated.scopeBucketId)
      if (resolved) {
        // The recorded branch names the checkout the thread used to run in, and
        // a move between scopes can swap that checkout (a managed scope has its
        // own worktree and branch). A label from the previous scope is never the
        // destination's branch, so it is dropped here and settled again for the
        // new root instead of being shown by the row, the composer and the Git
        // panel until the next run.
        if (resolved !== existing.workingDirectory) updated.branch = undefined
        updated.workingDirectory = resolved
      }
    }

    await this.threadRepo.upsertViaWorker(updated)
    await this.announce(updated)
    return updated
  }

  /**
   * Record that a thread has entered an authored-work session.
   *
   * One method, because the two columns have to agree. `authoredWorkKind` is the
   * session the thread is in now, which is what a preview, the expert card and
   * media generation resolve against. `authoredWorkKinds` is every session it has
   * entered, which is what the row's markers draw. The set only grows, so a
   * thread that designed something and later cut a video about it keeps both
   * marks for the rest of its life. A turn that names the kind the thread already
   * holds writes nothing and announces nothing.
   */
  async recordAuthoredWorkKind(
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind
  ): Promise<void> {
    const existing = this.requireOwnedThread(projectId, threadId)
    const kinds = withAuthoredWorkKind(existing.authoredWorkKinds, kind)
    if (
      existing.authoredWorkKind === kind &&
      (existing.authoredWorkKinds?.length ?? 0) === kinds.length
    ) {
      return
    }
    await this.updateThread(projectId, threadId, {
      authoredWorkKind: kind,
      authoredWorkKinds: kinds
    })
  }

  /**
   * Record the commit a run started from, once.
   *
   * Idempotent by design: a resumed run keeps the base of the attempt that
   * actually did the work, so the receipt never loses what already happened.
   */
  async setRunBase(
    projectId: string,
    threadId: string,
    base: NonNullable<Thread['runBase']>
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    if (existing.runBase) return existing
    const updated: Thread = { ...existing, runBase: base, updatedAt: Date.now() }
    await this.threadRepo.upsertViaWorker(updated)
    return updated
  }

  /** Set the git branch associated with this thread. */
  async setBranch(
    projectId: string,
    threadId: string,
    branch: string,
    expectedWorkingDirectory?: string
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)

    // A settle reads the branch from one checkout and writes it later. If the
    // thread moved scopes in between, that read describes a root it no longer
    // uses, so it must be dropped instead of relabelling the new scope with the
    // previous checkout's branch.
    if (
      expectedWorkingDirectory !== undefined &&
      existing.workingDirectory !== expectedWorkingDirectory
    ) {
      return existing
    }

    const updated: Thread = {
      ...existing,
      branch,
      updatedAt: Date.now()
    }

    await this.threadRepo.upsertViaWorker(updated)
    this.onChange?.(updated)
    return updated
  }
  async deleteThread(
    projectId: string,
    threadId: string,
    options: { allowAssistantSetupThread?: boolean } = {}
  ): Promise<void> {
    return this.sweep.deleteThread(projectId, threadId, options)
  }

  /**
   * Delete every thread in a project through the same path as `deleteThread`
   * (session teardown, DB row cleanup, disk artifacts), so project deletion
   * never has to duplicate or fall behind that logic. Owned by
   * {@link ThreadSweepService}.
   */
  async deleteAllThreadsInProject(
    projectId: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<ThreadSweepSummary> {
    return this.sweep.deleteAllThreadsInProject(projectId, onProgress)
  }

  /** All non-archived threads whose scope bucket equals `bucketId`, read on the
   *  database worker: scope tools and worktree preflights ask for this while
   *  the user is typing, so it must not touch SQLite on the main thread. */
  /** Number of user-visible (non-orchestration-child) threads owned by a scope. */
  async countThreadsInScope(projectId: string, bucketId: string): Promise<number> {
    return this.scopeThreads.countThreadsInScope(projectId, bucketId)
  }

  /**
   * Delete every thread owned by a scope. Parent threads go through
   * `deleteThread` so their orchestration descendants and disk artifacts are
   * swept; leftover children (orphans whose coordinator lived outside the
   * scope) are removed individually.
   */
  async deleteThreadsInScope(projectId: string, bucketId: string): Promise<number> {
    return this.scopeThreads.deleteThreadsInScope(projectId, bucketId)
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
    return this.scopeThreads.moveThreadsOutOfScope(projectId, fromBucketId)
  }

  /** Number of user-visible (non-orchestration-child) threads owned by a scope. */

  /** Remove app-owned scratch directories a deleted thread wrote to. Best-effort. */

  /**
   * Ids of every orchestration descendant of `threadId`   worker sub-agent
   * threads dispatched by this coordinator, transitively. Used to attribute
   * sub-agent checkpoint work to the parent thread's turn.
   */
  async listDescendantThreadIds(projectId: string, threadId: string): Promise<string[]> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return []
    const threads = await this.threadRepo.listForDeletionViaWorker(projectId)
    return orchestrationDescendants(threads, threadId).map((thread) => thread.id)
  }

  async parkThread(
    projectId: string,
    threadId: string,
    reason: NonNullable<Thread['parkReason']>
  ): Promise<Thread> {
    return this.status.parkThread(projectId, threadId, reason)
  }

  async setStatus(
    projectId: string,
    threadId: string,
    status: ThreadStatus,
    opts?: {
      read?: boolean
      error?: string
      errorDetail?: string
      /**
       * False when this settle only ends an internal continuation of a turn the
       * reader was already told about, so the row still reaches every window
       * while no second notification interrupts them for it.
       */
      notify?: boolean
    }
  ): Promise<Thread> {
    return this.status.setStatus(projectId, threadId, status, opts)
  }

  async dismissSpecReview(
    projectId: string,
    threadId: string,
    specId: string,
    specVersion: number
  ): Promise<Thread> {
    return this.status.dismissSpecReview(projectId, threadId, specId, specVersion)
  }

  async setAuditState(
    projectId: string,
    threadId: string,
    auditState: Thread['auditState'],
    report?: { id: string; version: number }
  ): Promise<Thread> {
    return this.status.setAuditState(projectId, threadId, auditState, report)
  }

  async markStoppedByUser(projectId: string, threadId: string): Promise<void> {
    return this.status.markStoppedByUser(projectId, threadId)
  }

  async wasStoppedByUser(projectId: string, threadId: string): Promise<boolean> {
    return this.status.wasStoppedByUser(projectId, threadId)
  }

  async clearStoppedByUser(projectId: string, threadId: string): Promise<void> {
    return this.status.clearStoppedByUser(projectId, threadId)
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

  /** A deliberate user stop the thread has not outlived with a new prompt yet. */

  /** A real user prompt re-arms automatic resumes on the thread. */

  async setPinned(projectId: string, threadId: string, pinned: boolean): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    // The knowledge thread is pinned for its whole life: it is never evicted and
    // the user can only hide it, so no surface may unpin it.
    if (!pinned && isAssistantSetupThread(existing)) {
      throw new Error('The knowledge thread stays pinned. Hide it instead.')
    }

    const pinnedAt = pinned ? Date.now() : undefined
    // Unpinning drops the bookmark with the pin: a bookmarked thread the user
    // unpins   from any surface   has to come back as a normal thread.
    const bookmarked = pinned ? (existing.bookmarked ?? false) : false
    this.threadRepo.setPinned(threadId, pinned, pinnedAt, bookmarked)
    const updated: Thread = { ...existing, pinned, pinnedAt, bookmarked, updatedAt: Date.now() }
    this.onChange?.(updated)
    return updated
  }

  async setBookmarked(projectId: string, threadId: string, bookmarked: boolean): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    if (
      bookmarked &&
      !existing.bookmarked &&
      (await this.threadRepo.countBookmarkedByProjectViaWorker(projectId)) >= 3
    ) {
      throw new Error('A project can have at most 3 bookmarked threads.')
    }
    if (!bookmarked && isAssistantSetupThread(existing)) {
      throw new Error('The knowledge thread stays pinned. Hide it instead.')
    }
    this.threadRepo.setBookmarked(threadId, bookmarked)
    const pinnedAt = bookmarked ? Date.now() : undefined
    const updated: Thread = {
      ...existing,
      bookmarked,
      pinned: bookmarked,
      pinnedAt,
      updatedAt: Date.now()
    }
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
   * Mark a thread unread at the user's request (a thread actions menu). The
   * mark stamps fresh activity, so every unread rule applies unchanged: the
   * thread sorts to the top of its list and reads as Unread. The broadcast lets
   * every window settle its badge; the renderer keeps the mark from being
   * auto-undone while the thread stays open (see `threadUnreadIntent`).
   */
  async markUnread(projectId: string, threadId: string): Promise<Thread> {
    const result = await this.threadRepo.markUnreadViaWorker(projectId, threadId)
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
    const ovenChanged =
      this.ovenIdChanged(existing, settings) || existing.settings?.ovenPath !== settings.ovenPath
    if (ovenChanged && isThreadBusyStatus(existing.status))
      throw new Error('Stop or finish the active turn before changing Ovens.')
    return this.persistSettings(existing, settings)
  }

  /**
   * Record the checkout a running Oven turn resolved for its own thread.
   *
   * `OvenChat.send` marks the thread executing before the checkout resolves, so
   * the write that stores `ovenPath` arrives while the thread is busy and must
   * not trip the guard above, which protects a user switching Ovens. Only a real
   * Oven identity change is still refused.
   */
  async bindOvenCheckout(
    projectId: string,
    threadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const existing = this.requireOwnedThread(projectId, threadId)
    if (this.ovenIdChanged(existing, settings) && isThreadBusyStatus(existing.status))
      throw new Error('Stop or finish the active turn before changing Ovens.')
    return this.persistSettings(existing, settings)
  }

  private ovenIdChanged(existing: Thread, settings: ThreadSettings): boolean {
    return (existing.settings?.ovenId ?? 'local') !== (settings.ovenId ?? 'local')
  }

  private async persistSettings(existing: Thread, settings: ThreadSettings): Promise<Thread> {
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
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return
    return this.transcripts.saveMessages(projectId, threadId, messages)
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
    const thread = await this.getOwnedThreadViaWorker(projectId, threadId)
    if (!thread) {
      return {
        applied: 0,
        skipped: 0,
        collisions: 0,
        duplicatedPrompts: 0,
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
    const thread = await this.getOwnedThreadViaWorker(projectId, threadId)
    if (!thread) return []
    await this.recoverBrowserMessages(thread)
    return this.transcripts.loadMessages(threadId)
  }

  /** Load one bounded page of mirrored conversation history, newest page first. */
  async loadMessagePage(
    projectId: string,
    threadId: string,
    before: ThreadMessageCursor | undefined,
    limit: number
  ): Promise<ThreadMessagePage> {
    const thread = await this.getOwnedThreadViaWorker(projectId, threadId)
    if (!thread) {
      return { messages: [], hasOlder: false }
    }
    await this.recoverBrowserMessages(thread)
    return this.transcripts.loadMessagePage(threadId, before, limit)
  }

  /** Repair interrupted browser history from the app-owned log, never by
   * starting a provider during a bounded conversation read. */
  private async recoverBrowserMessages(thread: Thread): Promise<void> {
    if (thread.projectId !== GLOBAL_BROWSER_PROJECT_ID || isThreadBusyStatus(thread.status)) return
    const storage = (this.browserTranscriptStorage ??= new StorageEngine())
    const size = await storage.rawSize(turnStreamPath(thread.projectId, thread.id))
    if (!size) return
    const stamp = `${thread.sessionId ?? ''}:${thread.updatedAt}`
    const previous = this.browserTranscriptRecoveries.get(thread.id)
    if (previous?.size === size && previous.stamp === stamp) return previous.task
    if (previous) await previous.task
    const task = recoverBrowserTranscript(storage, thread, {
      read: (messageId) => this.transcripts.loadMessageRecord(thread.id, messageId),
      write: async (message) => {
        const current = await this.getThreadViaWorker(thread.projectId, thread.id)
        if (
          !current ||
          current.sessionId !== thread.sessionId ||
          current.updatedAt !== thread.updatedAt
        )
          throw new Error('The browser conversation changed during transcript recovery.')
        await this.upsertMessages(thread.projectId, thread.id, [message])
      }
    }).catch((error: unknown) => {
      this.browserTranscriptRecoveries.delete(thread.id)
      Logger.error('Browser transcript recovery failed', { threadId: thread.id, error })
    })
    this.browserTranscriptRecoveries.set(thread.id, { size, stamp, task })
    while (this.browserTranscriptRecoveries.size > 100) {
      const oldest = this.browserTranscriptRecoveries.keys().next().value
      if (!oldest || oldest === thread.id) break
      this.browserTranscriptRecoveries.delete(oldest)
    }
    await task
  }

  /** Load a contiguous mirrored window centered on an arbitrary message id. */
  async loadMessagePageAround(
    projectId: string,
    threadId: string,
    anchorId: string,
    limit: number
  ): Promise<ThreadMessagePage> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) {
      return { messages: [], hasOlder: false, hasNewer: false }
    }
    return this.transcripts.loadMessagePageAround(threadId, anchorId, limit)
  }

  /** Load every mirrored user-authored conversation message, oldest to newest. */
  async loadUserMessages(projectId: string, threadId: string): Promise<UserMessageSummary[]> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return []
    return this.transcripts.loadUserMessages(projectId, threadId)
  }

  /**
   * The newest conversation message per assistant, for the assistant list rows.
   *
   * Read straight from the message repo rather than through a transcript load:
   * the sidebar needs one bounded line per row, not a conversation.
   */
  async listAssistantPreviews(projectId: string): Promise<AssistantPreview[]> {
    return this.agentMessageRepo.latestAssistantPreviewsViaWorker(projectId)
  }

  /**
   * Retire app-owned seed messages. The orchestrator bootstrap uses this when the
   * app changes what it seeds, so an install that saw the earlier version does
   * not keep a line the app no longer writes.
   */
  async deleteAppMessages(
    projectId: string,
    threadId: string,
    ids: readonly string[]
  ): Promise<void> {
    if (ids.length === 0) return
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return
    this.agentMessageRepo.deleteByIds(threadId, ids)
  }

  /** Load every parent-session record, including hidden transport-only prompts. */
  async loadMessageRecords(projectId: string, threadId: string): Promise<AgentMessage[]> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return []
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
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return
    return this.transcripts.saveSubagentMessages(projectId, threadId, sessionId, messages)
  }

  /** Load a mirrored child-agent transcript without contacting the provider. */
  async loadSubagentMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    if (!(await this.getOwnedThreadViaWorker(projectId, threadId))) return []
    return this.transcripts.loadSubagentMessages(threadId, sessionId)
  }

  /** List threads across all projects, sorted pinned-first then by last activity. */
  async listAllThreads(options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listAllViaWorker(options)
  }

  /**
   * Threads the Threads view must carry whatever the bounded recency window
   * pulls: pinned rows, non-done rows, and every row of a pinned-like scope,
   * across all projects.
   */
  async listAlwaysVisibleThreads(): Promise<Thread[]> {
    const scopedBucketIds = await this.scopeManager.scopedBucketIds()
    return this.threadRepo.listAlwaysVisibleViaWorker(scopedBucketIds)
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
   * Real project threads only, across every project, for the Threads view.
   *
   * The Threads view is the projects surface, so its bounded window, its paged
   * history and its guarantee set all read through here: none of them can bring
   * back a chats, assistant, or browser row for the view to filter out.
   */
  async listProjectThreadsForSidebar(options?: ThreadListOptions): Promise<Thread[]> {
    return this.threadRepo.listProjectThreadsViaWorker(options)
  }

  /**
   * Bounded per-project recent-thread list for sidebar hydration. The inbox
   * (Chats) project gets its configured `thread_limit` quota, the assistant space
   * gets {@link ASSISTANT_SPACE_RECENT_THREADS} so every assistant's tasks are
   * present, and every other project gets `RECENT_THREADS_PER_PROJECT`. Older rows
   * stay reachable via `listProjectThreads` paging. Unread threads bypass every
   * quota so they always surface in the first-paint slice regardless of age.
   */
  async listRecentPerProject(): Promise<Thread[]> {
    return this.threadRepo.listRecentPerProjectViaWorker((projectId) => {
      if (projectId === INBOX_PROJECT_ID) return Number.MAX_SAFE_INTEGER
      if (projectId === ASSISTANT_SPACE_ID) return ASSISTANT_SPACE_RECENT_THREADS
      return RECENT_THREADS_PER_PROJECT
    })
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
    const project = await this.projectRepo.getViaWorker(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    const threads = await this.threadRepo.listByProjectViaWorker(projectId)
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
    options: ThreadSearchOptions = {}
  ): Promise<import('../types').ThreadSearchResult[]> {
    return this.searchService.search(query, options)
  }

  /**
   * Hybrid search that waits for the semantic half, bounded by `timeoutMs`.
   *
   * Used by the app-diagnostics tool so an agent gathering context can search
   * the user's threads by meaning, not only by the words they happen to share.
   * A cold or unready embedding model, a timeout and a failure all fall back to
   * the keyword answer, and `semantic` says which one the caller got.
   */
  async searchThreadsWithIntent(
    query: string,
    options: ThreadSearchOptions = {},
    timeoutMs = 12_000
  ): Promise<{ results: import('../types').ThreadSearchResult[]; semantic: boolean }> {
    return this.searchService.searchWithIntent(query, options, timeoutMs)
  }

  /**
   * Spotlight search: the keyword answer resolves, and the merged hybrid
   * ranking is handed to `onIntentReady` when the local embedding model has
   * answered. Used only by the command palette's thread search - the panels'
   * own search buttons stay on {@link searchThreads} and never touch the model.
   */
  async searchThreadsWithDeferredIntent(
    query: string,
    options: ThreadSearchOptions,
    onIntentReady: (results: import('../types').ThreadSearchResult[]) => void
  ): Promise<import('../types').ThreadSearchResult[]> {
    return this.searchService.searchWithDeferredIntent(query, options, onIntentReady)
  }

  /**
   * Attach the semantic (intent) search provider. Set once during service
   * wiring; passing null restores keyword-only search.
   */
  setIntentSearchProvider(provider: IntentSearchProvider | null): void {
    this.searchService.setIntentProvider(provider)
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
