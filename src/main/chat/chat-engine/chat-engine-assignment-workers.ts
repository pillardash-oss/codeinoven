import { join, resolve } from 'path'
import {
  isPawnWorkerThread,
  runningWorkers
} from '../thread-transfer-service/thread-transfer-workers'
import type { HandedOffWorker } from '../thread-transfer-service/thread-transfer-workers'
import { randomInt } from 'crypto'
import { Logger } from '../../system/logger'
import { PAWN_DEFAULT_THINKING_LEVEL } from '../../../lib/pawn-tools'
import { PAWN_AGENT_CONTRACT } from '../../../lib/agent-behavior'
import { AssignmentEngineError } from '../../../lib/engines/assignment-engine'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { broadcastThreadUpdate, updateRetryWakeWindow } from '../thread-events'
import { validateEntityId, validateThreadSettings } from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { AssignmentWorkerScopeProvisioner } from '../../../lib/engines/assignment-worker-scope'
import type { PawnToolContext } from '../../utilities/utility-orchestration-service'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentSessionStatus,
  AgentSubagentActivity,
  AgentToolStatus,
  UsageBearingMessage,
  AssignmentPlan,
  AssignmentTask,
  AssignmentToolResult,
  AssignmentTaskReport,
  AssignmentTaskReview,
  PromptAssignmentTaskReference,
  SessionAgentEvent,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { workerReportsToCoordinator } from '../../../lib/types'
import { classifyProviderIssue } from '../../../lib/provider-issue'
import { messageId as createMessageId } from '../../../lib/id'
import type {
  AssignmentApiCapability,
  AssignmentWorkerContext,
  AssignmentWorkerRoutingResult,
  ChildSessionInfo,
  SessionInfo
} from './chat-engine-types'
import { AssignmentApiRequestError, rawErrorDetail, rawErrorMessage } from './chat-engine-errors'
import {
  mergeAgentMessages,
  restoreMirrorAccount,
  restoreMirrorThinkingLevel,
  stampAccount,
  stampHarnessId
} from './chat-engine-message-merge'
import { ASSIGNMENT_WORKER_REPORT_DISABLED_INSTRUCTION } from './chat-engine-prompts'
import { projectRelativePath } from './chat-engine-changes'
import {
  coordinatorDirectWorkRequested,
  issueMatchesAssignmentFailure,
  preserveMirrorGenerationDurations,
  preserveMirrorReasoningStamps,
  preserveMirrorToolStamps
} from './chat-engine-pure'
import { ChatEngine, pawnModelOverride, pawnThinkingOverride } from '../chat-engine'

/** ChatEngine assignment-workers: one concern, moved verbatim from the composition root. */
export class ChatEngineAssignmentWorkers {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Tell the Assignment engine how to place a worker in a Git scope. The engine
   * is built before the IPC layer constructs the scope and worktree services, so
   * the provisioner is installed here rather than passed to its constructor.
   */
  setAssignmentWorkerScopeProvisioner(provisioner: AssignmentWorkerScopeProvisioner | null): void {
    this.host.state.assignmentEngine.setWorkerScopeProvisioner(provisioner)
  }

  /** Resolve and verify that a provider-native child belongs to the requested thread. */
  async resolveChildSessionOwner(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<ChildSessionInfo> {
    const tracked = this.host.state.childSessionOwners.get(sessionId)
    if (tracked) {
      if (tracked.projectId !== projectId || tracked.threadId !== threadId) {
        throw new Error('Sub-agent session does not belong to this thread')
      }
      return tracked
    }

    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)

    // A pawn agent's session belongs to its own thread, and the pawn's card in
    // the spawning conversation opens it by that session id. Resolve it here so
    // a reopen (where nothing is tracked in memory yet) still finds the pawn:
    // the thread must point back at the thread whose card opened it.
    const pawnThread = (await this.host.threadManager.listThreads(projectId)).find(
      (candidate) => candidate.sessionId === sessionId && candidate.coordinatorThreadId === threadId
    )
    if (pawnThread) {
      const pawnDriverId = pawnThread.settings?.harnessId ?? DEFAULT_HARNESS
      const { projectPath: pawnPath } = await this.host.resolve(
        projectId,
        pawnDriverId,
        pawnThread.id,
        pawnThread.sessionAccountId ?? pawnThread.settings?.accountId
      )
      const pawnOwner: ChildSessionInfo = {
        projectId,
        threadId: pawnThread.id,
        projectPath: pawnPath,
        driverId: pawnDriverId,
        accountId: pawnThread.sessionAccountId ?? pawnThread.settings?.accountId
      }
      this.host.state.childSessionOwners.set(sessionId, pawnOwner)
      return pawnOwner
    }

    const records = await this.host.threadManager.loadMessageRecords(projectId, threadId)
    const referencedByThread = records.some((message) =>
      [...message.parts, ...(message.transportParts ?? [])].some(
        (part) => part.type === 'subagent' && part.activity.childSessionId === sessionId
      )
    )
    if (!referencedByThread) {
      throw new Error('Sub-agent session does not belong to this thread')
    }

    // Child sessions belong to the harness that owns the parent session, which
    // after a mid-run harness switch is the thread's persisted owner rather
    // than the currently selected harness.
    const driverId =
      thread.sessionHarnessId ??
      (thread.sessionId ? this.host.sessionRegistry.get(thread.sessionId)?.driverId : undefined) ??
      thread.settings?.harnessId ??
      DEFAULT_HARNESS
    const accountId =
      thread.sessionAccountId ??
      (thread.sessionId ? this.host.sessionRegistry.get(thread.sessionId)?.accountId : undefined)
    const { projectPath } = await this.host.resolve(projectId, driverId, threadId, accountId)
    const owner: ChildSessionInfo = {
      projectId,
      threadId,
      projectPath,
      driverId,
      accountId,
      parentSessionId: thread.sessionId
    }
    this.host.state.childSessionOwners.set(sessionId, owner)
    return owner
  }

  /** Return retained lifecycle state for one verified child session. */
  async getChildSessionStatus(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentSessionStatus | null> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    sessionId = validateEntityId(sessionId, 'Session ID', 512)
    await this.resolveChildSessionOwner(projectId, threadId, sessionId)
    return this.host.sessionStatuses.get(sessionId) ?? null
  }

