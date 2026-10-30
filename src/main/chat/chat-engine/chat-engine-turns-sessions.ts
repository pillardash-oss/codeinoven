import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { broadcastThreadUpdate, updateRetryWakeWindow } from '../thread-events'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import { isCioOrchestrateRequest } from '../../orchestration/cio-orchestrate-prompt'
import { legacyHarnessAccountId } from '../../providers/harness-account-registry'
import type {
  AgentMessage,
  AgentProviderIssue,
  AgentSessionStatus,
  AssignmentTaskReport,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { workerReportsToCoordinator } from '../../../lib/types'
import { decideModelSwitchCompaction } from '../../../lib/model-switch-compaction'
import { handoffTailTokenBudget } from '../../../lib/prompt-budget'
import { selectHistoryTail } from './chat-engine-message-text'
import { classifyProviderIssue, isUsageResetWaitIssue } from '../../../lib/provider-issue'
import type { PendingQuestionInfo, SessionCompletionWaiter, SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { broadcastToast, initialSpecWorkingStatus, probeSessionLiveness } from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine turns-sessions: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsSessions {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Whether an orchestration session was opened in this thread, now or earlier,
   * and whether this turn is the one that opened it. The same memo-and-rescan
   * shape as the design tag, so an edit or rollback that removes the tag takes
   * the session, and with it the workstation tools, away.
   */
  async orchestrationSessionFor(
    projectId: string,
    threadId: string,
    requestedThisTurn: boolean
  ): Promise<'off' | 'start' | 'continue'> {
    if (requestedThisTurn) return 'start'
    if (this.host.state.cioOrchestrateThreads.has(threadId)) return 'continue'
    const userMessages = await this.host.threadManager.loadUserMessages(projectId, threadId)
    const opened = userMessages.some((message) => isCioOrchestrateRequest(message.content))
    if (opened) this.host.state.cioOrchestrateThreads.set(threadId, true)
    return opened ? 'continue' : 'off'
  }

  /**
   * Publish the plan and progress this thread is executing so a driver-owned
   * checkpoint can rebuild context from them when a transcript can no longer be
   * summarized. Best-effort: a thread with no plan publishes an empty snapshot,
   * and a driver that builds no checkpoints is skipped entirely.
   */
  async publishCompactionFallback(
    driver: HarnessDriver,
    projectId: string,
    threadId: string,
    sessionId: string,
    projectPath: string
  ): Promise<void> {
    const publish = driver.publishCompactionContext?.bind(driver)
    if (!publish) return
    try {
      await publish(
        projectPath,
        sessionId,
        await this.host.units['thread-lifecycle'].resolveThreadPlan(projectPath, threadId)
      )
    } catch (error) {
      Logger.dev('Compaction fallback context publish failed:', error)
    }
  }

  /** Return the thread's harness session, creating and persisting one if needed. */
  async ensureSession(
    projectId: string,
    threadId: string,
    requestedDriverId?: string
  ): Promise<string> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    // A thread created optimistically may still be finalizing; the renderer
    // shows the user's message instantly while the send waits here for the
    // thread's persisted row before it reaches the harness.
    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    if (this.host.state.ovenChat.remote(thread)) {
      const sessionId = thread.sessionId?.startsWith('oven-')
        ? thread.sessionId
        : `oven-${randomUUID()}`
      if (sessionId !== thread.sessionId)
        await this.host.threadManager.setSessionId(
          projectId,
          threadId,
          sessionId,
          thread.settings?.harnessId,
          thread.settings?.accountId
        )
      this.host.registerSession(
        sessionId,
        projectId,
        threadId,
        thread.settings?.ovenPath ?? '',
        thread.settings?.permissionLevel ?? 'auto_review',
        thread.settings?.harnessId ?? DEFAULT_HARNESS
      )
      await this.host.state.ovenChat.restore(thread)
      return sessionId
    }

    const driverId = requestedDriverId ?? thread.settings?.harnessId ?? DEFAULT_HARNESS
    const account = await this.host.state.accountRegistry.resolveForProvider(
      driverId,
      thread.settings?.providerId,
      thread.settings?.accountId
    )
    const accountId = account.id
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      accountId
    )

    // A harness switch orphans the old harness's session. The thread's bound
    // session belongs to the harness that created it   after a mid-run switch
    // `settings.harnessId` already points at the new harness while `sessionId`
    // still lives in the old one, so the switch is detected by comparing the
    // session OWNER (persisted or registered) with the requested driver, never
    // the current settings. Capture the previous session before the binding
    // below is reset so it can be fully synced and released (best-effort)
    // before the new harness takes over.
    const sessionOwner = thread.sessionId
      ? (thread.sessionHarnessId ?? this.host.sessionRegistry.get(thread.sessionId)?.driverId)
      : undefined
    const sessionOwnerAccount = thread.sessionId
      ? (thread.sessionAccountId ?? legacyHarnessAccountId(sessionOwner ?? driverId))
      : undefined
    // Ask the registry, never the id shape. A managed account keeps the
    // `pending-<uuid>` id of the reserve it was created from, so the prefix says
    // nothing about whether the account still exists, and a reserve that never
    // finalized (it died with the process that created it) names no account at
    // all. Reading the prefix instead of the registry answered "no account" for
    // every managed account: a real account switch then read as "no change", so
    // the replaced account's session and credentials kept serving the turn after
    // the user moved to another one, while a dead reserve made every single turn
    // look like a switch and mint a new session each time. The registry is only
    // consulted when the stamp disagrees with the resolved account, which is the
    // one case where its answer decides the session.
    let sessionAccountMoved = false
    if (sessionOwnerAccount && sessionOwnerAccount !== accountId) {
      sessionAccountMoved =
        await this.host.state.accountRegistry.isResolvableAccountId(sessionOwnerAccount)
    }
    const switchedRuntime = Boolean(
      thread.sessionId && sessionOwner && (sessionOwner !== driverId || sessionAccountMoved)
    )
    const previousHarnessId = switchedRuntime ? sessionOwner : undefined
    const previousAccountId = switchedRuntime ? sessionOwnerAccount : undefined
    const previousSessionId = switchedRuntime ? thread.sessionId : undefined

    let sessionId = switchedRuntime ? undefined : thread.sessionId
    // Planning-turn suppression is applied per turn in sendPrompt (where the
    // turn's intent is known). Marking the session here unconditionally for a
    // lifecycle-active thread would suppress the final answer of every parked
    // chat and follow-up turn for the rest of the app lifetime.
    let rotatedPlanningSession = false
    if (
      sessionId &&
      !this.host.state.preparedImplementationSessions.has(sessionId) &&
      (await this.host.units['turns'].shouldRotateForImplementation(
        projectId,
        threadId,
        thread.status,
        this.host.units['turns'].engineeringLifecycleActive(projectId, threadId),
        this.host.state.planningSessions.has(sessionId)
      ))
    ) {
      const planningSessionId = sessionId
      this.retireSessionState(planningSessionId)
      await this.host.threadManager.clearSessionId(projectId, threadId)
      sessionId = undefined
      rotatedPlanningSession = true
    }
    let storedSessionMessages: AgentMessage[] = []
    let unavailableSessionId: string | undefined
    let nativeHistoryBound = false
    if (sessionId) {
      // A cached record proves nothing about the store: another instance
      // sharing this data root can release a session while it stays cached
      // here, and `loadMessages` keeps answering until the cache is dropped and
      // the next dispatch dies with "CLI session is unavailable". Ask the
      // driver's store first so the replacement below runs instead.
      const recordPresent =
        !driver.hasSessionRecord ||
        (await driver.hasSessionRecord(projectPath, sessionId).catch(() => true))
      if (!recordPresent) {
        Logger.info('Stored harness session record is gone; creating a replacement', {
          projectId,
          threadId,
          sessionId
        })
        this.retireSessionState(sessionId)
        unavailableSessionId = sessionId
        sessionId = undefined
      }
    }
    if (sessionId) {
      try {
        storedSessionMessages = await driver.loadMessages(projectPath, sessionId)
        // Backfill the thread stamp on records created before tagging existed
        // so harness-switch relocation can find them later.
        void driver.tagSessionThread?.(projectPath, sessionId, threadId).catch(() => {})
      } catch {
        Logger.info('Stored harness session is unavailable; creating a replacement', {
          projectId,
          threadId,
          sessionId
        })
        this.retireSessionState(sessionId)
        unavailableSessionId = sessionId
        sessionId = undefined
      }
    }
    if (!sessionId) {
      // A harness switch is a branch, not a reset. The harness being switched
      // to kept its own session for this thread when the thread last left it,
      // and that record still carries a resumable native transcript, so adopt
      // it and resume warm instead of minting a cold session and replaying the
      // conversation into it. Only the turns produced on the other harness are
      // missing from that transcript, and those ride the turn as a delta recap
      // (see `parkedSessionReplay`).
      const parked =
        switchedRuntime && previousHarnessId && previousHarnessId !== driverId
          ? await this.host.units['thread-lifecycle'].findParkedThreadSession(
              driver,
              projectPath,
              threadId
            )
          : null
      sessionId = parked?.sessionId ?? (await driver.createSession(projectPath, thread.title))
      const boundThread = await this.host.threadManager.setSessionId(
        projectId,
        threadId,
        sessionId,
        driverId,
        accountId
      )
      if (parked) {
        nativeHistoryBound = true
        this.host.state.parkedSessionReplay.set(sessionId, {
          boundary: parked.lastMessageId ?? null,
          repeat: driver.retainsRecapInTranscript === false
        })
        Logger.info('Resumed a parked harness session after harness switch', {
          projectId,
          threadId,
          harnessId: driverId,
          sessionId,
          replayFrom: parked.lastMessageId ?? 'thread-start'
        })
      } else {
        // Stamp the thread onto the driver record so the session can be
        // relocated across harness switches (see the switch branch below).
        try {
          await driver.tagSessionThread?.(projectPath, sessionId, threadId)
        } catch (error) {
          Logger.dev('Session thread tagging failed:', error)
        }
        // A harness switch discards the returning harness's session slot, but
        // that harness still holds the thread's real native transcript. Restore
        // the binding so the next RPC spawn resumes it instead of cold-starting
        // on the engine's history recap.
        if (switchedRuntime) {
          try {
            nativeHistoryBound =
              (await driver.restoreNativeBinding?.(projectPath, sessionId, threadId)) ?? false
          } catch (error) {
            Logger.dev('Native binding restore after harness switch failed:', error)
          }
        }
      }
      // The replacement session must adopt the replaced session's native
      // transcript binding (same harness), or the harness's own history is
      // orphaned and every later turn falls back to the recap replay.
      if (unavailableSessionId) {
        try {
          nativeHistoryBound =
            (await driver.inheritNativeSession?.(projectPath, unavailableSessionId, sessionId)) ??
            false
        } catch (error) {
          Logger.dev('Native session inheritance onto replacement failed:', error)
        }
      }
      // A session edited via delete/truncate starts with no harness history
      // of its own. Seed the driver's native transcript from the edited
      // mirror so the next turn resumes the real (edited) conversation
      // natively instead of replaying it as a history recap. Only the newest
      // part of that mirror is seeded: the rest stays in the app database for
      // the agent to query, exactly as the rendered handoff does, so a rebuilt
      // session never starts by reading a long thread's stale tool output.
      if (!nativeHistoryBound && !switchedRuntime) {
        try {
          const editedMirror = await this.host.threadManager.loadMessageRecords(projectId, threadId)
          const priorMirror =
            editedMirror.at(-1)?.role === 'user' ? editedMirror.slice(0, -1) : editedMirror
          const tailBudget = handoffTailTokenBudget(
            this.host.units['runtime-agents'].selectedModelInputBudget(
              thread.settings?.providerId,
              thread.settings?.modelId,
              projectId
            )
          )
          const { tail, summary } = selectHistoryTail(priorMirror, tailBudget)
          if (summary.droppedCount > 0) {
            // The seeded transcript carries the tail only, so the pointer that
            // names this thread and the queries that recover the rest still has
            // to reach the model once this session is live.
            this.host.state.prefilledHistoryBoundaries.set(sessionId, {
              summary,
              delivered: false
            })
          }
          nativeHistoryBound =
            (await driver.prefillNativeSession?.(projectPath, sessionId, tail)) ?? false
        } catch (error) {
          Logger.dev('Native transcript prefill after session edit failed:', error)
        }
      }
      // The desktop view adopts ensureSession's return value directly. Publish
      // the persisted binding too so every other window can route the very
      // first streamed part from a new or replacement harness session.
      broadcastThreadUpdate(boundThread)
      if (rotatedPlanningSession) {
        this.host.state.preparedImplementationSessions.add(sessionId)
        Logger.info('Prepared a clean implementation session for the approved specification', {
          projectId,
          threadId,
          sessionId
        })
      }
    }
    // Record whether the harness natively holds the conversation so the recap
    // path can skip a second provider history load. A freshly created session
    // that inherited, restored, or was pre-filled with native history counts
    // too   the recap must not replay on top of a natively bound transcript.
    // A driver that can answer the question directly wins over the message
    // count: `loadMessages` also serves the driver's durable mirror for a
    // session the harness will boot cold, and reading that as native history
    // suppresses the replay the rebuilt session needs to continue.
    const nativeHeld = await this.host.units['transcripts'].probeNativeHistory(
      driver,
      projectPath,
      sessionId
    )
    this.host.state.sessionNativeHistory.set(
      sessionId,
      nativeHistoryBound ||
        (nativeHeld ??
          (driver.capabilities.nativeResume !== false && storedSessionMessages.length > 0))
    )

    // A reused native session is replayed in full under whichever model the
    // next turn selects. When that model changed and its context window is much
    // smaller than the thread's last-known native usage, compact the native
    // session before it resumes so the new model never hits Codex's "ran out of
    // room in the model's context window" boundary.
    if (!switchedRuntime && storedSessionMessages.length > 0 && thread.settings) {
      await this.maybeAutoCompactOnModelSwitch(
        projectId,
        threadId,
        sessionId,
        driver,
        projectPath,
        thread.settings
      )
    }

    // The switch succeeded (a replacement session is bound). Best-effort release
    // the old harness's session so its native context, prompt cache, and storage
    // are reclaimed instead of orphaned on disk.
    //
    // The release is skipped while a model-fallback resume for this thread is
    // still dispatching and the previous session's turn is still running: the
    // release retires that state and deletes the native session its turn is
    // streaming into, which is how a concurrently resumed turn ended with
    // `Session not found`. A user's own harness switch still releases the old
    // session, because no resume holds the thread then.
    const previousOwnedByResume =
      previousSessionId !== undefined &&
      this.host.state.assistantFallbackResumes.has(`${projectId}:${threadId}`) &&
      this.host.sessionStatuses.get(previousSessionId)?.state === 'working'
    if (
      switchedRuntime &&
      previousHarnessId &&
      previousAccountId &&
      previousSessionId &&
      !previousOwnedByResume
    ) {
      await this.host.units['providers-harness'].releaseOrphanedHarnessSession(
        projectId,
        threadId,
        projectPath,
        previousHarnessId,
        previousAccountId,
        previousSessionId
      )
    }

    this.host.registerSession(
      sessionId,
      projectId,
      threadId,
      projectPath,
      thread.settings?.permissionLevel ?? 'auto_review',
      driverId
    )
    const registered = this.host.sessionRegistry.get(sessionId)
    if (registered) registered.accountId = accountId
    // Heal a binding stamped with a placeholder account. The reserve it names
    // died with the process that created it, so keeping it would re-derive the
    // same "different account" mismatch on every later turn.
    if (
      thread.sessionAccountId &&
      thread.sessionAccountId !== accountId &&
      !(await this.host.state.accountRegistry.isResolvableAccountId(thread.sessionAccountId))
    ) {
      try {
        broadcastThreadUpdate(
          await this.host.threadManager.setSessionId(
            projectId,
            threadId,
            sessionId,
            driverId,
            accountId
          )
        )
      } catch (error) {
        Logger.dev('Session account binding could not be healed:', error)
      }
    }
    const recoveredTurnFinished = storedSessionMessages.at(-1)?.role === 'assistant'
    if (recoveredTurnFinished || (thread.status !== 'planning' && thread.status !== 'executing')) {
      const initialSpecKey = this.host.units['spec'].initialSpecKey(projectId, threadId)
      if (!this.host.state.initialSpecTasks.has(initialSpecKey)) {
        void this.host.units['spec-lifecycle']
          .runPendingInitialSpec(projectId, threadId)
          .catch((error) => Logger.error('Pending specification recovery failed:', error))
      }
      void this.host.units['spec-lifecycle']
        .runPendingSpecRevision(sessionId, storedSessionMessages, {
          projectId,
          threadId
        })
        .catch((error) => {
          broadcastToast(
            `Specification update recovery failed: ${
              error instanceof Error ? error.message : 'The submitted revision was invalid.'
            }`
          )
        })
      void this.host.units['prd']
        .runPendingPrdTurn(sessionId, storedSessionMessages, {
          projectId,
          threadId
        })
        .catch((error) => {
          broadcastToast(
            `PRD recovery failed: ${
              error instanceof Error ? error.message : 'The submitted document was invalid.'
            }`
          )
        })
    }
    return sessionId
  }

  retireSessionState(sessionId: string): void {
    this.host.state.planningSessions.delete(sessionId)
    this.host.state.preparedImplementationSessions.delete(sessionId)
    this.host.sessionRegistry.delete(sessionId)
    this.host.sessionStatuses.delete(sessionId)
    this.host.state.retryScheduler?.clear(sessionId)
    updateRetryWakeWindow(sessionId, null)
    this.host.state.reasoningTimes.delete(sessionId)
    this.host.state.toolTimes.delete(sessionId)
    this.host.state.generationClock.dropSession(sessionId)
    this.host.handledIdleSessions.delete(sessionId)
    this.host.state.userAbortedSessions.delete(sessionId)
    this.host.state.outboundMessageIdsBySession.delete(sessionId)
    this.host.state.mermaidRepairAttempts.delete(sessionId)
    this.host.state.incompleteTurnRecoveryAttempts.delete(sessionId)
    this.host.state.engineeringImplementationSessions.delete(sessionId)
    this.host.state.searchNudgeAttempts.delete(sessionId)
    this.host.state.visualDeliverableNudges.delete(sessionId)
    this.host.state.artifactRenderedSessions.delete(sessionId)
    this.host.state.todoReconcileAttempts.delete(sessionId)
    this.host.state.sessionNativeHistory.delete(sessionId)
    this.host.state.parkedSessionReplay.delete(sessionId)
    this.clearSessionWatchdog(sessionId)
    this.host.units['questions'].clearPendingQuestionsForSession(sessionId)
    this.host.units['permissions'].clearPendingPermissionsForSession(sessionId)
    this.host.units['media-visual'].clearPendingImageDescriptorDecisionsForSession(sessionId)
    this.host.state.activeCompactions.delete(sessionId)
  }

  /** Return the latest provider lifecycle state retained for this thread. */
  async getSessionStatus(projectId: string, threadId: string): Promise<AgentSessionStatus | null> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return null
    if (this.host.state.ovenChat.remote(thread)) {
      await this.host.state.ovenChat.restore(thread)
      return thread.sessionId
        ? (this.host.sessionStatuses.get(thread.sessionId) ?? { state: 'idle' })
        : null
    }

    if (!thread.sessionId) {
      return thread.status === 'working-paused'
        ? this.restoredRetryWaitStatus(thread, threadId)
        : null
    }
    const pendingSpec = await this.host.units['spec-lifecycle'].readPendingInitialSpec(
      projectId,
      threadId
    )
    if (pendingSpec?.state === 'pending' || pendingSpec?.state === 'generating') {
      const activeSpec = await this.host.units['spec'].getActiveSpec(projectId, threadId)
      if (activeSpec) {
        await this.host.units['spec-lifecycle'].runPendingInitialSpec(projectId, threadId)
        return { state: 'idle' }
      }
      const liveActivity = this.host.sessionStatuses.get(thread.sessionId)
      return liveActivity?.state === 'working' && liveActivity.activity
        ? liveActivity
        : initialSpecWorkingStatus(pendingSpec)
    }
    // The Sr. Engineer planning surface owns failed initial-spec presentation
    // and its Retry specification action. Do not rehydrate a provider card.
    if (pendingSpec?.state === 'failed') return null
    let live = this.host.sessionStatuses.get(thread.sessionId)
    if (thread.status === 'completed' || thread.status === 'interrupted') {
      // The shared row also repairs missed pub-sub frames and stale launch ledgers.
      if (live?.state === 'waiting' || live?.state === 'error') {
        this.host.sessionStatuses.delete(thread.sessionId)
        live = undefined
      }
      if (this.host.state.retryScheduler?.getPendingRetry(thread.sessionId)) {
        this.host.state.retryScheduler.clear(thread.sessionId)
      }
      this.host.state.retryScheduler?.resumed(thread.sessionId)
      return live ?? { state: 'idle' }
    }
    if (live?.state === 'waiting' || live?.state === 'error') return live
    // After an app restart the in-memory status is gone, but a persisted
    // auto-resume record is authoritative: reconstruct the waiting card so the
    // thread still shows its reset countdown and proves it will auto-run.
    const pending = this.host.state.retryScheduler?.getPendingRetry(thread.sessionId)
    if (pending) {
      return {
        state: 'waiting',
        issue: {
          kind: pending.issueKind,
          message: pending.issueMessage,
          harnessId: pending.harnessId,
          retryable: true,
          ...(pending.retryAt === undefined
            ? {}
            : { retryAt: pending.resetAt ?? pending.retryAt, autoResumeAt: pending.retryAt }),
          ...(pending.rawError === undefined ? {} : { rawError: pending.rawError }),
          ...(pending.attempt === undefined ? {} : { attempt: pending.attempt })
        }
      }
    }
    if (thread.status !== 'working-paused') return live ?? null
    return this.restoredRetryWaitStatus(thread, threadId)
  }

  /** Rebuild a visible paused card after the in-memory provider state is gone. */
  restoredRetryWaitStatus(thread: Thread, threadId: string): AgentSessionStatus {
    // A paused status can outlive the in-memory issue when the app is killed
    // between the provider event and scheduler persistence. Rebuild a safe
    // waiting card from the persisted failure when available, otherwise keep
    // the user-facing state explicit and manual.
    const row = this.host.database.get<{ error: string | null }>(
      `SELECT error FROM agent_messages
       WHERE thread_id = ? AND error IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      threadId
    )
    const persistedError = row?.error?.trim() ?? ''
    const inferredKind = classifyProviderIssue(persistedError)
    const usageWait = isUsageResetWaitIssue({ kind: inferredKind, retryable: true })
    return {
      state: 'waiting',
      issue: {
        kind: usageWait ? inferredKind : 'unknown',
        message: usageWait
          ? persistedError
          : 'This turn is paused. No automatic retry is scheduled.',
        ...(usageWait && persistedError ? { rawError: persistedError } : {}),
        harnessId: thread.settings?.harnessId ?? thread.sessionHarnessId ?? 'unknown',
        retryable: true
      }
    }
  }

  /**
   * Dismiss a thread's error card. The user closing it means they no longer
   * want to see the error status (or the card) again, so clear every piece of
   * cached error state for the session and reset the thread's status from
   * `failed` back to `completed` so it reads as done rather than error. This is
   * a user-intent reset: it never re-runs the turn or schedules anything.
   */
  async dismissSessionError(projectId: string, threadId: string, sessionId: string): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    if (sessionId) sessionId = validateEntityId(sessionId, 'Session ID')
    if (this.host.sessionStatuses.get(sessionId)?.state === 'error') {
      this.host.sessionStatuses.delete(sessionId)
    }
    this.host.state.retryScheduler?.clear(sessionId)
    updateRetryWakeWindow(sessionId, null)
    this.clearSessionWatchdog(sessionId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (thread?.status === 'failed') {
      await this.host.threadManager.setStatus(projectId, threadId, 'completed', { read: true })
    }
    if (sessionId) {
      this.host.broadcast({
        type: 'session.status',
        sessionId,
        status: { state: 'idle' }
      })
    }
  }

  /**
   * Count sessions and processes that are actively working or awaiting input  
   * anything that would be interrupted by a forced restart: streaming turns,
   * permission/question decisions, in-flight shell tools, child sessions,
   * pending spec/brainstorm drafts, and in-progress compaction.
   *
   * Kept for power-management and diagnostics. The updater gate intentionally
   * does NOT use this   see `workingSessionCount()` which mirrors the
   * AppHeader pulse.
   */
  activeSessionCount(): number {
    const active = this.engineDrivenSessions()
    const add = (id: string) => active.add(id)

    for (const [sessionId, status] of this.host.sessionStatuses) {
      if (status.state === 'working' || status.state === 'waiting') add(sessionId)
    }
    for (const [sessionId, info] of this.host.sessionRegistry) {
      if (info.activeTurnId || (info.openUnboundedTools && info.openUnboundedTools.size > 0)) {
        add(sessionId)
      }
    }
    return active.size
  }

  /**
   * Sessions this engine is still driving for a reason the status map does not
   * record: a specification or Brainstorm generating in a disposable session, a
   * workflow sitting between its steps, a card the user has not answered, a
   * compaction, a child sub-agent, a loop iteration, an awaited completion.
   *
   * Shared so the count above and {@link reconcileUnverifiedWork} can never
   * disagree about what the engine itself is doing. A session named here has
   * work in flight that no harness turn accounts for, so a quiet probe from the
   * thread's own session says nothing about it and must never be read as a
   * finished turn.
   */
  engineDrivenSessions(): Set<string> {
    const active = new Set<string>()
    const add = (id: string) => active.add(id)

    for (const pending of this.host.state.pendingPermissions.values()) {
      add(pending.request.sessionId)
    }
    for (const pending of this.host.pendingQuestions.values()) {
      add(pending.request.sessionId)
    }
    for (const pending of this.host.state.pendingImageDescriptorDecisions.values()) {
      add(pending.sessionId)
    }
    for (const sessionId of this.host.state.childSessionOwners.keys()) add(sessionId)
    for (const sessionId of this.host.state.completionWaiters.keys()) add(sessionId)
    for (const sessionId of this.host.state.activeCompactions) add(sessionId)
    for (const sessionId of this.host.state.activeBrainstormOperations) add(sessionId)
    for (const sessionId of this.host.state.activeBrainstormSessions.keys()) add(sessionId)
    for (const sessionId of this.host.state.pendingSpecRevisions.keys()) add(sessionId)
    for (const sessionId of this.host.state.pendingPrdTurns.keys()) add(sessionId)
    for (const sessionId of this.host.state.pendingAssignmentTurns.keys()) add(sessionId)
    for (const sessionId of this.host.state.pendingBrainstormTurns.keys()) add(sessionId)
    for (const sessionId of this.host.state.activeLoopRuns) add(sessionId)
    // A planning turn shows `working` on the thread's own session while the
    // engine runs the actual generation somewhere else entirely.
    for (const sessionId of this.host.state.planningSessions) add(sessionId)
    return active
  }

  /**
   * Sessions actively producing work   mirrors `AppHeader`'s pulse
   * (`agentRuns.isBusy` / `isThreadWorking`). Only `sessionStatuses === 'working'`
   * counts; `waiting`, pending permissions/questions, compactions, brainstorm,
   * loops, child sessions and idle PTYs do not pulse the header and must not
   * block "Restart to update".
   */
  workingSessionCount(): number {
    let count = 0
    for (const status of this.host.sessionStatuses.values()) {
      if (status.state === 'working') count++
    }
    return count
  }

  /**
   * Settle sessions this engine reports as `working` that no harness is actually
   * running, and return how many were settled.
   *
   * `working` is an optimistic status: {@link markSessionWorking} records it when
   * a turn is *dispatched*, before the harness has confirmed anything. The turn's
   * real end arrives as a driver event, so a session whose driver never emits one
   * stays `working` for the life of the process. That ghost is invisible to every
   * consumer of the status map at once: the sidebar pulses, the header badge
   * spins, and the updater's install gate never opens.
   *
   * The gate is where it bites. An update that deferred its install persisted
   * `installPending`, and the next launch dispatches the recovered turns before
   * the updater asks anything, so those threads are `working` before the first
   * question is put to them. When one of them is unrunnable (the harness changed
   * under the session across the update, the per-turn server never starts, the
   * provider is signed out) `sendPrompt` resolved, so no failure path runs, and
   * the app waits for ghosts to let the update through. The update is the only
   * thing that would have cleared them.
   *
   * Only the harness's own account of the session settles it. A driver that
   * reports the session busy, a session with an in-flight tool or child
   * sub-agent, work the engine is running outside that turn at all (see
   * {@link engineDrivenSessions}), and a session parked on a card the user has
   * not settled are all left running. The verdict must also repeat across two
   * consecutive sweeps: compaction and provider-retry gaps leave a live turn
   * briefly idle by the harness's own account, and one quiet poll in that
   * window is not evidence the turn is over.
   *
   * This is the `SessionActivitySource.reconcileUnverifiedWork` the updater's
   * install gate calls, so the gate's "is anything running?" is the same verified
   * answer the sidebar and header badges show rather than a second, looser one.
   */
  async reconcileUnverifiedWork(): Promise<number> {
    const driven = this.engineDrivenSessions()
    const candidates: Array<{
      sessionId: string
      info: SessionInfo
      driver: HarnessDriver
    }> = []
    for (const [sessionId, status] of [...this.host.sessionStatuses]) {
      if (status.state !== 'working') continue
      // Work the engine is running outside this harness turn, and a card the
      // user has not answered, both outrank a quiet probe.
      if (driven.has(sessionId)) continue
      const info = this.host.sessionRegistry.get(sessionId)
      // An unregistered session has no driver, project or harness to ask, so
      // nothing here can be corroborated. Leave it to the paths that own it.
      if (!info) continue
      if (this.host.units['misc'].hasInFlightWork(sessionId, info)) continue
      if (this.sessionAwaitsUserInput(sessionId)) continue
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        info.driverId,
        info.accountId
      )
      // A driver that cannot answer is not evidence of anything, in either
      // direction: never read silence from a harness that was not asked.
      if (!driver?.isSessionBusy) continue
      candidates.push({ sessionId, info, driver })
    }

    // Asked together, never one after another. Each probe is bounded by its own
    // timeout and a launch can hold several stale sessions at once, so a serial
    // sweep would make settling the slowest one the price of every other.
    const probes = await Promise.all(
      candidates.map(async (candidate) => ({
        ...candidate,
        probe: await probeSessionLiveness(candidate.driver, candidate.info, candidate.sessionId)
      }))
    )

    const idleAgain: Set<string> = new Set()
    const ghosts: Array<{ sessionId: string; info: SessionInfo }> = []
    for (const { sessionId, info, probe } of probes) {
      // Busy, and a probe that could not answer, are both "leave it alone": only
      // the harness saying the session is idle is a claim worth weighing.
      if (probe !== 'idle') continue
      // First quiet observation: remember it, but let the turn keep its status.
      if (!this.host.state.ghostWorkingCandidates.delete(sessionId)) {
        this.host.state.ghostWorkingCandidates.add(sessionId)
        idleAgain.add(sessionId)
        continue
      }
      ghosts.push({ sessionId, info })
    }

    // Whatever stayed quiet this sweep is what the next one has to confirm.
    this.host.state.ghostWorkingCandidates = idleAgain

    for (const { sessionId, info } of ghosts) {
      Logger.info('Settling a session no harness is running', {
        sessionId,
        projectId: info.projectId,
        threadId: info.threadId,
        driverId: info.driverId
      })
      // The idle finalization recovers an unfinished turn by auto-continuing it
      // once. That is right for a turn the harness dropped and wrong here: this
      // turn was just proven unrunnable, so a hidden prompt would spend a real
      // provider call on it, mark the session `working` again, and hand the gate
      // the same ghost one sweep later. Spending the attempt instead lets the
      // finalization record the honest outcome   an interrupted turn with a Retry
      // affordance   which is what the silence watchdog does for the same fact.
      this.host.state.incompleteTurnRecoveryAttempts.set(sessionId, 1)
      // Route through the driver-event pipeline so every idle consumer (status
      // broadcast, thread finalization, checkpoint, notifications) settles
      // exactly as it would have from a real driver idle, instead of this pass
      // inventing a second, divergent definition of "the turn ended".
      this.host.handleDriverEvent(info.driverId, { type: 'session.idle', sessionId })
    }
    return ghosts.length
  }

  /** Publish one canonical working state to session and task consumers. */
  markSessionWorking(sessionId: string): void {
    const changed = this.host.sessionStatuses.get(sessionId)?.state !== 'working'
    this.host.handledIdleSessions.delete(sessionId)
    if (changed) {
      this.host.sessionStatuses.set(sessionId, { state: 'working' })
      this.host.broadcast({
        type: 'session.status',
        sessionId,
        status: { state: 'working' }
      })
    }
    void this.host.units['thread-lifecycle'].reconcileWorkingThreadStatus(sessionId)
  }

  /** Ask the active harness to summarize and compact this thread's context. */
  async compactSession(projectId: string, threadId: string): Promise<void> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.sessionId) {
      throw new Error('No active session for this thread')
    }
    if (!thread.settings) {
      throw new Error('Select a model before compacting this thread')
    }
    const driverId = thread.settings.harnessId ?? DEFAULT_HARNESS
    const account = await this.host.state.accountRegistry.resolveForProvider(
      driverId,
      thread.settings.providerId,
      thread.sessionAccountId ?? thread.settings.accountId
    )
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      threadId,
      account.id
    )
    if (!driver.capabilities?.compaction || !driver.compactSession) {
      throw new Error(`${driver.name} does not support manual compaction`)
    }
    this.host.state.activeCompactions.add(thread.sessionId)
    try {
      await driver.compactSession(projectPath, thread.sessionId, thread.settings)
    } finally {
      this.host.state.activeCompactions.delete(thread.sessionId)
    }
  }

  /**
   * Compact a reused native session before it resumes under a newly selected
   * model whose context window is much smaller than the thread's last-known
   * native usage. Best-effort maintenance: a failed compaction never blocks the
   * turn   the harness trims its own history when the window is genuinely over.
   */
  async maybeAutoCompactOnModelSwitch(
    projectId: string,
    threadId: string,
    sessionId: string,
    driver: HarnessDriver,
    projectPath: string,
    settings: ThreadSettings
  ): Promise<void> {
    if (driver.capabilities?.compaction !== true || !driver.compactSession) return
    if (this.host.state.activeCompactions.has(sessionId)) return
    const state = this.host.sessionStatuses.get(sessionId)?.state
    if (state === 'working' || state === 'waiting') return

    const lastModel = await this.lastSessionModel(projectId, threadId, sessionId)
    if (!lastModel) return
    if (lastModel.providerId === settings.providerId && lastModel.modelId === settings.modelId) {
      return
    }

    const contextWindow = this.host.units['transcripts'].modelContextWindow(
      projectId,
      settings.providerId,
      settings.modelId
    )
    if (contextWindow === undefined) return
    const contextUsed = await this.host.units['transcripts'].lastSessionContextUsed(
      projectId,
      threadId,
      driver.id,
      lastModel.providerId
    )
    if (contextUsed === undefined) return

    if (!decideModelSwitchCompaction({ contextWindow, contextUsed }).shouldCompact) return

    try {
      this.host.state.activeCompactions.add(sessionId)
      await driver.compactSession(projectPath, sessionId, settings)
      broadcastToast(
        `Auto-compacted the thread's context before switching to ${settings.modelId}.`,
        'info'
      )
      Logger.dev('Auto-compacted native session on model switch', {
        projectId,
        threadId,
        sessionId,
        from: `${lastModel.providerId}/${lastModel.modelId}`,
        to: `${settings.providerId}/${settings.modelId}`,
        contextUsed,
        contextWindow
      })
    } catch (error) {
      Logger.error('Auto-compaction on model switch failed (resuming without it):', {
        projectId,
        threadId,
        sessionId,
        error: rawErrorMessage(error)
      })
    } finally {
      this.host.state.activeCompactions.delete(sessionId)
    }
  }

  /** Last provider/model a session ran under, from this run's dispatches or
   *  the mirrored transcript (the map backfills the first turn after restart). */
  async lastSessionModel(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<{ providerId: string; modelId: string } | null> {
    const recorded = this.host.state.sessionModelIds.get(sessionId)
    if (recorded?.providerId && recorded.modelId) return recorded
    try {
      const records = await this.host.threadManager.loadMessageRecords(projectId, threadId)
      for (const message of [...records].reverse()) {
        if (message.role !== 'assistant') continue
        if (message.providerId && message.modelId) {
          const backfilled = { providerId: message.providerId, modelId: message.modelId }
          this.host.state.sessionModelIds.set(sessionId, backfilled)
          return backfilled
        }
      }
    } catch {
      // Mirror unavailable   the model switch is treated as undetectable.
    }
    return null
  }

  handleSessionIdleSignal(sessionId: string): void {
    if (this.host.handledIdleSessions.has(sessionId)) return
    this.host.handledIdleSessions.add(sessionId)
    // Some idle paths record the status without broadcasting it, so the turn's
    // end is announced here as well as on the status stream.
    this.host.units['turns'].announceTurnActivityChange()
    // The turn ended while a steer was still held (no tool window opened, or
    // the idle arrived between the tool end and the async flush). Deliver it
    // as the next turn's regular send   but only AFTER the idle finalization
    // completes. The finalization tears down the finished turn's utility
    // gateway (handoff clear + gateway.cleanup); the steer's deliverAfterTurn
    // path runs a full sendPrompt that re-arms a fresh gateway turn, and if
    // the two raced the stale cleanup would wipe the new turn's credentials
    // mid-turn, leaving the harness with dead cio_util_* tools.
    const finalization = this.host.units['turns-session-idle']
      .onSessionIdle(sessionId)
      .catch((error) => Logger.error('Session idle finalization failed:', error))
      .then(() => {
        if (this.host.state.heldSteers.has(sessionId)) {
          return this.host.units['turns-steer'].flushHeldSteers(sessionId, 'after-turn')
        }
      })
      .finally(() => {
        if (this.host.state.sessionIdleFinalizations.get(sessionId) === finalization) {
          this.host.state.sessionIdleFinalizations.delete(sessionId)
        }
      })
    this.host.state.sessionIdleFinalizations.set(sessionId, finalization)
    void finalization.then(
      () => this.settleSessionIdleFinalizationWaiters(sessionId),
      (error) => this.settleSessionIdleFinalizationWaiters(sessionId, error)
    )
  }

  /** Wait through the narrow gap between a CLI process exiting and its history mirror starting. */
  awaitSessionIdleFinalization(sessionId: string): Promise<void> {
    const finalization = this.host.state.sessionIdleFinalizations.get(sessionId)
    if (finalization) return finalization
    if (this.host.handledIdleSessions.has(sessionId)) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const waiters = this.host.state.sessionIdleFinalizationWaiters.get(sessionId) ?? []
      waiters.push({ resolve, reject })
      this.host.state.sessionIdleFinalizationWaiters.set(sessionId, waiters)

      const racedFinalization = this.host.state.sessionIdleFinalizations.get(sessionId)
      if (racedFinalization) {
        void racedFinalization.then(resolve, reject)
      } else if (this.host.handledIdleSessions.has(sessionId)) {
        resolve()
      } else {
        return
      }
      this.host.state.sessionIdleFinalizationWaiters.set(
        sessionId,
        waiters.filter((waiter) => waiter.resolve !== resolve)
      )
    })
  }

  /**
   * Join a parked card's session exit without ever blocking on an idle that
   * can no longer arrive, then report the timeout instead of swallowing it.
   */
  async awaitInactiveResumeIdleFinalization(pending: PendingQuestionInfo): Promise<void> {
    const finalized = await this.awaitSessionIdleFinalizationWithin(
      pending.request.sessionId,
      ChatEngine.INACTIVE_QUESTION_RESUME_WAIT_MS
    )
    if (!finalized) {
      Logger.error('Session did not finalize while resuming a parked request   resuming anyway', {
        sessionId: pending.request.sessionId,
        requestId: pending.request.requestId
      })
    }
  }

  /**
   * `awaitSessionIdleFinalization`, but never longer than `timeoutMs`.
   *
   * Native process exits settle in milliseconds, so the bound only ever fires
   * for a session that is alive but cannot idle (parked on a dialog the driver
   * no longer holds). Returns whether the finalization actually landed, and
   * rethrows a real finalization failure exactly as the unbounded wait would.
   */
  async awaitSessionIdleFinalizationWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
    let failure: unknown
    let settled = false
    // The rejection is captured instead of left on the racing promise: when the
    // timeout wins, an unobserved rejection would surface as an unhandled
    // rejection on the main process.
    const finalization = this.awaitSessionIdleFinalization(sessionId).then(
      () => {
        settled = true
      },
      (error: unknown) => {
        settled = true
        failure = error
      }
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([finalization, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (settled && failure !== undefined) throw failure
    return settled
  }

  settleSessionIdleFinalizationWaiters(sessionId: string, error?: unknown): void {
    const waiters = this.host.state.sessionIdleFinalizationWaiters.get(sessionId) ?? []
    this.host.state.sessionIdleFinalizationWaiters.delete(sessionId)
    for (const waiter of waiters) {
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
  }

  /**
   * The message that owns the answer the current turn's task-list reconcile
   * exchange must not replace, or undefined when this turn had no such exchange.
   *
   * Two things can nudge the agent to publish a truth the task card is missing,
   * and each leaves its own mark:
   *
   * - the engine's own reconcile turn (every harness that does not reconcile
   *   inside its own turn) is a prompt the engine issued, so the exchange starts
   *   at that prompt;
   * - a harness that reconciles mid-turn reports the message it is protecting
   *   through the driver (`capabilities.reportsTaskReconcileAnswer`).
   *
   * A harness mark is only read while a turn of this thread owns the session: a
   * stale mark from an earlier turn would name a message the current transcript
   * no longer describes as this turn's work.
   */
  taskReconcileAnswerId(
    driver: HarnessDriver,
    info: SessionInfo,
    sessionId: string
  ): string | undefined {
    if (this.host.state.taskReconcileTurns.delete(sessionId)) return info.activeTurnUserMessageId
    if (driver.capabilities.reportsTaskReconcileAnswer !== true) return undefined
    if (info.activeTurnUserMessageId === undefined) return undefined
    return driver.taskReconcileAnswerId?.(sessionId)
  }

  async onSessionError(
    sessionId: string,
    error?: string,
    retryScheduled = false,
    errorDetail?: string,
    /**
     * False when the caller has already ruled on the turn's liveness itself:
     * the watchdog's silence verdict, and a failure the app established on its
     * own (a history-mirror write). Those must land even while the driver still
     * registers the turn, so a registration no live process stands behind is
     * never deferred forever.
     */
    deferToLiveDriver = true
  ): Promise<void> {
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info) return
    if (info.ephemeral) return
    // A `session.error` event is not proof the underlying turn actually died
    // e.g. pi's transient extension_error fires while its persistent RPC
    // process keeps running and finishes the turn normally. Probe the live
    // process before tearing anything down so a false alarm doesn't wipe the
    // turn's utility gateway handoff out from under still-running tool calls.
    const errorDriver = this.host.units['turns-dispatch'].driverForRuntime(
      info.driverId,
      info.accountId
    )
    if (errorDriver?.isSessionBusy) {
      const probe = await probeSessionLiveness(errorDriver, info, sessionId)
      if (probe === 'busy') return
      // A harness can stop streaming with its turn intact: pi backs off for its
      // own provider retry and aborts its run to compact and re-prompt inside
      // the same turn, and codex holds its turn across the retry gaps. A verdict
      // that lands in one of those gaps describes one request, not the turn, so
      // finalizing here would fail a working turn's checkpoint and clear the
      // utility gateway handoff the resumed run is still calling `cio_util_*`
      // through   the "gateway is not active for this turn" dead end a live
      // design turn abandoned its preview on. The driver's registration is the
      // authority: it clears exactly when nothing can resume the turn, and the
      // watchdog still surfaces a registration its process no longer backs. A
      // probe that cannot answer at all (wedged or gone) is never deferred to.
      if (
        deferToLiveDriver &&
        probe !== 'wedged' &&
        this.host.units['turns'].driverHoldsTurn(sessionId, info.driverId, errorDriver)
      ) {
        Logger.dev('Provider failure deferred: the driver still holds the turn', {
          sessionId,
          driverId: info.driverId,
          error: error ?? null
        })
        return
      }
    }
    this.host.state.pendingMemoryDecisions.delete(sessionId)
    this.host.state.mermaidRepairAttempts.delete(sessionId)
    this.host.state.incompleteTurnRecoveryAttempts.delete(sessionId)
    this.host.state.searchNudgeAttempts.delete(sessionId)
    this.host.state.pendingSpecRevisions.delete(sessionId)
    this.host.state.pendingBrainstormTurns.delete(sessionId)
    // The turn is settling without an idle of its own, so nothing else will
    // mirror what it did. Awaited before the checkpoint completion below
    // broadcasts, so the renderer's own refresh of that update already shows the
    // failed turn's work instead of a conversation that looks empty.
    await this.host.units['speech'].captureFailedTurnTranscript(info, sessionId)
    try {
      await this.host.units['spec-lifecycle'].clearPendingSpecRevision(
        info.projectId,
        info.threadId
      )
      const currentThread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      const retryPaused = retryScheduled || currentThread?.status === 'working-paused'
      await this.host.threadManager.setStatus(
        info.projectId,
        info.threadId,
        retryPaused ? 'working-paused' : 'failed',
        {
          read: false,
          ...(error ? { error } : {}),
          ...(errorDetail ? { errorDetail } : {})
        }
      )
      await this.host.units['transcripts'].finishCheckpoint(
        sessionId,
        info,
        'failed',
        error ?? 'Harness session failed'
      )
      if (retryPaused) return
      const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      if (
        thread?.assignmentRole === 'worker' &&
        thread.assignmentId &&
        thread.assignmentTaskId &&
        // Reporting off means this thread is not part of the hand-back loop, so a
        // harness failure must not be reported   the engine would refuse it and
        // the refusal would surface as recovery noise.
        workerReportsToCoordinator(thread.settings)
      ) {
        const report: AssignmentTaskReport = {
          status: 'failed',
          summary: error ?? 'The worker harness session failed.',
          evidence: [`Worker thread ${thread.id} ended with a harness error.`],
          reportedAt: Date.now()
        }
        const result = await this.host.state.assignmentEngine.reportTask(
          thread.assignmentId,
          thread.assignmentTaskId,
          thread.id,
          report,
          `worker-session-failed-${sessionId}-${info.activeTurnId ?? 'unbound-turn'}`
        )
        if (!result.idempotent) {
          await this.host.units['audit'].promptCoordinatorForAudit(
            result.assignment,
            thread.assignmentTaskId,
            report
          )
        }
      } else if (thread?.assignmentRole === 'coordinator' && thread.assignmentId) {
        const assignment = this.host.state.assignmentEngine.getActive(info.projectId, info.threadId)
        const seniorTasks =
          assignment?.content.tasks.filter(
            (task) =>
              task.owner === 'senior' &&
              (task.threadId === undefined || task.threadId === thread.id) &&
              ['ready', 'running', 'rework'].includes(task.status)
          ) ?? []
        // Attribute a coordinator failure only when there is one unambiguous
        // senior-owned task. If several tasks are actionable, the error stays
        // on the coordinator thread instead of guessing which task owned it.
        if (assignment?.id === thread.assignmentId && seniorTasks.length === 1) {
          const seniorTask = seniorTasks[0]
          const runningTask =
            seniorTask.status === 'running'
              ? seniorTask
              : (
                  await this.host.state.assignmentEngine.assignTask(
                    assignment.id,
                    seniorTask.id,
                    `senior-session-failed-assign-${sessionId}-${info.activeTurnId ?? 'unbound-turn'}`
                  )
                ).task
          if (runningTask) {
            await this.host.state.assignmentEngine.reportTask(
              assignment.id,
              runningTask.id,
              thread.id,
              {
                status: 'blocked',
                summary: error ?? 'The Sr. Engineer harness session failed.',
                evidence: [
                  `Sr. Engineer thread ${thread.id} ended with a harness or provider error.`
                ],
                reportedAt: Date.now()
              },
              `senior-session-failed-report-${sessionId}-${info.activeTurnId ?? 'unbound-turn'}`
            )
          }
        }
      }
    } catch (failure) {
      Logger.error('session error recovery failed:', failure)
    } finally {
      await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
    }
  }

  /** Push the watchdog timer out by the full timeout window. */
  resetSessionWatchdog(sessionId: string): void {
    const existing = this.host.state.sessionWatchdogs.get(sessionId)
    if (existing) {
      clearTimeout(existing)
      const timer = setTimeout(
        () => void this.fireSessionWatchdog(sessionId),
        ChatEngine.SESSION_ACTIVITY_TIMEOUT_MS
      )
      this.host.state.sessionWatchdogs.set(sessionId, timer)
    }
  }

  /** Cancel the watchdog for a session that completed normally or via error. */
  clearSessionWatchdog(sessionId: string): void {
    const existing = this.host.state.sessionWatchdogs.get(sessionId)
    if (existing) {
      clearTimeout(existing)
      this.host.state.sessionWatchdogs.delete(sessionId)
    }
  }

  /** Whether the session is parked on a card the user has not settled: a
   *  question, a permission request, or an image-descriptor decision. */
  sessionAwaitsUserInput(sessionId: string): boolean {
    return (
      [...this.host.pendingQuestions.values()].some(
        (pending) => pending.request.sessionId === sessionId
      ) ||
      [...this.host.state.pendingPermissions.values()].some(
        (pending) => pending.request.sessionId === sessionId
      ) ||
      [...this.host.state.pendingImageDescriptorDecisions.values()].some(
        (pending) => pending.sessionId === sessionId
      )
    )
  }

  /**
   * Called when the watchdog fires   the session has been silent for one check window.
   * When the session is demonstrably still working (an in-flight shell tool or
   * a running sub-agent), the silence is legitimate and the window is extended
   * instead of aborting. Otherwise we try to fetch the conversation history
   * from the agent to surface the actual error (rate-limit, credit exhaustion,
   * provider deprecated, etc.) before cleaning up.
   */
  async fireSessionWatchdog(sessionId: string): Promise<void> {
    this.host.state.sessionWatchdogs.delete(sessionId)
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info) return

    // A genuinely-working-but-silent session must never be aborted: a long CLI
    // action can legitimately produce no events for far longer than the
    // activity window. Extend the window (re-evaluating when it fires again) so
    // live work survives; only silence with no in-flight work is treated as dead.
    if (this.host.units['misc'].hasInFlightWork(sessionId, info)) {
      Logger.info('Session silent but demonstrably working   extending watchdog', {
        sessionId,
        projectId: info.projectId,
        threadId: info.threadId
      })
      this.host.units['lifecycle'].startSessionWatchdog(sessionId, ChatEngine.SILENT_WORK_GRACE_MS)
      return
    }

    const issue = await this.host.recoverWatchdogIssue(sessionId, info)
    if (!issue) {
      // Stream silence is not a terminal signal. Providers may spend an
      // unbounded amount of time reasoning or running a tool without emitting
      // another event, while their harness process remains healthy. Keep the
      // canonical working state and re-check later; driver lifecycle events
      // remain authoritative for completion and transport failures. A card the
      // user has not settled is the same bargain from the other side: the turn
      // is waiting on a human, so the card's own timer ends the wait.
      const waitingOnUser = this.sessionAwaitsUserInput(sessionId)
      Logger.info(
        waitingOnUser
          ? 'Session is waiting on the user   extending watchdog'
          : 'Session remains silent without an explicit provider failure   preserving turn',
        { sessionId, projectId: info.projectId, threadId: info.threadId }
      )
      this.host.units['lifecycle'].startSessionWatchdog(sessionId, ChatEngine.SILENT_WORK_GRACE_MS)
      return
    }

    // A driver that still owns the turn has not failed. Pi's page checkpoint
    // aborts the in-flight run (leaving an aborted-message error in the
    // transcript) while it compacts and re-prompts the same turn, and codex
    // holds its turn across the retry gaps; the recovered issue would
    // otherwise park a live turn on a failed card. While the live probe still
    // reports the harness busy, the turn is working: keep the window open and
    // let the driver finish it. A registration the driver never releases is
    // still surfaced, because the probe then reports the process idle or
    // wedged and this block does not apply.
    const watchdogDriver = this.host.units['turns-dispatch'].driverForRuntime(
      info.driverId,
      info.accountId
    )
    if (
      watchdogDriver?.hasActiveTurn &&
      watchdogDriver.hasActiveTurn(sessionId) &&
      watchdogDriver.isSessionBusy &&
      (await probeSessionLiveness(watchdogDriver, info, sessionId)) === 'busy'
    ) {
      Logger.info('Session silent while its driver still owns the turn   extending watchdog', {
        sessionId,
        projectId: info.projectId,
        threadId: info.threadId
      })
      this.host.units['lifecycle'].startSessionWatchdog(sessionId, ChatEngine.SILENT_WORK_GRACE_MS)
      return
    }

    // A harness can settle a session without the driver noticing: pi's
    // auto-compaction aborts the active run, compacts, and (on overflow)
    // retries, and the driver's turn registration is gone by the time the
    // final `agent_settled` arrives   so no idle finalization ever fires and
    // the thread sits on a working card forever. A settled, still-connected
    // session with no registered driver turn is not an error: emit a synthetic
    // idle so the engine's normal finalization runs (its incomplete-turn
    // recovery continues the thread) instead of parking it on an error card.
    if (
      watchdogDriver?.hasActiveTurn &&
      !watchdogDriver.hasActiveTurn(sessionId) &&
      watchdogDriver.isSessionBusy &&
      (await probeSessionLiveness(watchdogDriver, info, sessionId)) === 'idle' &&
      !this.host.units['misc'].hasInFlightWork(sessionId, info)
    ) {
      Logger.info(
        'Session settled without driver finalization (compaction/retry gap)   reconciling to idle',
        {
          sessionId,
          projectId: info.projectId,
          threadId: info.threadId
        }
      )
      this.clearSessionWatchdog(sessionId)
      // Recover any compaction pi wrote durably during the gap before the
      // synthetic idle finalizes the turn, so the next history replay starts
      // at the true post-compaction boundary instead of the full transcript.
      try {
        await watchdogDriver.reconcileSession?.(info.projectPath, sessionId)
      } catch (error) {
        Logger.dev('Watchdog compaction reconciliation failed:', error)
      }
      // Route through the driver-event pipeline so every idle consumer
      // (status broadcast, thread finalization, notifications) sees the same
      // synthetic signal it would have seen from a real driver idle event.
      this.host.handleDriverEvent(info.driverId, { type: 'session.idle', sessionId })
      return
    }

    await this.failWatchedSession(info, sessionId, issue)
  }

  /**
   * Surface a watchdog failure to every renderer bound to the thread and stop
   * the session, so the user sees the real failure (with a Retry affordance)
   * instead of a silent fail.
   */
  async failWatchedSession(
    info: SessionInfo,
    sessionId: string,
    issue: AgentProviderIssue
  ): Promise<void> {
    await this.host.units['thread-lifecycle'].broadcastThreadSessionError(
      info.projectId,
      info.threadId,
      sessionId,
      issue
    )
    // The watchdog ruled on this session after its own silence window, so its
    // verdict is authoritative: a driver registration it does not believe in
    // must not be able to defer the failure out of existence.
    await this.onSessionError(sessionId, issue.message, false, issue.rawError, false)
    try {
      const driver = this.host.units['turns-dispatch'].driverForRuntime(
        info.driverId,
        info.accountId
      )
      if (driver) await driver.abort(info.projectPath, sessionId)
    } catch {
      /* abort is best-effort */
    }
  }

  // ─── Completion waiter   used by ephemeral sessions ─────────────────────

  waitForSessionCompletion(
    sessionId: string,
    timeoutMs: number | null = 180_000,
    label = 'Agent session',
    timeoutError?: () => Error
  ): Promise<unknown | undefined> {
    const labelForMessage = label
    return new Promise((resolve, reject) => {
      const armTimer = (): ReturnType<typeof setTimeout> | undefined => {
        if (timeoutMs === null) return undefined
        return setTimeout(() => {
          this.host.state.completionWaiters.delete(sessionId)
          reject(
            timeoutError?.() ?? new Error(`${labelForMessage} timed out after ${timeoutMs / 1000}s`)
          )
        }, timeoutMs)
      }
      const waiter: SessionCompletionWaiter = {
        active: false,
        resolve,
        reject,
        timer: armTimer(),
        refresh: () => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          waiter.timer = armTimer()
        }
      }
      this.host.state.completionWaiters.set(sessionId, waiter)
    })
  }
}
