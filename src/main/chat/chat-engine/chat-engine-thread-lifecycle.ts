import { stat } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'
import { withHandedOffWorkersNote } from '../thread-transfer-service/thread-transfer-workers'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { broadcastThreadUpdate, updateRetryWakeWindow } from '../thread-events'
import { validateEntityId, validateThreadSettings } from '../../ipc/ipc-validation'
import type { CompactionFallbackContext, HarnessDriver } from '../../drivers/driver.interface'
import type { PendingRetryRecord } from '../../system/retry-scheduler-service'
import type { AgentProviderIssue, ThreadStatus, Thread } from '../../../lib/types'
import {
  ASSISTANT_SPACE_ID,
  INBOX_PROJECT_ID,
  isOrchestrationChildThread
} from '../../../lib/types'
import {
  readTurnStreamLog,
  storageTurnStreamSource,
  type TurnStreamLogRead
} from '../turn-stream-log'
import { backgroundIo } from '../../system/background-io'
import { classifyProviderIssue, isUsageResetWaitIssue } from '../../../lib/provider-issue'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import {
  PROJECT_DATA_DIRECTORY,
  assistantThreadWorkspaceDirectory,
  browserThreadWorkspaceDirectory,
  chatThreadWorkspaceDirectory,
  featureArtifactDirectory,
  featureSlugFromTitle
} from '../../../lib/project-artifacts'
import { messageId as createMessageId } from '../../../lib/id'
import type { SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import {
  SPEC_CONTRACT_CONTINUATION_PROMPT,
  USAGE_RESET_FALLBACK_RETRY_MS
} from './chat-engine-constants'
import { turnStreamPath } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine thread-lifecycle: one concern, moved verbatim from the composition root. */
export class ChatEngineThreadLifecycle {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Locate the plan and progress this thread is executing.
   *
   * A thread with a feature slug owns `.cio/specs/<slug>`, the authoritative
   * pair for engineering work. Every other thread keeps its plan beside its own
   * scratch work, in the `.cio/work/<feature>` directory named after the slug of
   * its own title   the same derivation the rest of the app uses. The newest
   * work directory in the project is deliberately not consulted: it belongs to
   * whichever chat wrote last, so it attached another thread's plan to this
   * thread's checkpoint. Publishing no plan is the honest outcome when this
   * thread's directory is not there.
   */
  async resolveThreadPlan(
    projectPath: string,
    threadId: string
  ): Promise<CompactionFallbackContext> {
    const row = this.host.database.get<{ feature_slug: string | null; title: string | null }>(
      'SELECT feature_slug, title FROM threads WHERE id=?',
      threadId
    )
    // A slug that no longer round-trips is not a directory this app wrote, so
    // it is never joined into a path.
    const slug = row?.feature_slug
    const specDirectory =
      slug && featureSlugFromTitle(slug) === slug
        ? join(projectPath, featureArtifactDirectory(slug))
        : null
    const directory =
      specDirectory ?? (await this.threadWorkDirectory(projectPath, threadId, row?.title ?? ''))
    if (!directory) return { plan: null, progress: null, planPath: null, progressPath: null }
    const plan = await this.host.units['media-artifacts'].readPlanArtifact(
      join(directory, 'plan.md')
    )
    const progress = await this.host.units['media-artifacts'].readPlanArtifact(
      join(directory, 'progress.md')
    )
    return {
      plan: plan?.text ?? null,
      progress: progress?.text ?? null,
      planPath: plan?.path ?? null,
      progressPath: progress?.path ?? null
    }
  }

  /**
   * This thread's own `.cio/work/<feature>` scratch directory, or null.
   *
   * The feature slug comes from the thread's title, matching
   * `projectArtifactDirectory()`, and both the feature-level layout
   * (`.cio/work/<feature>/plan.md`) and the thread-scoped one
   * (`.cio/work/<feature>/<threadId>/plan.md`) are accepted.
   */
  async threadWorkDirectory(
    projectPath: string,
    threadId: string,
    title: string
  ): Promise<string | null> {
    const root = join(projectPath, PROJECT_DATA_DIRECTORY, 'work', featureSlugFromTitle(title))
    for (const directory of [root, join(root, threadId)]) {
      try {
        if ((await stat(join(directory, 'plan.md'))).isFile()) return directory
      } catch {
        // Not this layout; try the next one.
      }
    }
    return null
  }

  /**
   * Bring a thread's harness session up before its next turn needs it.
   *
   * Spawning the harness is the slow part of a first send, and the app knows one
   * is coming while the user is still reading whatever is holding it. Warming
   * here means the prompt that follows finds its process already running, and the
   * turn itself is unchanged: the driver's own send path takes the same route it
   * always did, just with the spawn already paid for.
   *
   * Best-effort by construction. A driver with no transport to warm, a harness
   * that is not installed, an unavailable model, a project that moved: every one
   * of those leaves the thread exactly as it was, and the send starts the session
   * the normal way. Nothing here may fail a turn, so nothing here throws.
   */
  async warmThreadSession(projectId: string, threadId: string): Promise<boolean> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread) return false
      if (this.host.state.ovenChat.remote(thread)) {
        await this.host.ensureSession(projectId, threadId)
        return true
      }
      const driverId = thread.settings?.harnessId || DEFAULT_HARNESS
      if (driverId === 'opencode' && this.host.state.openCodeDriverIsV2) return false
      const account = await this.host.state.accountRegistry.resolveForProvider(
        driverId,
        thread.settings?.providerId,
        thread.settings?.accountId
      )
      const { driver, projectPath } = await this.host.resolve(
        projectId,
        driverId,
        threadId,
        account.id
      )
      if (!driver.warmSession) return false
      const sessionId = await this.host.ensureSession(projectId, threadId, driverId)
      await driver.warmSession(projectPath, sessionId)
      return true
    } catch (error) {
      Logger.dev('Harness warm-up was skipped:', error)
      return false
    }
  }

  /**
   * Live provider activity is authoritative evidence that its task is still
   * running. Repair stale terminal state so header, sidebar, and trace agree.
   */
  reconcileWorkingThreadStatus(sessionId: string): Promise<void> {
    const existing = this.host.state.workingStatusReconciliations.get(sessionId)
    if (existing) return existing
    const reconciliation = (async (): Promise<void> => {
      const info = this.host.sessionRegistry.get(sessionId)
      if (!info || info.ephemeral) return
      if (this.host.units['turns-sessions'].sessionAwaitsUserInput(sessionId)) return
      const expectedStatus: Extract<ThreadStatus, 'planning' | 'executing'> =
        this.host.state.planningSessions.has(sessionId) ? 'planning' : 'executing'
      const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      // Guard: only block a spurious working signal that arrives before the
      // known reset window. When retryAt is undefined or no scheduler record
      // exists, treat provider working as authoritative   this covers native
      // harness auto-retries and >6h/missing-window cases where the thread
      // has legitimately picked itself up but would otherwise stay paused.
      if (thread?.status === 'working-paused') {
        const pending = this.host.state.retryScheduler?.getPendingRetry(sessionId)
        const GRACE_MS = 30_000
        if (pending?.retryAt !== undefined && pending.retryAt > Date.now() + GRACE_MS) return
      }
      const assignmentChanged = thread
        ? await this.host.units['assignment'].reconcileWorkingAssignmentState(thread)
        : false
      if (thread && thread.status !== expectedStatus) {
        await this.host.threadManager.setStatus(info.projectId, info.threadId, expectedStatus)
      } else if (thread && assignmentChanged) {
        // Assignment state is persisted separately from its linked threads.
        // Rebroadcast after reconciliation so mounted coordinators immediately
        // reload the authoritative task status instead of retaining attention.
        broadcastThreadUpdate(thread)
      }
    })().finally(() => {
      this.host.state.workingStatusReconciliations.delete(sessionId)
    })
    this.host.state.workingStatusReconciliations.set(sessionId, reconciliation)
    return reconciliation
  }

  /**
   * The target harness's own session for a thread, when the thread left it with
   * a resumable native transcript still on disk. This is the branch half of a
   * switch: adopting the record keeps the harness's transcript and prompt cache
   * alive, so the turn resumes instead of rebuilding. A record whose native
   * transcript is gone, or that never had one, is not adoptable, because
   * adopting it would pay a cold replay anyway.
   */
  async findParkedThreadSession(
    driver: HarnessDriver,
    projectPath: string,
    threadId: string
  ): Promise<{ sessionId: string; lastMessageId?: string } | null> {
    if (!driver.findThreadSession) return null
    try {
      const parked = await driver.findThreadSession(projectPath, threadId)
      if (!parked?.native) return null
      const held = await this.host.units['transcripts'].probeNativeHistory(
        driver,
        projectPath,
        parked.sessionId
      )
      if (held === false) return null
      return {
        sessionId: parked.sessionId,
        ...(parked.lastMessageId ? { lastMessageId: parked.lastMessageId } : {})
      }
    } catch (error) {
      Logger.dev('Parked harness session lookup failed:', error)
      return null
    }
  }

  /** Drop this process's in-flight turn state for a thread it just handed off. */
  detachThreadTurnBookkeeping(projectId: string, threadId: string): void {
    for (const info of this.host.sessionRegistry.values()) {
      if (info.projectId !== projectId || info.threadId !== threadId) continue
      info.activeTurnId = undefined
      info.activeTurnUserMessageId = undefined
      info.changedPaths = undefined
      info.preciseChangedPaths = undefined
      info.changeSources = undefined
      info.rejectedChangeSources = undefined
      info.userTouchedPaths = undefined
      info.openUnboundedTools = undefined
      info.unboundedWindowToolIds = undefined
      info.unboundedToolObserved = undefined
      info.unboundedWindowStart = undefined
    }
  }

  /** Record this process as the owner of the workflow `thread` belongs to. */
  async claimWorkflowOwnershipForThread(projectId: string, thread: Thread): Promise<void> {
    const coordinatorThreadId = await this.host.units['assignment'].workflowCoordinatorFor(
      projectId,
      thread
    )
    if (coordinatorThreadId === null) return
    await this.host.state.workflowOwnership.claim(projectId, coordinatorThreadId)
  }

  /**
   * Resume regular threads that RestartRecoveryService flagged as interrupted
   * by an app closure or unknown issue. Each eligible thread receives an
   * internal "Continue" through the normal sendPrompt pipeline so its persisted
   * harness session picks up where it stopped and the broadcast status flips
   * the sidebar back to "working". Sr. Engineer coordinators and orchestration
   * children are intentionally skipped   their owner workflows (assignments,
   * achievement loops) are resumed by `resumePendingWork`. Gated by the
   * "Resume work on restart" setting.
   *
   * `recovered` is already filtered by turn ownership, so this needs no
   * cross-instance gate of its own: it can only name turns whose owning process
   * is gone.
   */
  async resumeRecoveredThreads(recovered: Thread[]): Promise<void> {
    const config = await this.host.storage.getConfig()
    for (const thread of recovered) {
      try {
        if (this.host.state.ovenChat.remote(thread)) {
          await this.host.ensureSession(thread.projectId, thread.id)
          continue
        }
        if (config.resumeWorkOnRestart === false) {
          // The pre-crash turn is about to stay stopped for good, and its
          // provider never reported it, so its streamed work is recovered into
          // the transcript before anything else can move past it.
          await this.host.units['messages-write'].persistStreamedTurnWork(
            thread.projectId,
            thread.id,
            thread.sessionId ?? null
          )
          continue
        }
        const resumed = await this.resumeThreadFromPersistedSession(thread)
        if (!resumed) {
          // A resume the engine refused (a refused latch, a missing session, a
          // dead harness) leaves the same gap as a stop without an idle.
          await this.host.units['messages-write'].persistStreamedTurnWork(
            thread.projectId,
            thread.id,
            thread.sessionId ?? null
          )
        }
      } catch (error) {
        // Leave the thread in its interrupted state; the user can still Retry manually.
        Logger.error('Recovered thread resume failed (non-fatal):', {
          projectId: thread.projectId,
          threadId: thread.id,
          error: rawErrorMessage(error)
        })
      }
    }
  }

  /**
   * Continue one thread's persisted harness session through the normal
   * sendPrompt pipeline.
   *
   * This is the single resumption path shared by restart recovery and a
   * cross-instance transfer, so the two can never drift apart in what they
   * skip or how they resume. It returns whether a prompt was actually
   * dispatched, which lets a caller that must not silently do nothing (a
   * transfer) report the refusal instead of leaving the thread interrupted.
   *
   * `force` is set by a transfer: the owning instance has already stopped the
   * run and released the thread, so this process's own busy probe cannot see it
   * and a stale user-stop latch must not veto the explicit hand-off.
   */
  async resumeThreadFromPersistedSession(
    thread: Thread,
    options: { force?: boolean; note?: string; allowAgentOwnedThread?: boolean } = {}
  ): Promise<boolean> {
    const force = options.force === true
    if (thread.archived) return false
    if (thread.assignmentRole === 'coordinator' || thread.achievementRole === 'coordinator') {
      return false
    }
    // An agent-owned worker thread (a pawn) is normally left to the agent run
    // that owns it. A transfer resumes it explicitly, because the release
    // stopped it on the departing instance and nothing else would restart it.
    if (!options.allowAgentOwnedThread && isOrchestrationChildThread(thread)) return false
    if (!thread.settings || !thread.sessionId) return false
    // A deliberate user stop before the restart vetoes the hidden Continue;
    // the user can still resume by hand (Retry or any prompt).
    if (!force && (await this.host.threadManager.wasStoppedByUser(thread.projectId, thread.id))) {
      Logger.info('Recovered-thread resume suppressed: the user stopped this thread', {
        projectId: thread.projectId,
        threadId: thread.id
      })
      return false
    }
    const current = this.host.sessionStatuses.get(thread.sessionId)
    if (current?.state === 'working' || current?.state === 'waiting') return false
    // The in-memory status map is empty right after a restart, but the
    // harness process may have survived it and still be running the
    // pre-restart turn. Resuming a live session spawns a second concurrent
    // run that interleaves outputs and derails both turns, so probe the
    // driver first and leave genuinely-busy sessions alone (their events
    // keep flowing and will complete the turn normally).
    if (!force && thread.sessionHarnessId) {
      try {
        const driver = await this.host.resolve(thread.projectId, thread.sessionHarnessId, thread.id)
        if (
          driver.driver.isSessionBusy &&
          (await driver.driver.isSessionBusy(driver.projectPath, thread.sessionId))
        ) {
          return false
        }
      } catch (error) {
        // Driver unavailable or probe failed   resume anyway (legacy path).
        Logger.dev('Recovered-thread busy probe skipped:', {
          threadId: thread.id,
          error: rawErrorMessage(error)
        })
      }
    }
    const activeSpec = await this.host.units['spec'].getActiveSpec(thread.projectId, thread.id)
    const resumesSpecContract = activeSpec?.status === 'approved' && !thread.auditState
    const continuation = await this.host.units['turns'].continuationTurnRequest(
      thread.projectId,
      thread.id,
      resumesSpecContract ? SPEC_CONTRACT_CONTINUATION_PROMPT : 'Continue'
    )
    // A transfer can carry something the persisted request cannot say: what the
    // move did to the workers this thread was running. It rides the same turn
    // rather than a second one, so the agent sees it before it decides what
    // finished and what failed.
    const continuationText = options.note
      ? withHandedOffWorkersNote(continuation.text, options.note)
      : continuation.text
    await this.host.sendPrompt(
      thread.projectId,
      thread.id,
      validateThreadSettings(thread.settings),
      continuationText,
      continuation.attachments,
      resumesSpecContract ? 'implement' : undefined,
      createMessageId(),
      undefined,
      continuation.references,
      continuation.projectReferences,
      'internal'
    )
    return true
  }

  async resolveThreadPath(projectId: string, threadId: string): Promise<string> {
    const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    // An assistant behaves like a project, so every task in it works inside its own
    // `assistant-cwd/<assistantId>/` root and keeps its artifacts there. A
    // assistant-less task gets `assistant-cwd/<threadId>/` so it still lives under
    // the assistant root without colliding with any assistant. The file tree
    // resolves the very same directory through `assistantThreadWorkspaceDirectory`.
    if (projectId === ASSISTANT_SPACE_ID) {
      const assistantDirectory = assistantThreadWorkspaceDirectory(threadId, thread.assistantId)
      await this.host.storage.ensureDirectory(assistantDirectory)
      return this.host.storage.resolve(assistantDirectory)
    }

    // A standalone (inbox) chat owns `chats-cwd/<threadId>/`: one directory per
    // conversation, and the very same root its file tree mounts, so a file the
    // session writes is a file the tree can show. Resolving to the shared
    // `chats-cwd` root instead puts every chat's scratch in one directory and
    // leaves that scratch unreachable from the tree the chat displays.
    if (projectId === INBOX_PROJECT_ID) {
      const chatDirectory = chatThreadWorkspaceDirectory(threadId)
      await this.host.storage.ensureDirectory(chatDirectory)
      return this.host.storage.resolve(chatDirectory)
    }

    // A browser tab's agent chat owns `browser-cwd/<threadId>/`, and the tab's
    // conversation thread is named after the tab, so one tab owns one directory
    // for the life of its conversation. Resolving to the shared `browser-cwd`
    // root instead puts every tab's scratch in one directory, where one tab's
    // files are visible to the next.
    if (projectId === GLOBAL_BROWSER_PROJECT_ID) {
      const browserDirectory = browserThreadWorkspaceDirectory(threadId)
      await this.host.storage.ensureDirectory(browserDirectory)
      return this.host.storage.resolve(browserDirectory)
    }

    // The scope resolver is authoritative for threads in a scope; a stale
    // persisted directory never wins, and unhealthy managed scopes fail
    // closed instead of silently operating on the project root.
    if (this.host.scopeRoots && thread.scopeBucketId) {
      const resolved = await this.host.scopeRoots.resolveCompatibilityRoot(
        projectId,
        thread.scopeBucketId
      )
      if (resolved) return resolved
    }

    const workingDirectory = thread.workingDirectory.trim()
    if (!workingDirectory) return projectPath
    return isAbsolute(workingDirectory)
      ? resolve(workingDirectory)
      : resolve(projectPath, workingDirectory)
  }

  /**
   * Drop the human gates still parked on one thread when there is no session to
   * abort by id.
   *
   * The question and permission queues are keyed by session, so a thread whose
   * binding was never written has no key to clear them with. They are also the
   * only things that can hold a thread open with no run behind it, so a Stop
   * reaching this path has to reach them by thread instead of returning early.
   * Questions go through `finalizePendingQuestion` so the card is closed and the
   * resolution is broadcast exactly as it is for any other resolution; the
   * permission queue is cleared the way its own teardown clears it, leaving the
   * status write that follows as the signal a card re-reads against.
   */
  releaseParkedThreadGates(projectId: string, threadId: string): void {
    for (const [requestId, pending] of this.host.pendingQuestions) {
      if (pending.request.projectId !== projectId || pending.request.threadId !== threadId) continue
      this.host.units['questions'].finalizePendingQuestion(
        requestId,
        'dismissed',
        pending.request.answers
      )
    }
    for (const [requestId, pending] of this.host.state.pendingPermissions) {
      if (pending.session.projectId !== projectId || pending.session.threadId !== threadId) continue
      this.host.state.pendingPermissions.delete(requestId)
      pending.settleBrowserAction?.(false)
      this.host.broadcast({
        type: 'permission.replied',
        sessionId: pending.request.sessionId,
        requestId,
        reply: 'reject'
      })
    }
  }

  /**
   * Read a thread's durable working-trace log off the main process.
   *
   * The walk decodes and parses an append-only file that grows with the whole
   * thread. Even chunked, doing that on the main process put every thread open
   * behind it and competed with the IPC, permission, and stream writes landing
   * at the same moment. The background I/O worker owns the walk now; the main
   * process only receives what the fold needs. The newest turn is read backwards
   * from the end of the log, so the cost follows that turn instead of the
   * thread's entire history, and a closed span is read only when a caller asks
   * for one.
   */
  async readTurnStreamOffThread(
    streamPath: string,
    fromByte: number,
    size: number,
    windowStartTs: number | undefined,
    windowEndTs?: number
  ): Promise<TurnStreamLogRead> {
    try {
      if (windowStartTs !== undefined && windowEndTs === undefined) {
        return await backgroundIo<TurnStreamLogRead>({
          kind: 'turn-stream-tail',
          path: this.host.storage.resolve(streamPath),
          size,
          windowStartTs
        })
      }
      return await backgroundIo<TurnStreamLogRead>({
        kind: 'turn-stream-range',
        path: this.host.storage.resolve(streamPath),
        fromByte,
        size,
        ...(windowStartTs === undefined ? {} : { windowStartTs }),
        ...(windowEndTs === undefined ? {} : { windowEndTs })
      })
    } catch {
      // A worker that cannot start must never make a trace unreadable: the walk
      // itself is chunked and yields, so the fallback is slower, not blocked.
      return readTurnStreamLog(
        storageTurnStreamSource(this.host.storage, streamPath),
        fromByte,
        size,
        windowStartTs,
        windowEndTs
      )
    }
  }

  /**
   * Drop one thread's durable stream log with the thread.
   *
   * The deletion removes the whole thread directory, so a parse cache keyed by
   * the path would outlive the file, and a fire-and-forget append queued before
   * the delete would recreate the directory after it. The tombstone makes the
   * late append a no-op and the drain lets the writes already queued land before
   * the directory is removed.
   */
  async forgetThreadStream(projectId: string, threadId: string): Promise<void> {
    const streamPath = turnStreamPath(projectId, threadId)
    this.host.state.turnStreamCache.delete(streamPath)
    this.host.state.deletedTurnStreams.add(streamPath)
    await this.host.storage.drainRaw(streamPath).catch((error: unknown) => {
      Logger.dev('Turn stream drain failed:', error)
    })
  }

  /** Surface a transcript failure to every known session binding for the thread. */
  async broadcastThreadSessionError(
    projectId: string,
    threadId: string,
    sourceSessionId: string,
    issue: AgentProviderIssue
  ): Promise<void> {
    if (issue.kind === 'network' && !this.host.state.userAbortedSessions.has(sourceSessionId)) {
      this.host.units['runtime-connectivity'].enterRetryWait(sourceSessionId, issue, issue.message)
      return
    }
    const sessionIds = new Set<string>([sourceSessionId])
    for (const [registeredSessionId, registered] of this.host.sessionRegistry) {
      if (registered.projectId === projectId && registered.threadId === threadId) {
        sessionIds.add(registeredSessionId)
      }
    }
    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (thread?.sessionId) sessionIds.add(thread.sessionId)
    } catch (error) {
      Logger.error('Current thread session lookup failed:', error)
    }

    for (const sessionId of sessionIds) {
      this.host.sessionStatuses.set(sessionId, { state: 'error', issue })
      this.host.broadcast({
        type: 'session.error',
        sessionId,
        error: issue.message,
        issue
      })
      await this.host.units['runtime-connectivity'].scheduleAutomaticRetry(sessionId, issue)
    }
    this.host.broadcast({
      type: 'thread.error',
      sessionId: sourceSessionId,
      projectId,
      threadId,
      issue
    })
  }

  /** Repair stale working rows for scheduler-restored retries so UI shows Waiting to retry immediately on launch. */
  async repairPendingRetryThreadStatuses(): Promise<void> {
    if (
      this.host.units['runtime-connectivity'].deferAutomaticResumeToLiveInstance(
        'paused retry statuses'
      )
    )
      return
    const scheduler = this.host.state.retryScheduler
    // 1) Repair threads that have a persisted scheduler pending (finite retryAt)   original path.
    if (scheduler) {
      try {
        const pending = scheduler as unknown as {
          pending: Map<string, { projectId: string; threadId: string }>
        }
        const map = pending.pending
        if (map && map.size > 0) {
          for (const record of map.values()) {
            try {
              const thread = await this.host.threadManager.getThread(
                record.projectId,
                record.threadId
              )
              if (!thread) continue
              if (
                await this.host.threadManager.wasStoppedByUser(record.projectId, record.threadId)
              ) {
                // The user stopped this thread; the ledger was supposed to be
                // clean already, but a concurrent write raced the stop. Drop.
                this.host.state.retryScheduler?.dropThread(record.threadId)
                continue
              }
              if (thread.status === 'working-paused') continue
              if (!['planning', 'executing', 'working-paused'].includes(thread.status)) continue
              const updated = await this.host.threadManager.setStatus(
                record.projectId,
                record.threadId,
                'working-paused',
                { read: false }
              )
              broadcastThreadUpdate(updated)
            } catch (error) {
              Logger.dev('Pending retry repair skipped:', error)
            }
          }
        }
      } catch (error) {
        Logger.dev('Pending retry repair (scheduler map) skipped:', error)
      }
    }

    // 2) Repair orphaned working threads that never got a scheduler record (missing/beyond-6h retryAt,
    // stale rows from before the fix, or off-first-page threads like ba9a2c59...). Scan DB directly
    // so pagination cannot hide them, and infer a usage-reset wait from the last persisted error.
    try {
      const activeRows = this.host.database.all<{
        id: string
        project_id: string
        session_id: string | null
        status: string
      }>(
        `SELECT id, project_id, session_id, status FROM threads WHERE archived = 0 AND status IN ('planning', 'executing')`
      )
      if (!activeRows || activeRows.length === 0) return
      for (const row of activeRows) {
        // Already covered by scheduler pending   skip to avoid duplicate work.
        if (row.session_id && scheduler?.getPendingRetry(row.session_id)) continue
        try {
          const thread = await this.host.threadManager.getThread(row.project_id, row.id)
          if (!thread) continue
          if (thread.status === 'working-paused') continue
          // A user-stopped thread is never relabelled to working-paused, and
          // never re-armed by this scan: its stop intent outranks the stale
          // persisted error text.
          if (await this.host.threadManager.wasStoppedByUser(row.project_id, row.id)) continue
          // Only threads that still look actively working should be considered.
          if (!['planning', 'executing'].includes(thread.status)) continue

          // Look for the last persisted provider error for this thread.
          let lastError: string | null = null
          try {
            const errorRow = this.host.database.get<{ error: string | null }>(
              `SELECT error FROM agent_messages WHERE thread_id = ? AND error IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
              row.id
            )
            if (errorRow?.error) lastError = errorRow.error
          } catch {
            // Message table may be empty or missing   fall through to next check.
          }

          // Fallback: also check in-memory session status if present (fresh failure before DB flush).
          if (!lastError && row.session_id) {
            const liveIssue =
              this.host.sessionStatuses.get(row.session_id)?.state === 'error'
                ? ((
                    this.host.sessionStatuses.get(row.session_id) as {
                      issue?: { message?: string }
                    }
                  )?.issue?.message ?? null)
                : this.host.sessionStatuses.get(row.session_id)?.state === 'waiting'
                  ? ((
                      this.host.sessionStatuses.get(row.session_id) as {
                        issue?: { message?: string }
                      }
                    )?.issue?.message ?? null)
                  : null
            if (liveIssue) lastError = liveIssue
          }

          if (!lastError) continue
          const kind = classifyProviderIssue(lastError)
          const retryable = kind !== 'billing'
          // Treat quota/rate_limit/provider_unavailable(retryable) as a retry-paused wait,
          // even when retryAt was never derived   this covers ba9a2c59... (>6h/missing retryAt).
          if (!isUsageResetWaitIssue({ kind, retryable })) continue

          const updated = await this.host.threadManager.setStatus(
            row.project_id,
            row.id,
            'working-paused',
            { read: false }
          )
          broadcastThreadUpdate(updated)
          // The row previously had no scheduler record at all   give it a real
          // fallback timer instead of leaving the card "waiting" with nothing
          // to auto-resume it.
          if (scheduler && row.session_id) {
            const trackedRepair = await scheduler.track({
              sessionId: row.session_id,
              projectId: row.project_id,
              threadId: row.id,
              harnessId: thread.sessionHarnessId ?? thread.settings?.harnessId ?? 'unknown',
              retryAt: Date.now() + USAGE_RESET_FALLBACK_RETRY_MS,
              issueKind: kind,
              issueMessage: lastError
            })
            // A user-stopped thread is never re-armed by the repair scan: the
            // status write above already stayed off it, so nothing else to do.
            if (!trackedRepair) continue
          }
          Logger.info('Repaired orphaned working thread to Waiting to retry', {
            projectId: row.project_id,
            threadId: row.id,
            kind
          })
        } catch (error) {
          Logger.dev('Orphaned working repair skipped:', error)
        }
      }
    } catch (error) {
      Logger.dev('Orphaned working scan skipped:', error)
    }
  }

  /**
   * Resume a thread whose usage window reset. Sends an internal "Continue"
   * through the normal sendPrompt pipeline (mirroring the manual Retry action)
   * so the agent picks up from its existing session and context. Skipped when
   * the thread is gone, its session moved on, or the harness is already active.
   * The request the failed turn was answering rides along, because a session
   * replaced in the meantime holds no memory of it.
   */
  async continueScheduledThread(record: PendingRetryRecord): Promise<void> {
    const projectId = validateEntityId(record.projectId, 'Project ID')
    const threadId = validateEntityId(record.threadId, 'Thread ID')
    const { sessionId } = record
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (
      !thread ||
      thread.archived ||
      !thread.sessionId ||
      thread.sessionId !== sessionId ||
      thread.status !== 'working-paused'
    ) {
      // The shared row must still be paused on a retry. A sibling can finish
      // the same session while this process retains an old in-memory wait.
      // The thread moved on (a newer session, an archive, a delete). This wait
      // can never be admitted, and leaving it in the ledger turns every tick
      // into a no-op attempt for a thread that is no longer waiting.
      if (this.host.state.retryScheduler?.getPendingRetry(sessionId) === record) {
        this.host.state.retryScheduler.clear(sessionId)
      }
      this.host.state.retryScheduler?.resumed(sessionId)
      return
    }
    const current = this.host.sessionStatuses.get(sessionId)
    if (current?.state === 'working') return
    if (record.issueKind === 'network') {
      if (!this.host.units['runtime-connectivity'].deviceOnline()) {
        // The link the resume was armed on is gone again. Keep the wait and
        // re-verify connectivity: firing the rest of a reconnect queue against
        // a flapping network is what turns a recovery into a stampede.
        this.host.state.connectivity?.invalidate('connection wait resume attempted offline')
        throw new Error('Device disconnected before thread recovery')
      }
      const info = this.host.sessionRegistry.get(sessionId)
      const driver = info
        ? this.host.units['turns-dispatch'].driverForRuntime(info.driverId, info.accountId)
        : undefined
      if (
        driver?.isSessionBusy &&
        info &&
        (await driver.isSessionBusy(info.projectPath, sessionId))
      )
        return
    }
    // A waiting session is the retry-wait we are resuming   clear the waiting
    // card so the scheduled Continue can transition working-paused → working.
    if (current?.state === 'waiting' || current?.state === 'error') {
      this.host.sessionStatuses.delete(sessionId)
      this.host.state.retryScheduler?.clear(sessionId)
      updateRetryWakeWindow(sessionId, null)
      this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
    }
    if (thread.assignmentRole === 'coordinator' && thread.assignmentId) {
      const assignment = this.host.state.assignmentEngine.getActive(projectId, threadId)
      const hasFailedWorker = assignment?.content.tasks.some(
        (task) =>
          task.owner === 'worker' &&
          task.status === 'attention' &&
          task.report?.status === 'failed' &&
          task.threadId
      )
      if (assignment && hasFailedWorker) {
        await this.host.units['assignment'].resumeAssignmentAttentionInternal(projectId, threadId)
        return
      }
    }
    const driverId = record.harnessId || thread.settings?.harnessId || DEFAULT_HARNESS
    const settings = validateThreadSettings(
      thread.settings ?? {
        harnessId: driverId,
        providerId: '',
        modelId: '',
        thinkingLevel: 'medium',
        inferenceMode: 'normal',
        permissionLevel: 'auto_review',
        loopMode: false,
        fileSystemMode: false
      }
    )
    const continuation = await this.host.units['turns'].continuationTurnRequest(
      projectId,
      threadId,
      'Continue'
    )
    await this.host.sendPrompt(
      projectId,
      threadId,
      settings,
      continuation.text,
      continuation.attachments,
      undefined,
      createMessageId(),
      undefined,
      continuation.references,
      continuation.projectReferences,
      'internal'
    )
  }

  /**
   * The thread an idle finalization still owns, or null once a newer turn has
   * superseded it.
   *
   * `onSessionIdle` captures the thread when the idle arrives and then spends
   * seconds loading the transcript, stamping parts, and validating output. A
   * provider failure inside that window is handled immediately and, on an
   * assistant task, moves the assistant onto its next model on a replacement
   * session. This finalization still holds the failed session and the settings
   * that turn ran with, and issuing its own continuation from that snapshot is
   * what made an assistant model fallback resume fail: the late continuation
   * wrote the failed model back, the harness-switch path released the
   * fallback's live session as orphaned, and the fallback's own send then ran
   * against a session that no longer existed.
   *
   * Only the engine's own thread-bound turns reach the idle finalizer (every
   * auxiliary session registers ephemeral and returns before it), so the
   * thread's bound session is the honest test of ownership. Once it is some
   * other session, a fallback resume, a harness switch, or a newer user turn
   * owns the thread and this finalization must not act on it.
   */
  async idleTurnThread(info: SessionInfo, sessionId: string): Promise<Thread | null> {
    // Another turn already owns this session. A fallback resume that kept the
    // same session marks it working, and one whose send is still dispatching
    // holds the thread's resume claim.
    if (this.host.sessionStatuses.get(sessionId)?.state === 'working') return null
    if (this.host.state.assistantFallbackResumes.has(`${info.projectId}:${info.threadId}`))
      return null
    try {
      const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      if (!thread || thread.archived) return null
      // A thread bound to a different session has already moved on. A thread
      // whose binding was cleared (an account removal, for example) has no
      // live turn to protect and still needs this finalization to settle it.
      if (thread.sessionId && thread.sessionId !== sessionId) return null
      return thread
    } catch (error) {
      Logger.dev('Idle finalization ownership check failed:', {
        projectId: info.projectId,
        threadId: info.threadId,
        sessionId,
        error: rawErrorMessage(error)
      })
      return null
    }
  }

  /**
   * The turn-owning thread family: the thread itself plus every orchestration
   * descendant (worker sub-agent threads it dispatched). Checkpoint work done
   * by these threads belongs to the parent's turn instead of counting as
   * foreign concurrent edits.
   */
  async selfFamilyThreadIds(projectId: string, threadId: string): Promise<Set<string>> {
    const ids = new Set([threadId])
    try {
      for (const id of await this.host.threadManager.listDescendantThreadIds(projectId, threadId)) {
        ids.add(id)
      }
    } catch (error) {
      Logger.dev('Sub-agent thread lookup failed:', error)
    }
    return ids
  }
}