  /** Resume a failed child in its provider-native session and existing context. */
  async retryChildSession(projectId: string, threadId: string, sessionId: string): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    sessionId = validateEntityId(sessionId, 'Session ID', 512)
    const owner = await this.resolveChildSessionOwner(projectId, threadId, sessionId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.settings) throw new Error('Thread settings are unavailable')
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      owner.driverId,
      owner.accountId
    )
    if (!driver) throw new Error(`Harness driver is unavailable: ${owner.driverId}`)
    const messages = await this.host.threadManager.loadSubagentMessages(
      projectId,
      threadId,
      sessionId
    )
    const latestModelMessage = [...messages]
      .reverse()
      .find((message) => message.providerId && message.modelId)
    const settings = validateThreadSettings({
      ...thread.settings,
      providerId: latestModelMessage?.providerId ?? thread.settings.providerId,
      modelId: latestModelMessage?.modelId ?? thread.settings.modelId
    })

    this.host.state.userAbortedSessions.delete(sessionId)
    this.host.sessionStatuses.set(sessionId, { state: 'working' })
    // The worker is running again, so transcript loads must treat it as live
    // instead of reusing the terminal state the stop (or failure) left behind.
    this.host.state.childSessionActivityStatuses.set(sessionId, 'running')
    this.host.handledIdleSessions.delete(sessionId)
    this.host.broadcast({ type: 'session.status', sessionId, status: { state: 'working' } })
    try {
      await driver.sendPrompt(owner.projectPath, {
        sessionId,
        settings,
        text: 'Retry the interrupted work. Continue from the existing context and finish the delegated task.',
        attachments: [],
        userMessageId: createMessageId()
      })
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The sub-agent retry failed to start.'
      const issue: AgentProviderIssue = {
        kind: classifyProviderIssue(message),
        message,
        rawError: rawErrorDetail(error),
        harnessId: owner.driverId,
        retryable: true
      }
      this.host.sessionStatuses.set(sessionId, { state: 'error', issue })
      this.host.broadcast({ type: 'session.error', sessionId, error: message, issue })
      throw error
    }
  }

  /** Retry one failed Assignment worker without redirecting the action through its coordinator. */
  async retryAssignmentWorker(
    projectId: string,
    coordinatorThreadId: string,
    workerThreadId: string
  ): Promise<AssignmentPlan> {
    this.host.units['messages'].touchUserActivity()
    return this.retryAssignmentWorkerInternal(projectId, coordinatorThreadId, workerThreadId)
  }

  /**
   * Hand a not-reporting worker's finished work back to the Sr. Engineer.
   *
   * Reporting off is a private iteration loop the user drives, so nothing is
   * ever handed back on its own. This action is the user asking for the
   * hand-back now: it switches the worker's reporting back on, reactivates its
   * task, and prompts the worker to submit fresh evidence and report through the
   * Assignment API. That report is what wakes the Sr. Engineer's audit, so the
   * two cards settle into the ordinary review loop again.
   */
  async reportWorkerToCoordinator(
    projectId: string,
    coordinatorThreadId: string,
    workerThreadId: string
  ): Promise<AssignmentPlan> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    workerThreadId = validateEntityId(workerThreadId, 'Worker thread ID')
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!assignment) throw new AssignmentEngineError('not_found', 'Assignment not found')
    const task = assignment.content.tasks.find(
      (candidate) => candidate.owner === 'worker' && candidate.threadId === workerThreadId
    )
    if (!task) throw new AssignmentEngineError('not_found', 'Assignment worker task not found')
    const worker = await this.host.threadManager.getThread(projectId, workerThreadId)
    if (
      !worker?.settings ||
      worker.assignmentId !== assignment.id ||
      worker.assignmentRole !== 'worker' ||
      worker.coordinatorThreadId !== coordinatorThreadId
    ) {
      throw new AssignmentEngineError('not_found', 'Assignment worker thread not found')
    }
    if (assignment.status === 'stopped') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'A stopped Assignment cannot take a worker report'
      )
    }
    // Switch reporting on before anything else: the reactivation and the report
    // contract both read it, and the worker's own composer control must agree.
    const settings = validateThreadSettings({ ...worker.settings, reportToCoordinator: true })
    await this.host.threadManager.updateSettings(projectId, workerThreadId, settings)
    const reactivated = await this.host.state.assignmentEngine.markWorkerSteered(
      assignment.id,
      workerThreadId
    )
    await this.host.units['assignment-run'].ensureAssignmentApi()
    const reportInstruction = this.workerReportInstruction({
      assignmentId: assignment.id,
      threadId: worker.id,
      taskId: task.id,
      settings,
      completion: 'When your verification is current'
    })
    await this.host.sendPrompt(
      projectId,
      workerThreadId,
      settings,
      [
        'Reporting to the Sr. Engineer is switched back on for this thread.',
        `Submit baseline and check evidence for your task “${task.title}” and report it through the Assignment API so the Sr. Engineer can audit it and give feedback.`,
        reportInstruction
      ].join('\n\n'),
      [],
      undefined,
      createMessageId(),
      undefined,
      undefined,
      undefined,
      'internal',
      { action: `Report to Sr. Engineer · ${task.workerName ?? worker.title}`.slice(0, 120) }
    )
    const refreshedWorker = await this.host.threadManager.getThread(projectId, workerThreadId)
    if (refreshedWorker) broadcastThreadUpdate(refreshedWorker)
    return reactivated
  }

  async retryAssignmentWorkerInternal(
    projectId: string,
    coordinatorThreadId: string,
    workerThreadId: string
  ): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    workerThreadId = validateEntityId(workerThreadId, 'Worker thread ID')
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!assignment) throw new AssignmentEngineError('not_found', 'Assignment not found')
    const task = assignment.content.tasks.find(
      (candidate) => candidate.owner === 'worker' && candidate.threadId === workerThreadId
    )
    if (!task) throw new AssignmentEngineError('not_found', 'Assignment worker task not found')
    if (task.status !== 'attention' || task.report?.status !== 'failed') {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Worker task ${task.id} does not have a retryable harness failure`
      )
    }
    const worker = await this.host.threadManager.getThread(projectId, workerThreadId)
    if (
      !worker?.settings ||
      worker.assignmentId !== assignment.id ||
      worker.assignmentRole !== 'worker' ||
      worker.coordinatorThreadId !== coordinatorThreadId
    ) {
      throw new AssignmentEngineError('not_found', 'Assignment worker thread not found')
    }

    const failureSummary = task.report.summary
    await this.host.sendPrompt(
      projectId,
      workerThreadId,
      worker.settings,
      [
        `Retry Assignment task “${task.title}” after the provider interruption.`,
        'Continue from the existing durable worker context, preserve completed work, finish the task, and submit the required Assignment report.'
      ].join(' '),
      [],
      undefined,
      createMessageId(),
      undefined,
      undefined,
      undefined,
      'internal',
      { action: `Retry worker · ${task.workerName ?? worker.title}`.slice(0, 120) }
    )
    const updated = await this.host.state.assignmentEngine.markWorkerSteered(
      assignment.id,
      workerThreadId
    )
    const refreshedWorker = await this.host.threadManager.getThread(projectId, workerThreadId)
    if (refreshedWorker) broadcastThreadUpdate(refreshedWorker)

    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    const coordinatorStatus = coordinator?.sessionId
      ? this.host.sessionStatuses.get(coordinator.sessionId)
      : undefined
    if (
      coordinator?.sessionId &&
      coordinatorStatus?.state === 'error' &&
      issueMatchesAssignmentFailure(coordinatorStatus.issue, failureSummary)
    ) {
      await this.host.dismissSessionError(projectId, coordinatorThreadId, coordinator.sessionId)
    }
    return updated
  }

  /** Stop only the selected child without cancelling its parent thread. */
  async abortChildSession(projectId: string, threadId: string, sessionId: string): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    sessionId = validateEntityId(sessionId, 'Session ID', 512)
    const owner = await this.resolveChildSessionOwner(projectId, threadId, sessionId)
    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      owner.driverId,
      owner.accountId
    )
    if (!driver) throw new Error(`Harness driver is unavailable: ${owner.driverId}`)
    // The thread that owns the child is the one whose stop state this belongs
    // to: for a nested sub-agent that is the parent, for a pawn its own thread.
    await this.host.threadManager.markStoppedByUser(owner.projectId, owner.threadId)
    this.host.state.userAbortedSessions.add(sessionId)
    if (owner.parentSessionId && driver.abortSubagent) {
      // The harness keeps this worker inside its parent's process, so aborting
      // the child id alone would silently do nothing.
      await driver.abortSubagent(owner.projectPath, owner.parentSessionId, sessionId)
    } else {
      await driver.abort(owner.projectPath, sessionId)
    }
    this.host.state.childSessionActivityStatuses.set(sessionId, 'aborted')
    this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
    this.host.sessionStatuses.set(sessionId, { state: 'idle' })
    this.host.broadcast({ type: 'session.status', sessionId, status: { state: 'idle' } })
  }

  captureChildSession(
    owner: ChildSessionInfo,
    sessionId: string,
    resolvedDriver?: HarnessDriver,
    options?: { waitForFlush?: boolean }
  ): Promise<AgentMessage[]> {
    const captureKey = `${owner.projectId}:${owner.threadId}:${sessionId}`
    const existing = this.host.state.childCaptureTasks.get(captureKey)
    if (existing) return existing

    const capture = (async (): Promise<AgentMessage[]> => {
      const driver =
        resolvedDriver ??
        this.host.units['turns-dispatch'].driverForRuntime(owner.driverId, owner.accountId)
      if (!driver) {
        throw new Error(`Unknown harness: ${owner.driverId}`)
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      const waitForFlush = options?.waitForFlush ?? true
      const load = (): Promise<AgentMessage[]> =>
        driver.loadSubagentMessages
          ? driver.loadSubagentMessages(owner.projectPath, sessionId, { waitForFlush })
          : driver.loadMessages(owner.projectPath, sessionId)
      try {
        const account = await this.host.state.accountRegistry.resolve(
          owner.driverId,
          owner.accountId
        )
        const incoming = stampAccount(
          stampHarnessId(
            await Promise.race([
              load(),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () =>
                    reject(
                      new Error('The provider took too long to load the sub-agent transcript')
                    ),
                  // The driver's own file watch (~10 s) stays within this
                  // race for live children; settled children resolve fast.
                  15_000
                )
              })
            ]),
            owner.driverId
          ),
          account.id,
          account.label
        )
        this.host.units['misc'].applyReasoningStamps(sessionId, incoming)
        this.host.units['utilities-tools'].applyToolStamps(sessionId, incoming)
        this.host.units['misc'].applyGenerationStamps(sessionId, incoming)
        const cached = await this.host.threadManager.loadSubagentMessages(
          owner.projectId,
          owner.threadId,
          sessionId
        )
        preserveMirrorReasoningStamps(cached, incoming)
        preserveMirrorToolStamps(cached, incoming)
        preserveMirrorGenerationDurations(cached, incoming)
        const merged = restoreMirrorAccount(
          restoreMirrorThinkingLevel(mergeAgentMessages(cached, incoming), cached),
          cached
        )
        if (merged.length === 0 && !waitForFlush) {
          // The child session is finished and the harness holds no native
          // transcript for it (pi never persists child sessions on disk), but
          // the spawn tool call on the parent thread still carries the
          // prompt and captured output. Synthesize the transcript from it AND
          // persist it, so every later open is a single DB read instead of
          // re-probing the harness.
          const fallback = await this.subagentMessagesFromParentActivity(owner, sessionId)
          if (fallback.length > 0) {
            await this.host.threadManager.saveSubagentMessages(
              owner.projectId,
              owner.threadId,
              sessionId,
              fallback
            )
          }
          return fallback
        }
        if (merged.length > 0) {
          await this.host.threadManager.saveSubagentMessages(
            owner.projectId,
            owner.threadId,
            sessionId,
            merged
          )
          // Account the worker's turns the moment its transcript lands, so a
          // worker that finishes after its parent turn ended is still recorded
          // instead of waiting for another turn of the thread.
          await this.recordSubagentTurnUsage(
            owner.projectId,
            owner.threadId,
            this.subagentTurnKey(owner, sessionId),
            merged
          ).catch((error: unknown) => Logger.dev('Sub-agent usage recording failed:', error))
        }
        return merged
      } catch (error) {
        // pi child sessions (cio_spawn_agent) are never persisted as CLI
        // session records, so their transcript load can legitimately fail.
        // Never rethrow: fall back to the spawn tool's own transcript, which
        // the parent thread's message parts already carry (prompt + captured
        // output), and persist it so later opens hit the mirror instantly.
        Logger.dev('Sub-agent transcript capture fell back to parent activity:', error)
        const fallback = await this.subagentMessagesFromParentActivity(owner, sessionId)
        if (fallback.length > 0) {
          try {
            await this.host.threadManager.saveSubagentMessages(
              owner.projectId,
              owner.threadId,
              sessionId,
              fallback
            )
          } catch (persistError) {
            Logger.dev('Sub-agent fallback transcript persist failed:', persistError)
          }
        }
        return fallback
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    })()

    this.host.state.childCaptureTasks.set(captureKey, capture)
    const clearCapture = (): void => {
      if (this.host.state.childCaptureTasks.get(captureKey) === capture) {
        this.host.state.childCaptureTasks.delete(captureKey)
      }
    }
    void capture.then(clearCapture, clearCapture)
    return capture
  }

  /**
   * Build a best-effort transcript from the spawn tool call stored on the
   * parent thread: the input carries the prompt, the tool result carries the
   * sub-agent's final output. Used when the driver cannot load the child
   * session natively (pi never persists child sessions).
   */
  async subagentMessagesFromParentActivity(
    owner: ChildSessionInfo,
    sessionId: string
  ): Promise<AgentMessage[]> {
    try {
      const records = await this.host.threadManager.loadMessageRecords(
        owner.projectId,
        owner.threadId
      )
      const parts = records.flatMap((message) => [
        ...message.parts,
        ...(message.transportParts ?? [])
      ])
      const part = parts.find(
        (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
          candidate.type === 'subagent' && candidate.activity.childSessionId === sessionId
      )
      if (!part) return []
      const now = Date.now()
      const prompt = part.activity.prompt
      const output = part.activity.output
      const error = part.activity.error
      if (!prompt && !output && !error) return []
      const messages: AgentMessage[] = []
      if (prompt) {
        messages.push({
          id: `${sessionId}:fallback-prompt`,
          role: 'user',
          visibility: 'subagent_trace',
          parts: [
            {
              type: 'text',
              id: `${sessionId}:fallback-prompt-text`,
              messageID: `${sessionId}:fallback-prompt`,
              text: prompt
            }
          ],
          createdAt: part.activity.time?.start ?? now
        })
      }
      if (output || error) {
        const outputText = error
          ? `${output ? `${output}\n\n` : ''}Sub-agent error: ${error}`
          : (output ?? '')
        messages.push({
          id: `${sessionId}:fallback-output`,
          role: 'assistant',
          visibility: 'subagent_trace',
          parts: [
            {
              type: 'text',
              id: `${sessionId}:fallback-output-text`,
              messageID: `${sessionId}:fallback-output`,
              text: outputText
            }
          ],
          createdAt: part.activity.time?.start ?? now,
          completedAt: part.activity.time?.end ?? now
        })
      }
      return messages
    } catch (error) {
      Logger.dev('Sub-agent parent-activity fallback failed:', error)
      return []
    }
  }

  async captureCompletedChildSession(owner: ChildSessionInfo, sessionId: string): Promise<void> {
    const captureKey = `${owner.projectId}:${owner.threadId}:${sessionId}`
    const inFlight = this.host.state.childCaptureTasks.get(captureKey)
    if (inFlight) {
      try {
        await inFlight
      } catch {
        // A terminal event gets one fresh attempt even if the earlier snapshot failed.
      }
    }
    await this.captureChildSession(owner, sessionId)
  }

  /**
   * A genuinely working worker owns its task again. `attention` with a failed
   * report is the original recovery case; a `completed` task is the same
   * situation after a successful run, and once a user prompts the finished
   * worker the run is new work: the task must read `running` so the coordinator
   * panel reflects it and so the worker can report its fresh evidence. The
   * mid-review states (`reported`, `auditing`, `rework`) stay untouched because
   * the coordinator owns those transitions while the report is being reviewed.
   */
  workerTaskNeedsReactivation(task: AssignmentTask): boolean {
    return task.status === 'attention' || task.status === 'completed' || task.status === 'failed'
  }

  /**
   * A user prompt to a worker whose Assignment task had already finished is new
   * work, and live-provider reconciliation reactivates that task a moment later.
   * The worker's capability, however, is revoked when its Assignment completes,
   * so the reactivated turn carries the API contract that lets the worker submit
   * fresh evidence and report the task back to the coordinator. A worker whose
   * capability is still live already has that contract from its dispatch prompt,
   * so nothing is injected and the turn stays a clean user message.
   */
  async workerAssignmentTurnDirective(thread: Thread | null): Promise<string> {
    if (thread?.assignmentRole !== 'worker' || !thread.assignmentId || !thread.assignmentTaskId) {
      return ''
    }
    const assignment = this.host.state.assignmentEngine.listVersions(thread.assignmentId).at(-1)
    const task = assignment?.content.tasks.find(
      (candidate) => candidate.id === thread.assignmentTaskId
    )
    if (!assignment || assignment.status === 'stopped' || !task || task.threadId !== thread.id) {
      return ''
    }
    // Reporting is switched off for this thread, so the worker must never hand
    // its task back. That is a standing rule for the thread rather than a
    // one-off, so every turn carries it   not only the turn that reactivates.
    if (!workerReportsToCoordinator(thread.settings)) {
      return ASSIGNMENT_WORKER_REPORT_DISABLED_INSTRUCTION
    }
    if (!this.workerTaskNeedsReactivation(task)) return ''
    await this.host.units['assignment-run'].ensureAssignmentApi()
    if (this.hasWorkerApiCapability(assignment.id, thread.id, task.id)) return ''
    return [
      `Your Assignment task “${task.title}” is active again. Continue within its existing scope and preserve unrelated concurrent work.`,
      this.workerReportInstruction({
        assignmentId: assignment.id,
        threadId: thread.id,
        taskId: task.id,
        settings: thread.settings,
        completion: 'When this update is complete'
      })
    ].join('\n\n')
  }

  /**
   * The reporting contract every worker prompt carries. A reporting thread gets
   * the Assignment API contract and the report-task instruction; a thread whose
   * reporting the user switched off gets the explicit instruction to finish in
   * the conversation instead, and no capability is minted for it.
   */
  workerReportInstruction(input: {
    assignmentId: string
    threadId: string
    taskId: string
    settings: ThreadSettings | undefined
    /** The clause that introduces the report-task call, e.g. `When the work is complete`. */
    completion: string
  }): string {
    if (!workerReportsToCoordinator(input.settings)) {
      return ASSIGNMENT_WORKER_REPORT_DISABLED_INSTRUCTION
    }
    const workerToken = this.host.units['assignment-run'].assignmentApiCapability({
      role: 'worker',
      assignmentId: input.assignmentId,
      threadId: input.threadId,
      taskId: input.taskId
    })
    return [
      this.host.units['assignment-run'].assignmentApiInstructions(workerToken, 'worker'),
      `Submit baseline evidence before changing files and check evidence after verification, using a unique operationId for each submission. ${input.completion}, POST report-task with assignmentId ${input.assignmentId}, taskId ${input.taskId}, and workerThreadId ${input.threadId}.`
    ].join('\n\n')
  }

  /** Whether a live worker capability already covers this Assignment task. */
  hasWorkerApiCapability(assignmentId: string, threadId: string, taskId: string): boolean {
    for (const capability of this.host.state.assignmentApiCapabilities.values()) {
      if (
        capability.role === 'worker' &&
        capability.assignmentId === assignmentId &&
        capability.threadId === threadId &&
        capability.taskId === taskId
      ) {
        return true
      }
    }
    return false
  }

  /**
   * The workers a thread still has running, read from its persisted cards.
   *
   * A sub-agent runs as a nested session inside this process, so it cannot
   * follow the thread across instances; the roster is what lets the resumed
   * agent re-spawn it instead of reading its own trace back as a pile of
   * failures.
   */
  async runningWorkersOf(projectId: string, threadId: string): Promise<HandedOffWorker[]> {
    try {
      const records = await this.host.threadManager.loadMessageRecords(projectId, threadId)
      return runningWorkers(records)
    } catch (error) {
      Logger.dev('Transferred-thread worker roster read failed:', {
        projectId,
        threadId,
        error: rawErrorMessage(error)
      })
      return []
    }
  }

  /** The pawn threads `spawnerThreadId` owns, whose runs this process holds. */
  async runningPawnThreads(projectId: string, spawnerThreadId: string): Promise<Thread[]> {
    const running: Thread[] = []
    for (const pawn of await this.pawnThreadsOf(projectId, spawnerThreadId)) {
      const ownerPid = await this.host.checkpointManager.activeTurnOwnerPid(projectId, pawn.id)
      if (ownerPid === process.pid) running.push(pawn)
    }
    return running
  }

  /** The pawn threads one thread spawned, whoever is running them. */
  async pawnThreadsOf(projectId: string, spawnerThreadId: string): Promise<Thread[]> {
    try {
      const threads = await this.host.threadManager.listThreads(projectId)
      return threads.filter((candidate) => isPawnWorkerThread(candidate, spawnerThreadId))
    } catch (error) {
      Logger.dev('Transferred-thread pawn lookup failed:', {
        projectId,
        spawnerThreadId,
        error: rawErrorMessage(error)
      })
      return []
    }
  }

  /**
   * Restart the pawn threads a release handed over.
   *
   * A pawn runs on a thread of its own, so a hand-off really does move it: the
   * departing instance stopped its run, and this instance continues the same
   * persisted session. Only the threads the release names are resumed, because a
   * pawn that had already finished must not be handed a fresh turn.
   */
  async resumeTransferredPawns(
    projectId: string,
    threadId: string,
    pawnThreadIds: readonly string[]
  ): Promise<void> {
    if (pawnThreadIds.length === 0) return
    for (const pawn of await this.pawnThreadsOf(projectId, threadId)) {
      if (!pawnThreadIds.includes(pawn.id)) continue
      try {
        await this.host.units['thread-lifecycle'].resumeThreadFromPersistedSession(pawn, {
          force: true,
          allowAgentOwnedThread: true
        })
      } catch (error) {
        // A pawn that will not resume must not fail the transfer: the primary is
        // already running here, and the pawn's thread is still open for the user.
        Logger.error('A transferred pawn agent could not be resumed:', {
          projectId,
          pawnThreadId: pawn.id,
          error: rawErrorMessage(error)
        })
      }
    }
  }

  /**
   * Stop every delegated worker session owned by one thread.
   *
   * A sub-agent runs as its own session (pi keeps them nested inside its own
   * process), so stopping the thread's own session leaves the workers running:
   * they keep editing files, their cards keep spinning, and a finishing worker
   * can even wake the stopped thread with its completion notification. A user
   * stop therefore addresses the children too   the same sweep the Assignment
   * stop path already performs.
   */
  async stopThreadChildSessions(projectId: string, threadId: string): Promise<void> {
    const children = [...this.host.state.childSessionOwners.entries()].filter(
      ([, owner]) => owner.projectId === projectId && owner.threadId === threadId
    )
    if (children.length === 0) return
    await Promise.allSettled(
      children.map(async ([childSessionId, owner]) => {
        this.host.state.userAbortedSessions.add(childSessionId)
        this.host.state.activeCompactions.delete(childSessionId)
        this.host.units['runtime-connectivity'].rejectCompletionWaiter(
          childSessionId,
          'Agent run stopped by user'
        )
        const driver = this.host.units['turns-dispatch'].driverForRuntime(
          owner.driverId,
          owner.accountId
        )
        try {
          if (driver && owner.parentSessionId && driver.abortSubagent) {
            await driver.abortSubagent(owner.projectPath, owner.parentSessionId, childSessionId)
          } else if (driver && this.host.sessionStatuses.get(childSessionId)?.state === 'working') {
            await driver.abort(owner.projectPath, childSessionId)
          }
        } catch (error) {
          Logger.dev('Sub-agent stop was incomplete:', error)
        } finally {
          await this.host.units['utilities'].cleanupTurnUtilities(childSessionId)
          this.host.state.retryScheduler?.clear(childSessionId)
          updateRetryWakeWindow(childSessionId, null)
          this.host.units['turns-sessions'].clearSessionWatchdog(childSessionId)
          this.host.units['questions'].clearPendingQuestionsForSession(childSessionId)
          this.host.units['permissions'].clearPendingPermissionsForSession(childSessionId)
          this.host.state.childSessionActivityStatuses.set(childSessionId, 'aborted')
          this.host.sessionStatuses.set(childSessionId, { state: 'idle' })
          this.host.broadcast({
            type: 'session.status',
            sessionId: childSessionId,
            status: { state: 'idle' }
          })
        }
      })
    )
  }

  async reconcileUnavailableAssignmentWorkers(assignment: AssignmentPlan): Promise<AssignmentPlan> {
    let current = assignment
    const runningWorkers = assignment.content.tasks.filter(
      (task) => task.owner === 'worker' && task.status === 'running' && task.threadId
    )
    for (const task of runningWorkers) {
      const workerThreadId = task.threadId
      if (!workerThreadId) continue
      const worker = await this.host.threadManager.getThread(assignment.projectId, workerThreadId)
      if (
        worker &&
        (worker.status === 'created' ||
          worker.status === 'planning' ||
          worker.status === 'executing')
      ) {
        continue
      }
      current = await this.host.state.assignmentEngine.stopWorker(current.id, workerThreadId)
      Logger.info('Recovered unavailable Assignment worker for automatic re-dispatch', {
        assignmentId: current.id,
        taskId: task.id,
        workerThreadId,
        workerStatus: worker?.status ?? 'missing'
      })
    }
    return current
  }

  async routeTaggedAssignmentWorkers(
    thread: Thread | null,
    origin: 'user' | 'internal',
    instruction: string,
    references: PromptAssignmentTaskReference[] | undefined
  ): Promise<AssignmentWorkerRoutingResult> {
    if (
      origin !== 'user' ||
      thread?.assignmentRole !== 'coordinator' ||
      !thread.assignmentId ||
      references === undefined ||
      references.length === 0
    ) {
      return { directCoordinatorTasks: [], routed: [] }
    }
    if (!Array.isArray(references) || references.length > 20) {
      throw new TypeError('Assignment task references must be an array of at most 20 tasks')
    }
    const assignment = this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)
    if (!assignment || assignment.id !== thread.assignmentId || assignment.status === 'completed') {
      throw new Error('The active Assignment is unavailable for task routing')
    }
    const routed: AssignmentWorkerContext[] = []
    const directCoordinatorTasks: AssignmentTask[] = []
    const routedThreadIds = new Set<string>()
    for (const reference of references) {
      if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
        throw new TypeError('Assignment task reference must be an object')
      }
      const assignmentId = validateEntityId(reference.assignmentId, 'Assignment ID')
      const taskId = validateEntityId(reference.taskId, 'Assignment task ID')
      if (assignmentId !== assignment.id) {
        throw new Error('Tagged task does not belong to the active Assignment')
      }
      const task = assignment.content.tasks.find((candidate) => candidate.id === taskId)
      if (!task) throw new Error(`Tagged Assignment task was not found: ${taskId}`)
      if (coordinatorDirectWorkRequested(instruction, task.id)) {
        directCoordinatorTasks.push(task)
        continue
      }
      if (task.owner !== 'worker' || !task.threadId || routedThreadIds.has(task.threadId)) continue
      const context = await this.requireAssignmentWorker(assignment.id, task.threadId)
      routedThreadIds.add(task.threadId)
      routed.push(context)
    }
    for (const context of routed) {
      await this.host.units['assignment-run'].withAssignmentApiLock(context.assignment.id, () =>
        this.steerAssignmentWorker(context, instruction)
      )
    }
    return { directCoordinatorTasks, routed }
  }

  async dispatchAssignmentWorker(
    result: AssignmentToolResult,
    reworkReview?: AssignmentTaskReview
  ): Promise<void> {
    if (result.task?.owner !== 'worker' || !result.thread?.settings) return
    const coordinator = await this.host.threadManager.getThread(
      result.assignment.projectId,
      result.assignment.coordinatorThreadId
    )
    const featureSlug = coordinator?.featureSlug ?? 'feature'
    const reportInstruction = this.workerReportInstruction({
      assignmentId: result.assignment.id,
      threadId: result.thread.id,
      taskId: result.task.id,
      settings: result.thread.settings,
      completion: 'When the work is complete'
    })
    await this.host.sendPrompt(
      result.assignment.projectId,
      result.thread.id,
      result.thread.settings,
      [
        this.host.state.assignmentEngine.workerPrompt(result.assignment, result.task, featureSlug),
        ...(reworkReview
          ? [
              '## Sr. Engineer rework review',
              'Correct the existing approved task directly. Address every failed checklist item and the review notes below, then submit fresh baseline/check evidence and report the task again. No new user sign-off is required.',
              JSON.stringify(
                {
                  checklistResults: reworkReview.checklistResults,
                  notes: reworkReview.notes,
                  reviewedAt: reworkReview.reviewedAt
                },
                null,
                2
              )
            ]
          : []),
        reportInstruction
      ].join('\n\n'),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      undefined,
      undefined,
      // The task that starts a worker is the first user turn of its thread, not
      // an invisible orchestration prompt.
      true
    )
  }

  async requireAssignmentWorker(
    assignmentId: string,
    workerThreadId: string
  ): Promise<AssignmentWorkerContext> {
    const assignment = this.host.state.assignmentEngine.listVersions(assignmentId).at(-1)
    if (!assignment) throw new AssignmentApiRequestError(404, 'Assignment not found')
    const task = assignment.content.tasks.find(
      (candidate) => candidate.owner === 'worker' && candidate.threadId === workerThreadId
    )
    if (!task) {
      throw new AssignmentApiRequestError(403, 'Worker does not belong to this Assignment')
    }
    const worker = await this.host.threadManager.getThread(assignment.projectId, workerThreadId)
    if (!worker || worker.assignmentId !== assignmentId || worker.assignmentRole !== 'worker') {
      throw new AssignmentApiRequestError(404, 'Assignment worker thread not found')
    }
    return { assignment, task, worker }
  }

  async steerAssignmentWorker(
    context: AssignmentWorkerContext,
    instruction: string
  ): Promise<AssignmentPlan> {
    const { assignment, task, worker } = context
    if (!worker.settings) throw new Error('Worker settings are missing')
    await this.host.units['assignment-run'].ensureAssignmentApi()
    const reportInstruction = this.workerReportInstruction({
      assignmentId: assignment.id,
      threadId: worker.id,
      taskId: task.id,
      settings: worker.settings,
      completion: 'When this update is complete'
    })
    await this.host.sendPrompt(
      worker.projectId,
      worker.id,
      worker.settings,
      [
        `The Sr. Engineer forwarded an update for your assigned task “${task.title}”.`,
        'Apply the user’s instruction within your existing task scope. Preserve unrelated concurrent work and verify your changes before reporting.',
        'User instruction:',
        instruction,
        reportInstruction
      ].join('\n\n'),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      {
        action: `Update from Sr. Engineer · ${task.workerName ?? worker.title}`.slice(0, 120),
        body: instruction.slice(0, 20_000)
      }
    )
    return this.host.state.assignmentEngine.markWorkerSteered(assignment.id, worker.id)
  }

  async notifyCoordinatorOfUnreportedWorkerCompletion(
    worker: Thread,
    sessionId: string,
    turnCompletedAt: number | undefined
  ): Promise<void> {
    if (
      worker.assignmentRole !== 'worker' ||
      !worker.assignmentId ||
      !worker.assignmentTaskId ||
      !worker.coordinatorThreadId
    ) {
      return
    }
    // A worker whose reporting the user switched off is expected to end its turns
    // without a report, so there is nothing to hand back here. Attempting one
    // anyway would be refused by the engine and logged as an error every turn.
    if (!workerReportsToCoordinator(worker.settings)) return
    const assignment = this.host.state.assignmentEngine.getActive(
      worker.projectId,
      worker.coordinatorThreadId
    )
    const task = assignment?.content.tasks.find(
      (candidate) => candidate.id === worker.assignmentTaskId
    )
    if (
      !assignment ||
      assignment.id !== worker.assignmentId ||
      task?.status !== 'running' ||
      task.threadId !== worker.id
    ) {
      return
    }
    if (task.report && (!task.startedAt || task.report.reportedAt >= task.startedAt)) return
    if (task.startedAt && turnCompletedAt && task.startedAt > turnCompletedAt) return
    const report: AssignmentTaskReport = {
      status: 'blocked',
      summary: 'The worker turn ended without submitting its deterministic task report.',
      evidence: [
        `Worker thread ${worker.id} became idle while Assignment task ${task.id} was still running.`
      ],
      reportedAt: Date.now()
    }
    const result = await this.host.state.assignmentEngine.reportTask(
      assignment.id,
      task.id,
      worker.id,
      report,
      `worker-unreported-idle-${sessionId}`
    )
    if (!result.idempotent) {
      await this.host.units['audit'].promptCoordinatorForAudit(result.assignment, task.id, report)
    }
  }

  assignmentWorkerCapabilityIsCurrent(capability: AssignmentApiCapability): boolean {
    if (capability.role !== 'worker' || !capability.taskId) return false
    const assignment = this.host.state.assignmentEngine.listVersions(capability.assignmentId).at(-1)
    return (
      assignment?.status !== 'stopped' &&
      assignment?.content.tasks.some(
        (task) => task.id === capability.taskId && task.threadId === capability.threadId
      ) === true
    )
  }

  revokeAssignmentWorkerCapabilities(assignmentId: string, threadId: string): void {
    for (const [token, capability] of this.host.state.assignmentApiCapabilities) {
      if (capability.assignmentId === assignmentId && capability.threadId === threadId) {
        this.host.state.assignmentApiCapabilities.delete(token)
      }
    }
    this.host.state.assignmentEngine.removeApiCapabilitiesForThread(assignmentId, threadId)
  }

  revokeAllAssignmentWorkerCapabilities(assignmentId: string): void {
    for (const [token, capability] of this.host.state.assignmentApiCapabilities) {
      if (capability.assignmentId === assignmentId && capability.role === 'worker') {
        this.host.state.assignmentApiCapabilities.delete(token)
      }
    }
    this.host.state.assignmentEngine.removeWorkerApiCapabilitiesForAssignment(assignmentId)
  }

  async retireOrphanedAssignmentWorker(capability: AssignmentApiCapability): Promise<void> {
    if (capability.role !== 'worker') return
    const assignment = this.host.state.assignmentEngine.listVersions(capability.assignmentId).at(-1)
    if (
      !assignment ||
      assignment.content.tasks.some((task) => task.threadId === capability.threadId)
    ) {
      return
    }
    const worker = await this.host.threadManager.getThread(
      assignment.projectId,
      capability.threadId
    )
    if (!worker || worker.assignmentId !== assignment.id || worker.assignmentRole !== 'worker')
      return
    if (worker.status === 'planning' || worker.status === 'executing') {
      await this.host.abort(worker.projectId, worker.id)
    }
    await this.host.threadManager.unlinkAssignmentThread(worker.projectId, worker.id)
  }

  /**
   * Run one engineering artifact tool for the turn that asked for it.
   *
   * Each artifact is created through the same machinery the Studio buttons use:
   * an isolated generation session that persists a reviewable draft and
   * broadcasts the matching `ready` event. Nothing is approved, implemented or
   * signed off on the user's behalf, so the existing review surface keeps owning
   * that decision. A request that cannot produce the artifact throws with a
   * plain reason the agent can relay or act on.
   */
  /**
   * Publish a pawn agent's activity onto the thread that spawned it.
   *
   * A pawn is a real thread, so its own transcript lives on that thread; the
   * spawning conversation gets the same card a nested sub-agent gets, carrying
   * the prompt the agent gave, the pawn's own session id (which its transcript
   * view loads) and, when it settles, its final report. The part is written to
   * the thread as a working-trace message and broadcast, so it survives a reopen
   * and updates live, exactly like a sub-agent part the harness streamed.
   */
  async publishPawnActivity(
    projectId: string,
    spawnerThreadId: string,
    spawnerSessionId: string,
    activity: AgentSubagentActivity
  ): Promise<void> {
    const part: Extract<AgentPart, { type: 'subagent' }> = {
      type: 'subagent',
      id: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      messageID: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      callID: `pawn:${projectId}:${activity.childSessionId ?? spawnerThreadId}`,
      activity
    }
    await this.host.threadManager
      .upsertMessages(projectId, spawnerThreadId, [
        {
          id: part.messageID,
          role: 'assistant',
          origin: 'subagent',
          visibility: 'working_trace',
          createdAt: activity.time?.start ?? Date.now(),
          ...(activity.time?.end === undefined ? {} : { completedAt: activity.time.end }),
          parts: [part]
        }
      ])
      .catch((error: unknown) =>
        Logger.info('Pawn activity could not be persisted', {
          spawnerThreadId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    if (this.host.sessionRegistry.get(spawnerSessionId)) {
      this.host.broadcast({ type: 'message.part.updated', sessionId: spawnerSessionId, part })
    }
  }

  /**
   * Spawn or continue a pawn agent: an independent worker thread owned by the
   * agent whose turn called the tool.
   *
   * The pawn is a real thread, not a nested session: it carries
   * `coordinatorThreadId` (which hides it from the thread list and keeps it out
   * of capacity accounting), `userInputLocked` (which refuses user-origin
   * prompts while internal turns still run), and the spawner's own permission
   * level, so a pawn can never do more than the agent that spawned it.
   *
   * Nothing here writes the user's pawn default: the configured selection is read
   * once per spawn and never replaced, so only the settings page can change it.
   */
  async runPawnTool(input: Record<string, unknown>, context: PawnToolContext): Promise<unknown> {
    const { projectId, threadId } = context
    const spawner = await this.host.threadManager.getThread(projectId, threadId)
    if (!spawner?.settings) {
      throw new Error('Select a model for this thread before spawning a pawn agent.')
    }
    if (spawner.userInputLocked === true || spawner.coordinatorThreadId) {
      throw new Error(
        'A pawn agent cannot spawn pawn agents. Report to the agent that spawned you instead.'
      )
    }
    const spawnerSettings = validateThreadSettings(spawner.settings)
    const rawInstructions = input['instructions']
    const instructions = typeof rawInstructions === 'string' ? rawInstructions.trim() : ''
    if (!instructions) {
      throw new Error('Describe the complete task for the pawn agent in `instructions`.')
    }
    const rawPurpose = input['purpose']
    const purpose = typeof rawPurpose === 'string' ? rawPurpose.trim() : ''
    const rawPawnId = input['pawn_id']
    const pawnId = typeof rawPawnId === 'string' ? rawPawnId.trim() : ''
    const background = input['background'] === true

    const pawn = pawnId
      ? await this.requirePawnThread(projectId, threadId, pawnId)
      : await this.spawnPawnThread(
          projectId,
          spawner,
          spawnerSettings,
          input,
          purpose,
          instructions
        )
    const settings = pawn.settings
    if (!settings) throw new Error('The pawn agent has no model settings.')

    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      pawn.id,
      settings.accountId
    )
    const sessionId = await this.host.ensureSession(projectId, pawn.id, driverId)
    const startedAt = Date.now()
    // A pawn's session belongs to the pawn's own thread. Registering the owner
    // here is what lets the spawning conversation's card open the pawn's
    // transcript: the child-session lookup resolves this session to that thread
    // and reads its mirrored messages, while the pawn keeps running.
    this.host.state.childSessionOwners.set(sessionId, {
      projectId,
      threadId: pawn.id,
      projectPath,
      driverId,
      accountId: settings.accountId
    })
    this.host.state.childSessionActivityStatuses.set(sessionId, 'running')
    const pawnActivity = (
      status: AgentToolStatus,
      patch: Partial<AgentSubagentActivity> = {}
    ): AgentSubagentActivity => ({
      status,
      agent: purpose || 'Pawn agent',
      description: purpose,
      prompt: instructions,
      childSessionId: sessionId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      background,
      pawn: true,
      time: { start: startedAt, ...(status === 'running' ? {} : { end: Date.now() }) },
      ...patch
    })
    await this.publishPawnActivity(projectId, threadId, context.sessionId, pawnActivity('running'))
    const prompt = [
      `You are a CodeInOven pawn agent: an independent worker thread spawned by the agent working on thread ${threadId}, and you answer to that agent alone.`,
      purpose ? `Purpose: ${purpose}.` : '',
      'The user cannot prompt you and does not answer you. Work autonomously, do not ask the user questions, and do not commit: the agent that spawned you reviews your work and commits it.',
      settings.permissionLevel === 'full_access'
        ? 'You have full access to this project.'
        : 'Destructive actions need approval, which is surfaced on the thread that spawned you.',
      PAWN_AGENT_CONTRACT,
      '',
      'Instruction from the agent that spawned you:',
      '',
      instructions
    ]
      .filter(Boolean)
      .join('\n')

    const messageId = createMessageId()
    // Steering: an instruction for a pawn that is still working goes into the
    // work in progress, because a harness takes a prompt sent to a live session
    // into its running turn instead of refusing it. That is how a user who
    // dislikes the direction reaches a pawn: they tell the agent that spawned it,
    // and that agent calls this tool again with the same `pawn_id`.
    //
    // A steer must not arm a second completion waiter. There is exactly one per
    // session, so replacing the one the spawn armed would strand it until its
    // timer fired and then report a failure that never happened.
    const pawnIsWorking =
      this.host.state.childSessionActivityStatuses.get(sessionId) === 'running' ||
      this.host.sessionStatuses.get(sessionId)?.state === 'working'
    const steer = pawnId !== '' && pawnIsWorking
    if (steer) {
      await this.host.sendPrompt(
        projectId,
        pawn.id,
        settings,
        prompt,
        [],
        undefined,
        messageId,
        undefined,
        undefined,
        undefined,
        'internal',
        {
          action: `Update from the agent that spawned you · ${pawn.title}`.slice(0, 120),
          body: instructions.slice(0, 20_000)
        }
      )
      return {
        pawnId: pawn.id,
        threadId: pawn.id,
        title: pawn.title,
        status: 'running',
        steered: true,
        model: { providerId: settings.providerId, modelId: settings.modelId },
        thinkingLevel: settings.thinkingLevel,
        note: 'The update reached the pawn while it works, so it applies to the work in progress. Its report will steer you when it finishes; do not end your turn with nothing to do while it runs.'
      }
    }
    const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
      sessionId,
      ChatEngine.PAWN_RUN_TIMEOUT_MS,
      'Pawn agent'
    )
    try {
      await driver.sendPrompt(projectPath, {
        sessionId,
        settings,
        text: prompt,
        attachments: [],
        userMessageId: messageId
      })
    } catch (error) {
      // The turn never started, so nothing will ever resolve this waiter. Keep
      // its rejection handled and let the original failure reach the agent.
      void completion.catch(() => undefined)
      throw error
    }

    if (!background) {
      const verdict = await Promise.race([
        completion.then(
          () => 'completed' as const,
          (error: unknown) =>
            error instanceof Error ? error.message : 'The pawn agent session failed'
        ),
        new Promise<'running'>((resolve) => {
          const timer = setTimeout(() => resolve('running'), ChatEngine.PAWN_FOREGROUND_WAIT_MS)
          // Never let the budget timer hold the process open on its own.
          timer.unref?.()
        })
      ])
      if (verdict === 'completed') {
        const output = await this.pawnFinalMessage(driver, projectPath, sessionId)
        const report = output || 'The pawn agent returned no message.'
        this.host.state.childSessionActivityStatuses.set(sessionId, 'completed')
        await this.publishPawnActivity(
          projectId,
          threadId,
          context.sessionId,
          pawnActivity('completed', { output: report })
        )
        return {
          pawnId: pawn.id,
          threadId: pawn.id,
          title: pawn.title,
          status: 'completed',
          model: { providerId: settings.providerId, modelId: settings.modelId },
          thinkingLevel: settings.thinkingLevel,
          output: report
        }
      }
      if (verdict !== 'running') {
        this.host.state.childSessionActivityStatuses.set(sessionId, 'error')
        await this.publishPawnActivity(
          projectId,
          threadId,
          context.sessionId,
          pawnActivity('error', { error: verdict })
        )
        throw new Error(`Pawn agent failed: ${verdict}`)
      }
    }

    // Background, or a foreground call that outlived its inline budget: report
    // once, when the pawn's thread actually finishes.
    void completion
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({
          ok: false as const,
          message: `The pawn agent failed: ${error instanceof Error ? error.message : String(error)}`
        })
      )
      .then(async (result) => {
        const output = result.ok
          ? await this.pawnFinalMessage(driver, projectPath, sessionId)
          : result.message
        const report = output || 'The pawn agent returned no message.'
        this.host.state.childSessionActivityStatuses.set(
          sessionId,
          result.ok ? 'completed' : 'error'
        )
        await this.publishPawnActivity(
          projectId,
          threadId,
          context.sessionId,
          pawnActivity(
            result.ok ? 'completed' : 'error',
            result.ok ? { output: report } : { error: report }
          )
        )
        await this.reportPawnCompletion(projectId, spawnerSettings, pawn, purpose, report)
      })
      .catch((error: unknown) =>
        Logger.info('Pawn agent report could not reach its spawner', {
          threadId: pawn.id,
          spawnerThreadId: threadId,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    return {
      pawnId: pawn.id,
      threadId: pawn.id,
      title: pawn.title,
      status: 'running',
      model: { providerId: settings.providerId, modelId: settings.modelId },
      thinkingLevel: settings.thinkingLevel,
      note: 'The pawn is still working. Its final report will steer you when it finishes; continue with other work and do not end the turn with nothing to do while it runs.'
    }
  }

  /**
   * Create the pawn's thread. Hidden (owned by the spawner) and locked against
   * user input, with the model resolved as: this call's override, then the
   * user's pawn default, then the spawner's own model; and the thinking level as:
   * this call's override, then the user's pawn default, then the lowest level.
   */
  async spawnPawnThread(
    projectId: string,
    spawner: Thread,
    spawnerSettings: ThreadSettings,
    input: Record<string, unknown>,
    purpose: string,
    instructions: string
  ): Promise<Thread> {
    const configured = (await this.host.storage.getConfig()).agentDefaults.pawn
    const modelOverride = pawnModelOverride(input['model'])
    const thinkingOverride = pawnThinkingOverride(input['thinking_level'])
    const settings: ThreadSettings = {
      ...spawnerSettings,
      ...(modelOverride ?? configured ?? {}),
      thinkingLevel: thinkingOverride ?? configured?.thinkingLevel ?? PAWN_DEFAULT_THINKING_LEVEL,
      // A pawn owns one task, so the Engineering planning modes and any audit
      // loop never follow it in: they belong to the thread the user is watching.
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined,
      reportToCoordinator: undefined
    }
    const names = await this.host.storage.getWorkerNames()
    const name = names[randomInt(names.length)] ?? 'agent'
    const label = purpose || instructions.split('\n')[0].slice(0, 60)
    return this.host.threadManager.createThread({
      projectId,
      providerId: settings.providerId,
      title: `pawn-${name}: ${label}`.slice(0, 120),
      titleSource: 'manual',
      settings,
      featureSlug: spawner.featureSlug,
      scopeBucketId: spawner.scopeBucketId,
      workingDirectory: spawner.workingDirectory,
      coordinatorThreadId: spawner.id,
      userInputLocked: true
    })
  }

  /**
   * Resolve a pawn the caller already spawned. Ownership is enforced here and
   * nowhere else: a thread is a pawn of this turn only when it is locked and
   * points back at the calling thread, so one agent can never continue another's
   * pawn.
   */
  async requirePawnThread(
    projectId: string,
    spawnerThreadId: string,
    pawnId: string
  ): Promise<Thread> {
    const pawn = await this.host.threadManager.getThread(projectId, pawnId)
    if (
      !pawn ||
      pawn.coordinatorThreadId !== spawnerThreadId ||
      pawn.userInputLocked !== true ||
      pawn.auditorThreadId !== undefined
    ) {
      throw new Error(
        'That id is not a pawn agent this thread spawned. Spawn one by calling this tool without `pawn_id`.'
      )
    }
    return pawn
  }

  /** The pawn's own final message: the last assistant text on its thread. */
  async pawnFinalMessage(
    driver: HarnessDriver,
    projectPath: string,
    sessionId: string
  ): Promise<string> {
    const messages = await driver.loadMessages(projectPath, sessionId)
    const response = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!response) return ''
    return response.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
  }

  /**
   * Steer the spawning thread with a finished pawn's report, which is the whole
   * point of a background pawn: its work lands in the agent's context as a short
   * report instead of the thousands of steps that produced it.
   */
  async reportPawnCompletion(
    projectId: string,
    spawnerSettings: ThreadSettings,
    pawn: Thread,
    purpose: string,
    output: string
  ): Promise<void> {
    if (!pawn.coordinatorThreadId) return
    await this.host.sendPrompt(
      projectId,
      pawn.coordinatorThreadId,
      spawnerSettings,
      [
        `Pawn agent ${pawn.title} finished its task.`,
        purpose ? `Purpose: ${purpose}.` : '',
        'Read its report, inspect the files it touched, and commit the work you accept: a pawn never commits.',
        output || 'The pawn agent returned no message.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      {
        action: `Pawn finished · ${pawn.title}`.slice(0, 120),
        body: output.slice(0, 20_000)
      }
    )
  }

  /** Claim the file paths a sub-agent's worker reported through its activity
   *  payload onto the owning thread's turn. While the turn is active the paths
   *  join its live change tracking; after a premature settle they attach to the
   *  just-completed checkpoint via the late-claim reopen path. */
  claimSubagentFiles(session: SessionInfo, files: readonly string[]): void {
    const claimed: string[] = []
    for (const file of files) {
      const path = projectRelativePath(session.projectPath, file)
      if (!path || session.userTouchedPaths?.has(path)) continue
      claimed.push(path)
    }
    if (claimed.length === 0) return
    if (session.activeTurnId) {
      session.changedPaths ??= new Set()
      session.preciseChangedPaths ??= new Map()
      const claimedAt = Date.now()
      for (const path of claimed) {
        session.changedPaths.add(path)
        session.preciseChangedPaths.set(path, claimedAt)
      }
      return
    }
    void this.host.units['turns'].reopenSettledTurnForLateClaim(session, claimed)
  }

  observeChildSession(driverId: string, event: SessionAgentEvent): void {
    if (
      event.type === 'message.part.updated' &&
      event.part.type === 'subagent' &&
      event.part.activity.childSessionId
    ) {
      const registeredParent = this.host.sessionRegistry.get(event.sessionId)
      const inheritedOwner = this.host.state.childSessionOwners.get(event.sessionId)
      const parent = registeredParent ?? inheritedOwner
      if (parent) {
        const childSessionId = event.part.activity.childSessionId
        const alreadyTracked = this.host.state.childSessionOwners.has(childSessionId)
        this.host.state.childSessionActivityStatuses.set(childSessionId, event.part.activity.status)
        const owner: ChildSessionInfo = {
          projectId: parent.projectId,
          threadId: parent.threadId,
          projectPath: parent.projectPath,
          driverId,
          accountId: parent.accountId,
          parentSessionId: registeredParent ? event.sessionId : inheritedOwner?.parentSessionId
        }
        this.host.state.childSessionOwners.set(childSessionId, owner)
        // The worker's file-tool paths are the only reliable attribution for
        // sub-agent edits: the child's CLI session can be disposed before any
        // transcript capture runs, so claim them the moment they are reported.
        if (event.part.activity.files?.length) {
          const ownerSession = [...this.host.sessionRegistry.values()].find(
            (candidate) =>
              candidate.projectId === parent.projectId && candidate.threadId === parent.threadId
          )
          if (ownerSession) this.claimSubagentFiles(ownerSession, event.part.activity.files)
        }
        const isTerminal =
          event.part.activity.status === 'completed' ||
          event.part.activity.status === 'error' ||
          event.part.activity.status === 'aborted'
        if (isTerminal) {
          void this.captureCompletedChildSession(owner, childSessionId).catch((error) =>
            Logger.dev('Sub-agent transcript capture unavailable:', error)
          )
        } else if (!alreadyTracked) {
          void this.captureChildSession(owner, childSessionId).catch((error) =>
            Logger.dev('Sub-agent transcript capture unavailable:', error)
          )
        }
      }
    }

    const owner = this.host.state.childSessionOwners.get(event.sessionId)
    if (owner && (event.type === 'session.idle' || event.type === 'session.error')) {
      // Only the child's terminal signal persists its transcript. While a
      // worker streams, its events are already mirrored live by the view and
      // the driver holds the live transcript, so capturing on every child
      // `message.completed` would only re-probe the harness and rewrite the
      // mirror row by row mid-run.
      void this.captureCompletedChildSession(owner, event.sessionId).catch((error) =>
        Logger.dev('Sub-agent transcript capture unavailable:', error)
      )
    }
  }

  /**
   * Record every sub-agent turn of a thread that reports usage, and fold those
   * tokens into the thread's harness totals.
   *
   * A worker runs as a nested session billed separately from the parent turn,
   * and its mirrored transcript is the only place those tokens exist. The
   * harness ledger (guarded by `harness_usage_messages`) and the usage ledger
   * (guarded by its stable event id) both ignore a replay, so this sweep is safe
   * to run after every child capture and at every parent turn end. Messages the
   * harness never reported usage for are skipped rather than recorded as zero,
   * because an invented zero would be indistinguishable from real silence.
   */
  async recordSubagentTurnUsage(
    projectId: string,
    threadId: string,
    parentTurnId: string,
    subagentMessages: readonly UsageBearingMessage[]
  ): Promise<void> {
    const billable = subagentMessages.filter(
      (message) =>
        message.role === 'assistant' &&
        Boolean(message.harnessId) &&
        message.tokens !== undefined &&
        !this.host.state.recordedSubagentUsageIds.has(message.id)
    )
    if (billable.length === 0) return
    for (const message of billable) {
      this.host.state.recordedSubagentUsageIds.add(message.id)
      this.host.units['assistant-authoring'].recordAssistantUsageEvent({
        idPrefix: 'subagent',
        threadId,
        projectId,
        parentTurnId,
        feature: 'subagent',
        featureCallId: message.id,
        message,
        thinkingLevelFallback: null
      })
    }
    await this.host.threadManager
      .accumulateHarnessUsage(projectId, threadId, billable)
      .catch((error: unknown) => Logger.dev('Sub-agent usage accumulation failed:', error))
  }

  /** The parent turn a worker's spend belongs to.
   *
   * A worker is spawned from a parent turn, and the session registry tracks the
   * user message that started that turn. When no turn of the parent is
   * registered any more (a worker that outlived its turn) the worker session
   * itself becomes the anchor, which keeps the spend in the ledger and out of
   * any other turn's per-turn totals.
   */
  subagentTurnKey(owner: ChildSessionInfo, sessionId: string): string {
    const parent = owner.parentSessionId
      ? this.host.sessionRegistry.get(owner.parentSessionId)
      : undefined
    return (
      parent?.activeTurnUserMessageId ??
      parent?.activeTurnId ??
      parent?.lastTurnId ??
      `subagent:${sessionId}`
    )
  }
}
