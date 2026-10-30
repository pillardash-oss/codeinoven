import { unarchivedThreadSql } from '../../../lib/archives'
import { net } from 'electron'
import { Logger } from '../../system/logger'
import { updateRetryWakeWindow } from '../thread-events'
import type { RetrySchedulerService } from '../../system/retry-scheduler-service'
import type { ConnectivitySource } from '../../system/connectivity-service'
import type { HeartbeatSchedulerService } from '../../system/heartbeat-scheduler-service'
import { instanceRegistry } from '../../system/instance-registry'
import { instanceEventBus } from '../../system/instance-event-bus'
import type {
  AgentProviderIssue,
  AgentSessionStatus,
  SessionAgentEvent,
  Thread
} from '../../../lib/types'
import {
  classifyProviderIssue,
  isUsageLimitNoticeText,
  isUsageResetWaitIssue,
  parseUsageResetAt
} from '../../../lib/provider-issue'
import type { SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import {
  CONNECTION_LOSS_GRACE_MS,
  CONNECTION_WAIT_MESSAGE,
  RETRY_FIRE_GRACE_MS,
  USAGE_RESET_FALLBACK_RETRY_MS
} from './chat-engine-constants'
import { probeSessionLiveness } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine runtime-connectivity: one concern, moved verbatim from the composition root. */
export class ChatEngineRuntimeConnectivity {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Put a run back when the hand-off it was already stopped for cannot complete.
   *
   * The stop comes first because a Codex app-server only hands a native thread
   * over while no turn is running on it. When the writer release refuses anyway,
   * leaving the thread stopped would cost the user the run they were watching for
   * a transfer that never happened, so this instance resumes it through the same
   * path the adopting instance would have used, and the refusal says the run
   * stayed here.
   */
  async resumeRunAfterRefusedHandOff(
    thread: Thread,
    reason: string
  ): Promise<{ released: false; reason: string }> {
    try {
      if (
        await this.host.units['thread-lifecycle'].resumeThreadFromPersistedSession(thread, {
          force: true
        })
      ) {
        instanceRegistry.publishTurnActivity()
        return { released: false, reason: `${reason} The run continued on this instance.` }
      }
    } catch (error) {
      Logger.error('A refused cross-instance hand-off could not resume its run:', {
        projectId: thread.projectId,
        threadId: thread.id,
        error: rawErrorMessage(error)
      })
    }
    return {
      released: false,
      reason: `${reason} The run was stopped and could not be handed over.`
    }
  }

  logWorkflowResumeDeferred(coordinatorThreadId: string, ownerPid: number | null): void {
    Logger.info('Workflow resume deferred to the instance that owns it', {
      pid: process.pid,
      coordinatorThreadId,
      ownerPid
    })
  }

  /**
   * Whether this launch must leave work that carries no owner at all alone.
   *
   * Every instance shares one config root, so the thread table, the persisted
   * retry ledger, and the ready-spec/Brainstorm rows are common. The paths this
   * guards resume work from persisted state that names no owning process, so a
   * launch that finds another live instance cannot tell whether that instance is
   * already driving it. The driver busy probes cannot help: `isSessionBusy` only
   * sees harnesses owned by this process. Starting the work anyway would send a
   * hidden `Continue` and spawn a second concurrent harness run for a session
   * that is already working   which then rewrites that session's per-turn runtime
   * files and strips the original run of its tools.
   *
   * This is the fallback for work with no ownership record. Coordinated workflows
   * do have one   {@link claimWorkflowForDrive} decides them per workflow   and
   * turns that record an owner are handled precisely by restart recovery, which
   * settles only turns whose owner process is gone.
   */
  deferAutomaticResumeToLiveInstance(reason: string): boolean {
    if (!instanceRegistry.hasOtherLiveInstance()) return false
    Logger.info('Automatic resume deferred to another live CodeInOven instance', {
      pid: process.pid,
      reason
    })
    return true
  }

  async resumePendingWork(): Promise<void> {
    try {
      const config = await this.host.storage.getConfig()
      if (config.resumeWorkOnRestart === false) return
      const threads = await this.host.threadManager.listAllThreads()
      for (const thread of threads) {
        if (thread.archived) continue
        await this.resumePendingWorkflow(thread, threads)
      }
    } catch (error) {
      Logger.error('Achievement recovery failed:', error)
    }
  }

  /**
   * Resume one thread's persisted workflow, if it needs it and this process may
   * own it.
   *
   * Every workflow is gated as a unit before it is touched: an Assignment, its
   * interrupted audit cycle, and an Achievement loop all belong to one
   * coordinated group, and that group is only driven by the instance that owns it
   * (see {@link claimWorkflowForDrive}). This is also the resumption a
   * cross-instance workflow transfer uses, so the two can never drift apart in
   * what they skip or how they resume.
   */
  async resumePendingWorkflow(thread: Thread, threads: Thread[]): Promise<boolean> {
    let assignment = this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)
    if (assignment?.status === 'draft') return false
    if (assignment && ['approved', 'running', 'attention'].includes(assignment.status)) {
      if (
        !(await this.host.units['runtime-workflows'].claimWorkflowForDrive(
          thread.projectId,
          thread,
          'pending workflows',
          threads
        ))
      ) {
        return false
      }
      assignment =
        await this.host.units['assignment-workers'].reconcileUnavailableAssignmentWorkers(
          assignment
        )
      await this.host.units['assignment'].resumeAssignmentAttentionInternal(
        assignment.projectId,
        thread.id
      )
      return true
    }
    if (assignment?.status === 'completed' && assignment.auditCycle?.status === 'running') {
      if (
        !(await this.host.units['runtime-workflows'].claimWorkflowForDrive(
          thread.projectId,
          thread,
          'pending workflows',
          threads
        ))
      ) {
        return false
      }
      void this.host.units['audit'].resumeInterruptedAssignmentAudit(assignment, thread.settings)
      return true
    }
    if (thread.settings?.loopMode !== true) return false
    const activeSpec = await this.host.units['spec'].getActiveSpec(thread.projectId, thread.id)
    if (
      activeSpec?.status !== 'approved' ||
      this.host.units['turns'].engineeringLifecycleActive(thread.projectId, thread.id)
    ) {
      return false
    }
    if (!thread.auditState && (thread.loopIteration ?? 0) === 0 && thread.status !== 'completed') {
      return false
    }
    if (
      !(await this.host.units['runtime-workflows'].claimWorkflowForDrive(
        thread.projectId,
        thread,
        'pending workflows',
        threads
      ))
    ) {
      return false
    }
    if (thread.auditState === 'running') {
      await this.host.threadManager.setAuditState(thread.projectId, thread.id, 'offered')
    }
    void this.host.units['misc'].continueLoop(thread.projectId, thread.id)
    return true
  }

  /** Wake retained connection failures when the device reports a reconnection. */
  connectionRestored(): void {
    this.host.state.retryScheduler?.connectionRestored()
  }

  /**
   * Register the verified connectivity tracker, and drain the resume queue on
   * every transition into a verified online state.
   *
   * A wait parked on the device's connection is resumed from here rather than
   * from the renderer's own event. The renderer relays what the operating
   * system believes, and that belief can stay wrong in both directions (an
   * associated access point with no uplink still reports online); only a probe
   * that actually reached the network may start a harness turn again.
   */
  attachConnectivity(connectivity: ConnectivitySource): () => void {
    this.host.state.connectivity = connectivity
    return connectivity.onRestored(() => this.host.connectionRestored())
  }

  /**
   * Whether the device can reach the outside right now.
   *
   * The verified answer once boot has attached the tracker, the Chromium hint
   * as the floor before that. Failing towards "online" is deliberate: a resume
   * fired against a dead link costs one attempt and a cooldown, while a resume
   * that never fires strands the thread and the promise its card made.
   */
  deviceOnline(): boolean {
    return this.host.state.connectivity ? this.host.state.connectivity.isOnline() : net.isOnline()
  }

  /**
   * Register the auto-resume scheduler. Its resume callback routes back into
   * this engine so a timed retry flows through the same sendPrompt pipeline as
   * a manual Retry.
   */
  attachRetryScheduler(scheduler: RetrySchedulerService): void {
    this.host.state.retryScheduler = scheduler
    this.host.state.stopRemoteRetryReconciliation?.()
    this.host.state.stopRemoteRetryReconciliation = instanceEventBus.onRemoteEvent(({ event }) => {
      // Observe recovery without feeding foreign events through local run actions.
      // A sibling's resumed/settled session invalidates this process's saved wait.
      if (
        event.type !== 'session.status' ||
        (event.status.state !== 'working' && event.status.state !== 'idle')
      )
        return
      if (
        event.status.state === 'idle' &&
        this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(event.sessionId)
      )
        return
      const previous = this.host.sessionStatuses.get(event.sessionId)
      if (previous?.state === 'waiting' || previous?.state === 'error') {
        this.host.sessionStatuses.delete(event.sessionId)
      }
      if (scheduler.getPendingRetry(event.sessionId)) scheduler.clear(event.sessionId)
      scheduler.resumed(event.sessionId)
    })
    scheduler.attachNetworkTest(() => this.deviceOnline())
    scheduler.attachStoppedThreadTest(async (projectId, threadId) => {
      const visible = await this.host.database.queryViaWorker(
        `SELECT id FROM threads WHERE id = ? AND project_id = ? AND ${unarchivedThreadSql()}`,
        [threadId, projectId],
        1
      )
      return (
        !visible.ok ||
        visible.rows.length === 0 ||
        (await this.host.threadManager.wasStoppedByUser(projectId, threadId))
      )
    })
    void scheduler.attachContinue((record) => this.host.continueScheduledThread(record))
  }

  /** Wire the heartbeat scheduler's timed pings back through this engine's drivers. */
  attachHeartbeatScheduler(scheduler: HeartbeatSchedulerService): void {
    scheduler.attachPing((config) => this.host.units['turns-dispatch'].sendHeartbeatPing(config))
  }

  /**
   * Record a thread whose turn ended in a usage/rate-limit reset so the
   * scheduler resumes it once the reset time passes. Every harness is tracked  
   * including harnesses that schedule their own provider retries (OpenCode): a
   * native resume emits `working` and clears the record, while the persisted
   * record keeps the wait alive (and re-runs the thread) across app restarts.
   * Internal/child sessions are skipped. Issues without a usable reset time are
   * retained for manual recovery rather than discarded.
   */
  async scheduleAutomaticRetry(sessionId: string, issue: AgentProviderIssue): Promise<boolean> {
    const scheduler = this.host.state.retryScheduler
    if (!scheduler) return false
    const info = this.host.sessionRegistry.get(sessionId)
    if (!info || info.ephemeral === true || this.host.state.childSessionOwners.has(sessionId))
      return false
    // An assistant task whose assistant carries fallback models moves onto the
    // next model and re-runs at once. The fallback exists so a failed model
    // never stops the assistant, so it is applied before any reset wait.
    if (
      issue.kind !== 'network' &&
      (await this.host.units['assistant-authoring'].tryAssistantModelFallback(
        info,
        sessionId,
        issue
      ))
    )
      return true
    // A provider with an explicit retry deadline has declared that the issue
    // is safe to retry later. Known reset-based issues may also derive their
    // deadline from account telemetry; everything else stays manual unless it
    // carries both retryable=true and retryAt.
    const canDeriveReset =
      issue.kind === 'quota' || issue.kind === 'rate_limit' || issue.kind === 'provider_unavailable'
    if (
      issue.kind !== 'network' &&
      !canDeriveReset &&
      !(issue.retryable && issue.retryAt !== undefined)
    ) {
      return false
    }
    const driver = this.host.units['turns-dispatch'].driverForRuntime(info.driverId, info.accountId)
    // A device connection failure outlives the driver it killed: that is
    // exactly what a Wi-Fi drop leaves behind, and refusing the record here is
    // what stranded the thread on an error card nothing was listening to. The
    // wait is the device's connectivity and the resume goes through the
    // thread's own settings like any other send, so no driver is needed to arm
    // it. Every other kind still needs its driver: both the reset time it
    // waits on and the resume come from it.
    if (!driver && issue.kind !== 'network') return false
    // Allow the failed turn to finish tearing down before admitting a continuation.
    let retryAt = issue.kind === 'network' ? Date.now() + 3_000 : issue.retryAt
    if (retryAt === undefined) {
      if (!driver) return false
      // Some harnesses surface a usage reset without attaching it to the error
      // (e.g. Codex reports windows via account/rateLimits/read, OpenCode Go via
      // its account endpoint)   ask the provider-scoped account telemetry for
      // the real reset window instead of waiting on the blind fallback cooldown.
      retryAt = await this.host.units['turns-dispatch'].deriveUsageResetRetryAt(info, driver)
    }
    const usageResetWait = isUsageResetWaitIssue(issue)
    if (retryAt === undefined && usageResetWait) {
      // A usage-reset wait with no derivable reset time (the provider gave no
      // parseable date, or gave one already in the past) must still get a
      // concrete timer   otherwise the card is stuck on "waiting" forever with
      // no date and no schedule. Retry after a fixed cooldown; if the provider
      // is still limited, the next failure re-tracks with a fresh cooldown.
      retryAt = Date.now() + USAGE_RESET_FALLBACK_RETRY_MS
    }
    const resetAt = retryAt
    if (retryAt !== undefined && issue.kind !== 'network') retryAt += RETRY_FIRE_GRACE_MS
    const hasRetryAt = typeof retryAt === 'number' && Number.isFinite(retryAt)
    if (!hasRetryAt && !usageResetWait) return false
    // A deliberate user stop is never overwritten by a new wait. This is the
    // re-arm path that survived the Stop click: the abort cleared the session
    // that was tracked, but the SAME failure re-reported under a successor
    // session would land here and silently revive the thread.
    if (await this.host.threadManager.wasStoppedByUser(info.projectId, info.threadId)) {
      Logger.info('Auto-retry refused: the user stopped this thread', {
        projectId: info.projectId,
        threadId: info.threadId,
        sessionId,
        issueKind: issue.kind
      })
      return false
    }
    await this.host.threadManager.setStatus(info.projectId, info.threadId, 'working-paused', {
      read: false
    })
    const tracked = await scheduler.track({
      sessionId,
      projectId: info.projectId,
      threadId: info.threadId,
      harnessId: issue.harnessId ?? info.driverId,
      ...(hasRetryAt ? { retryAt, resetAt } : {}),
      issueKind: issue.kind,
      issueMessage: issue.message,
      ...(issue.rawError === undefined ? {} : { rawError: issue.rawError }),
      ...(issue.attempt === undefined ? {} : { attempt: issue.attempt })
    })
    if (!tracked) {
      // track() refuses for a user-stopped thread (or a probe failure). Keep
      // the wait OFF the ledger and leave the thread on the visible warning
      // card; with auto-retry on this also marks the thread failed so it is
      // never silently revived. A manual Retry stays available.
      await this.host.threadManager.setStatus(info.projectId, info.threadId, 'failed', {
        read: false,
        error: issue.message,
        errorDetail: issue.rawError
      })
      return false
    }
    const current = this.host.sessionStatuses.get(sessionId)
    if (current?.state === 'waiting' || current?.state === 'error') {
      const status: AgentSessionStatus = {
        ...current,
        issue: { ...current.issue, retryAt: resetAt, autoResumeAt: retryAt }
      }
      this.host.sessionStatuses.set(sessionId, status)
      this.host.broadcast({ type: 'session.status', sessionId, status })
    }
    return true
  }

  /**
   * A provider failure the device itself explains.
   *
   * A turn that dies while the device has no connectivity did not fail because
   * of the provider, and it was not the provider's verdict that surfaced: it is
   * the connection. Harnesses report that loss in their own words (a process
   * exit, an empty stream, a transport reset inside a driver-specific string)
   * and most of those classify as `unknown`, which used to end the thread on a
   * terminal error card with nothing listening for the reconnection. Any
   * `unknown` failure landing inside the connection-loss window is therefore
   * re-read as the connection wait it is.
   *
   * Only `unknown` is re-read. A provider that stated a verdict (sign-in
   * required, billing, a usage window) keeps it: those need the user, not the
   * network, and masking them behind a connection card would hide the one
   * action that fixes them.
   */
  asConnectionWaitIssue(issue: AgentProviderIssue): AgentProviderIssue {
    const connectivity = this.host.state.connectivity
    if (!connectivity || issue.kind !== 'unknown') return issue
    if (!connectivity.isOffline() && !connectivity.wasOfflineWithin(CONNECTION_LOSS_GRACE_MS))
      return issue
    return {
      ...issue,
      kind: 'network',
      retryable: true,
      retryAt: undefined,
      message: CONNECTION_WAIT_MESSAGE
    }
  }

  /**
   * Re-surface a terminal usage/rate-limit outcome as the unified waiting card
   * with a retry time. Also schedules the auto-resume for every harness (native
   * retry harnesses included) so the wait survives an app restart, and routes
   * the failed-turn finalization (thread status, checkpoint, assignment reports)
   * through the same provider-failure path used for errors.
   */
  enterRetryWait(sessionId: string, issue: AgentProviderIssue, error?: string): void {
    if (issue.kind === 'network') {
      issue = {
        ...issue,
        retryable: true,
        retryAt: undefined,
        rawError: issue.rawError ?? error ?? issue.message,
        message: CONNECTION_WAIT_MESSAGE
      }
    }
    this.host.sessionStatuses.set(sessionId, { state: 'waiting', issue })
    updateRetryWakeWindow(sessionId, issue.retryAt ?? null)
    this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
    this.host.units['questions'].clearPendingQuestionsForSession(sessionId)
    this.host.units['permissions'].clearPendingPermissionsForSession(sessionId)
    this.host.broadcast({ type: 'session.status', sessionId, status: { state: 'waiting', issue } })
    void this.host.handleProviderFailure(sessionId, issue, error)
  }

  /**
   * Some harnesses (opencode observed in the wild) can report a usage-cap
   * notice as ordinary completed assistant text instead of a structured
   * session error, e.g. "5-hour usage limit reached. Resets in 1hr 53min."
   * That text never reaches classifyProviderIssue through the session.error
   * path, so the turn finishes as a plain idle completion and auto-resume
   * never schedules   the thread just looks silently stuck. Catch it here by
   * re-classifying the latest assistant message text right after idle.
   *
   * The text must structurally BE the notice (isUsageLimitNoticeText), not
   * merely mention limits: an ordinary agent answer that discusses usage
   * limits at length must never be classified as a limit notice, or the whole
   * agent output splashes into the usage-limit card as its error message.
   */
  async detectTextualUsageLimitWait(
    driverId: string,
    sessionId: string,
    info: SessionInfo
  ): Promise<void> {
    if (this.host.units['turns-dispatch'].isAutomaticRetryWaitActive(sessionId)) return
    if (this.host.sessionStatuses.get(sessionId)?.state === 'error') return
    const driver = this.host.units['turns-dispatch'].driverForRuntime(driverId, info.accountId)
    if (!driver) return
    const messages = await driver.loadMessages(info.projectPath, sessionId)
    const latest = messages.at(-1)
    if (latest?.role !== 'assistant' || latest.error) return
    const text = latest.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (!text || !isUsageLimitNoticeText(text)) return
    const kind = classifyProviderIssue(text)
    if (!isUsageResetWaitIssue({ kind, retryable: true })) return
    const retryAt = parseUsageResetAt(text)
    const issue: AgentProviderIssue = {
      kind,
      message: text,
      harnessId: driverId,
      retryable: true,
      ...(retryAt === undefined ? {} : { retryAt })
    }
    this.enterRetryWait(sessionId, issue, text)
  }

  /**
   * What other running turns hold in this project, split by evidence. `claimed`
   * are paths a precise file tool wrote (a real claim); `window` are paths a
   * shell command only watched move, which proves nothing about who wrote them;
   * `claimants` names the thread behind each path so a filtered card can say
   * who took it.
   */
  liveForeignClaimedPaths(
    self: SessionInfo,
    ownThreadIds?: ReadonlySet<string>,
    activeTurnThreadIds?: ReadonlySet<string>
  ): { claimed: Map<string, number>; window: Map<string, number>; claimants: Map<string, string> } {
    const claimed = new Map<string, number>()
    const window = new Map<string, number>()
    const claimants = new Map<string, string>()
    const now = Date.now()
    for (const other of this.host.sessionRegistry.values()) {
      if (other === self || other.projectId !== self.projectId) continue
      if (other.threadId === self.threadId) continue
      // Worker sub-agents of this thread are part of the same logical turn
      // their claimed paths belong to this turn's card.
      if (ownThreadIds?.has(other.threadId)) continue
      if (!other.activeTurnId) continue
      // The in-memory turn id can outlive the turn itself (another instance
      // settled the checkpoint, or the turn ended on a path that skipped the
      // session cleanup). A ghost session would then hold its paths forever and
      // strip them from every later turn's card, so require the durable row.
      if (activeTurnThreadIds && !activeTurnThreadIds.has(other.threadId)) continue
      for (const [path, claimedAt] of other.preciseChangedPaths ?? []) {
        const existing = claimed.get(path)
        if (existing === undefined || claimedAt < existing) {
          claimed.set(path, claimedAt)
          claimants.set(path, other.threadId)
        }
      }
      for (const path of other.changedPaths ?? []) {
        if (claimed.has(path) || window.has(path)) continue
        window.set(path, now)
        claimants.set(path, other.threadId)
      }
    }
    return { claimed, window, claimants }
  }

  /**
   * Recover an explicit provider issue for a silent session. Silence itself is
   * never promoted to an error: only the latest provider message may prove the
   * active turn failed. Older assistant errors belong to earlier turns and must
   * not poison a later, still-running turn.
   */
  async recoverWatchdogIssue(
    sessionId: string,
    info: SessionInfo
  ): Promise<AgentProviderIssue | null> {
    const harnessId = info.driverId
    const driver = this.host.units['turns-dispatch'].driverForRuntime(harnessId, info.accountId)
    try {
      if (driver) {
        const messages = await driver.loadMessages(info.projectPath, sessionId)
        const latest = messages.at(-1)
        const recovered = latest?.role === 'assistant' ? latest.error?.trim() : undefined
        if (recovered) {
          return {
            kind: classifyProviderIssue(recovered),
            message: recovered,
            rawError: recovered,
            harnessId,
            retryable: true
          }
        }
      }
    } catch {
      /* A failed health read is not proof that the active turn failed. */
    }

    // The persisted transcript only ever carries an error the provider itself
    // reported. A wedged RPC transport (the driver process alive but no
    // longer answering, e.g. pi's known RPC-wedge failure mode) never writes
    // anything   it just stops emitting events forever, and the check above
    // can never see it. For drivers that can report live process state,
    // actively probe the connection instead of extending the silence window
    // indefinitely on faith.
    if (driver?.isSessionBusy) {
      const probe = await probeSessionLiveness(driver, info, sessionId)
      if (probe === 'busy') return null
      // A quiet harness with a card on screen is the user's turn to move, not a
      // failure: extend instead of promoting the silence, so the engine never
      // tears a live harness out from under a card the user is still filling in.
      // A wedged transport is a real failure and still reports below.
      if (probe === 'idle' && this.host.units['turns-sessions'].sessionAwaitsUserInput(sessionId))
        return null
      const message =
        probe === 'wedged'
          ? `The ${harnessId} session stopped responding (its connection appears wedged).`
          : `The ${harnessId} session went idle without completing the turn.`
      return {
        kind: 'network',
        message,
        harnessId,
        retryable: true
      }
    }
    return null
  }

  updateCompletionWaiter(event: SessionAgentEvent): void {
    const waiter = this.host.state.completionWaiters.get(event.sessionId)
    if (!waiter) return
    if (event.type === 'message.part.updated' || event.type === 'message.part.delta') {
      waiter.active = true
      waiter.refresh()
      return
    }
    if (event.type === 'message.completed') {
      waiter.active = true
      if (event.structuredOutput !== undefined) {
        waiter.structuredOutput = event.structuredOutput
      }
      waiter.refresh()
      return
    }
    if (event.type === 'session.status' && event.status.state !== 'idle') {
      // Provider failures do not always arrive as `session.error`: some
      // harnesses (e.g. pi's `agent_settled`, usage/rate-limit windows) report
      // them as a terminal `error` status or a `waiting` usage-reset. Ignoring
      // those left auxiliary flows (image descriptor, titles, temporary chats)
      // hanging until the inactivity window expired. Fail them immediately
      // with the real provider message so recovery   the descriptor's fallback
      // model chain, or the user card   starts at once.
      const status = event.status
      if (status.state === 'error' || (status.state === 'waiting' && status.issue !== undefined)) {
        this.clearCompletionWaiter(event.sessionId)
        waiter.reject(new Error(status.issue?.message ?? 'Agent session failed'))
        return
      }
      waiter.active = true
      waiter.refresh()
      return
    }
    if (event.type === 'session.error') {
      this.clearCompletionWaiter(event.sessionId)
      waiter.reject(new Error(event.error ?? 'Agent session failed'))
      return
    }
    if (
      event.type === 'session.idle' ||
      (event.type === 'session.status' && event.status.state === 'idle')
    ) {
      this.clearCompletionWaiter(event.sessionId)
      if (waiter.active) {
        waiter.resolve(waiter.structuredOutput)
      } else {
        waiter.reject(new Error('Agent session ended without producing any output'))
      }
    }
  }

  clearCompletionWaiter(sessionId: string): void {
    const waiter = this.host.state.completionWaiters.get(sessionId)
    if (!waiter) return
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    this.host.state.completionWaiters.delete(sessionId)
  }

  rejectCompletionWaiter(sessionId: string, reason: string): void {
    const waiter = this.host.state.completionWaiters.get(sessionId)
    if (!waiter) return
    this.clearCompletionWaiter(sessionId)
    waiter.reject(new Error(reason))
  }
}
