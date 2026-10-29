import { join, resolve } from 'path'
import { runningWorkers } from '../thread-transfer-service/thread-transfer-workers'
import { Logger } from '../../system/logger'
import { AssignmentEngineError } from '../../../lib/engines/assignment-engine'
import { supportsIsolatedSessions } from '../../drivers/isolated-session'
import { DEFAULT_HARNESS } from '../../../lib/harness-default'
import { updateRetryWakeWindow } from '../thread-events'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { SendPromptOptions } from '../../drivers/driver.interface'
import type {
  AgentEvent,
  AgentMessage,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentProvenance,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  UserMessagePresentation,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { isWorkflowCoordinatorThread } from '../../../lib/types'
import { resolveWorkflowCoordinatorThreadId } from '../../../lib/engines/thread-manager-lineage'
import { ASSIGNMENT_PLAN_SCHEMA } from '../../../lib/agent-tools'
import { ensureFeatureSlug, featureArtifactDirectory } from '../../../lib/project-artifacts'
import { parseGeneratedAssignmentContent } from '../../../lib/assignment/assignment-validation'
import type {
  AssignmentGenerationSource,
  CoordinatorHandoffQueue,
  PendingAssignmentTurn,
  QueuedCoordinatorHandoff,
  SessionInfo
} from './chat-engine-types'
import { GeneratedJsonParseError, rawErrorMessage } from './chat-engine-errors'
import { formatConversationTranscript } from './chat-engine-message-text'
import { COORDINATOR_HANDOFF_QUEUE_DIR, MAX_COORDINATOR_HANDOFFS } from './chat-engine-constants'
import {
  CONVERSATION_ASSIGNMENT_INSTRUCTION,
  PROMPT_READ_ONLY_TOOLS,
  engineeringArtifactBoundaryInstruction,
  formatOpenAnnotations
} from './chat-engine-prompts'
import { isRecord, parseGeneratedJson } from './chat-engine-generated-artifacts'
import {
  coordinatorHandoffQueueKey,
  coordinatorHandoffQueuePath,
  isCoordinatorThread,
  pendingAssignmentTurnPath
} from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine assignment: one concern, moved verbatim from the composition root. */
export class ChatEngineAssignment {
  constructor(private readonly host: ChatEngine) {}

  /** Retry every failed worker first, then wake the coordinator only if work remains actionable. */
  async resumeAssignmentAttention(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    this.host.units['messages'].touchUserActivity()
    return this.resumeAssignmentAttentionInternal(projectId, coordinatorThreadId)
  }

  async resumeAssignmentAttentionInternal(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    let assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!assignment) throw new AssignmentEngineError('not_found', 'Assignment not found')
    const retryableWorkerIds = assignment.content.tasks
      .filter(
        (task) =>
          task.owner === 'worker' &&
          task.status === 'attention' &&
          task.report?.status === 'failed' &&
          task.threadId
      )
      .map((task) => task.threadId)
      .filter((threadId): threadId is string => threadId !== undefined)

    for (const workerThreadId of retryableWorkerIds) {
      try {
        assignment = await this.host.units['assignment-workers'].retryAssignmentWorkerInternal(
          projectId,
          coordinatorThreadId,
          workerThreadId
        )
      } catch (error) {
        Logger.error('Assignment worker retry failed', {
          assignmentId: assignment.id,
          workerThreadId,
          error: rawErrorMessage(error)
        })
      }
    }

    assignment =
      this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId) ?? assignment
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    // A deliberate user stop vetoes the automatic resume: the assignment state
    // itself is untouched by Stop, so without this latch the next launch (or the
    // next attention reconcile) would silently re-prompt a thread the user
    // stopped on purpose. A fresh prompt clears the latch and re-arms resuming.
    if (
      coordinator &&
      (await this.host.threadManager.wasStoppedByUser(projectId, coordinatorThreadId))
    ) {
      Logger.info('Assignment resume suppressed: the user stopped this thread', {
        projectId,
        threadId: coordinatorThreadId,
        assignmentStatus: assignment.status
      })
      return assignment
    }
    if (coordinator?.settings && (await this.assignmentNeedsCoordinatorTurn(assignment))) {
      await this.host.units['assignment-run'].ensureAssignmentApi()
      await this.sendAssignmentCoordinatorPrompt(
        assignment,
        coordinator.settings,
        this.coordinatorAssignmentPrompt(assignment),
        { action: 'Resume Assignment coordination' },
        true
      )
    }
    return this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId) ?? assignment
  }

  /**
   * Live provider work is authoritative for Assignment recovery. Retry can
   * originate from the worker, the coordinator, or the provider itself; once
   * a linked worker is genuinely active, clear its stale resting state so the
   * coordinator panel, the Assignment studio, and the worker's own reporting
   * all agree that the task is running again.
   */
  async reconcileWorkingAssignmentState(thread: Thread): Promise<boolean> {
    try {
      if (thread.assignmentRole === 'worker' && thread.assignmentId && thread.coordinatorThreadId) {
        const assignment = this.host.state.assignmentEngine.getActive(
          thread.projectId,
          thread.coordinatorThreadId
        )
        const task = assignment?.content.tasks.find(
          (candidate) => candidate.owner === 'worker' && candidate.threadId === thread.id
        )
        if (
          !assignment ||
          assignment.id !== thread.assignmentId ||
          assignment.status === 'stopped' ||
          !task ||
          !this.host.units['assignment-workers'].workerTaskNeedsReactivation(task)
        ) {
          return false
        }
        await this.host.state.assignmentEngine.markWorkerSteered(assignment.id, thread.id)
        return true
      }

      if (thread.assignmentRole !== 'coordinator' || !thread.assignmentId) return false
      let assignment = this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)
      if (!assignment || assignment.id !== thread.assignmentId) return false
      if (assignment.status === 'stopped') return false
      let changed = false
      for (const task of assignment.content.tasks) {
        if (
          task.owner !== 'worker' ||
          !task.threadId ||
          !this.host.units['assignment-workers'].workerTaskNeedsReactivation(task)
        ) {
          continue
        }
        const worker = await this.host.threadManager.getThread(thread.projectId, task.threadId)
        if (!worker || (worker.status !== 'planning' && worker.status !== 'executing')) continue
        assignment = await this.host.state.assignmentEngine.markWorkerSteered(
          assignment.id,
          worker.id
        )
        changed = true
      }
      return changed
    } catch (error) {
      Logger.error('Working Assignment retry reconciliation failed', {
        threadId: thread.id,
        assignmentId: thread.assignmentId,
        error: rawErrorMessage(error)
      })
      return false
    }
  }

  async withCoordinatorHandoffQueueLock<T>(
    projectId: string,
    threadId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = coordinatorHandoffQueueKey(projectId, threadId)
    const previous = this.host.state.coordinatorHandoffQueueLocks.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.host.state.coordinatorHandoffQueueLocks.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.host.state.coordinatorHandoffQueueLocks.get(key) === tail) {
        this.host.state.coordinatorHandoffQueueLocks.delete(key)
      }
    }
  }

  async readCoordinatorHandoffQueue(
    projectId: string,
    threadId: string
  ): Promise<CoordinatorHandoffQueue> {
    const raw = await this.host.storage.read<unknown>(
      coordinatorHandoffQueuePath(projectId, threadId)
    )
    if (raw === null) return { schemaVersion: 1, projectId, threadId, items: [] }
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 1 ||
      raw.projectId !== projectId ||
      raw.threadId !== threadId ||
      !Array.isArray(raw.items)
    ) {
      throw new Error(`Invalid coordinator handoff queue for thread ${threadId}`)
    }
    const items = raw.items.map((item): QueuedCoordinatorHandoff => {
      if (
        !isRecord(item) ||
        item.schemaVersion !== 1 ||
        item.projectId !== projectId ||
        item.threadId !== threadId ||
        typeof item.id !== 'string' ||
        typeof item.text !== 'string' ||
        typeof item.createdAt !== 'number' ||
        !Array.isArray(item.attachments) ||
        !Array.isArray(item.promptReferences) ||
        !Array.isArray(item.projectReferences) ||
        !Array.isArray(item.taskReferences)
      ) {
        throw new Error(`Invalid coordinator handoff entry for thread ${threadId}`)
      }
      const specAction = item.specAction
      if (
        specAction !== undefined &&
        specAction !== 'request' &&
        specAction !== 'review' &&
        specAction !== 'implement'
      ) {
        throw new Error(`Invalid coordinator handoff action for thread ${threadId}`)
      }
      let presentation: UserMessagePresentation | undefined
      if (item.presentation !== undefined) {
        if (
          !isRecord(item.presentation) ||
          typeof item.presentation.action !== 'string' ||
          (item.presentation.body !== undefined && typeof item.presentation.body !== 'string')
        ) {
          throw new Error(`Invalid coordinator handoff presentation for thread ${threadId}`)
        }
        presentation = {
          action: validateBoundedString(
            item.presentation.action,
            'Coordinator handoff action',
            1,
            120
          ),
          ...(typeof item.presentation.body === 'string'
            ? {
                body: validateBoundedString(
                  item.presentation.body,
                  'Coordinator handoff body',
                  1,
                  20_000
                )
              }
            : {})
        }
      }
      return {
        schemaVersion: 1,
        id: validateEntityId(item.id, 'Coordinator handoff ID', 256),
        projectId,
        threadId,
        settings: validateThreadSettings(item.settings),
        text: validateBoundedString(item.text, 'Coordinator handoff', 0, 200_000),
        attachments: item.attachments as PromptAttachment[],
        ...(specAction ? { specAction } : {}),
        ...(typeof item.promptContext === 'string' ? { promptContext: item.promptContext } : {}),
        promptReferences: item.promptReferences as PromptReference[],
        projectReferences: item.projectReferences as PromptProjectReference[],
        ...(presentation ? { presentation } : {}),
        taskReferences: item.taskReferences as PromptAssignmentTaskReference[],
        createdAt: item.createdAt
      }
    })
    return { schemaVersion: 1, projectId, threadId, items }
  }

  async enqueueCoordinatorHandoff(item: QueuedCoordinatorHandoff): Promise<void> {
    await this.withCoordinatorHandoffQueueLock(item.projectId, item.threadId, async () => {
      const queue = await this.readCoordinatorHandoffQueue(item.projectId, item.threadId)
      if (queue.items.some((candidate) => candidate.id === item.id)) return
      if (queue.items.length >= MAX_COORDINATOR_HANDOFFS) {
        throw new Error(
          `The Sr. Engineer handoff queue reached its ${MAX_COORDINATOR_HANDOFFS}-message limit`
        )
      }
      queue.items.push(item)
      await this.host.storage.write(
        coordinatorHandoffQueuePath(item.projectId, item.threadId),
        queue
      )
    })
  }

  async drainCoordinatorHandoffQueue(projectId: string, threadId: string): Promise<void> {
    const key = coordinatorHandoffQueueKey(projectId, threadId)
    const active = this.host.state.coordinatorHandoffDrains.get(key)
    if (active) return active
    const drain = (async () => {
      const queue = await this.withCoordinatorHandoffQueueLock(projectId, threadId, () =>
        this.readCoordinatorHandoffQueue(projectId, threadId)
      )
      const next = queue.items[0]
      if (!next) return
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (!thread || !isCoordinatorThread(thread)) {
        await this.host.storage.remove(coordinatorHandoffQueuePath(projectId, threadId))
        return
      }
      const status = thread.sessionId ? this.host.sessionStatuses.get(thread.sessionId) : undefined
      if (status?.state === 'working' || status?.state === 'waiting' || status?.state === 'error') {
        return
      }
      this.host.state.dispatchingCoordinatorHandoffIds.add(next.id)
      try {
        await this.host.sendPrompt(
          projectId,
          threadId,
          next.settings,
          next.text,
          next.attachments,
          next.specAction,
          next.id,
          next.promptContext,
          next.promptReferences,
          next.projectReferences,
          'internal',
          next.presentation,
          next.taskReferences
        )
      } finally {
        this.host.state.dispatchingCoordinatorHandoffIds.delete(next.id)
      }
    })().finally(() => {
      if (this.host.state.coordinatorHandoffDrains.get(key) === drain) {
        this.host.state.coordinatorHandoffDrains.delete(key)
      }
    })
    this.host.state.coordinatorHandoffDrains.set(key, drain)
    return drain
  }

  /**
   * Deliver queued coordinator handoffs left behind by a process that stopped.
   *
   * Runs at launch and again when this process takes over from a sibling that
   * exited, so a deferred queue is never stranded. Delivery is otherwise driven
   * by the coordinator's own runtime (`queueCoordinatorHandoff` and the session
   * idle signal), which is why the launch pass must not touch a queue another
   * instance owns: the file is shared, and only the instance running the
   * coordinator may decide that its handoff is due. A queue file is named by its
   * coordinator thread, so each one is gated as the workflow it belongs to.
   */
  async restoreCoordinatorHandoffQueues(): Promise<void> {
    for (const projectId of await this.host.storage.listDirectories(
      COORDINATOR_HANDOFF_QUEUE_DIR
    )) {
      const projectQueuePath = join(COORDINATOR_HANDOFF_QUEUE_DIR, projectId)
      for (const entry of await this.host.storage.list(projectQueuePath)) {
        if (!entry.endsWith('.json')) continue
        const threadId = entry.slice(0, -'.json'.length)
        const thread = await this.host.threadManager.getThread(projectId, threadId)
        // A queue whose thread is gone is a leftover the drain itself removes,
        // so it needs no owner.
        if (
          thread &&
          !(await this.host.units['runtime-workflows'].claimWorkflowForDrive(
            projectId,
            thread,
            'queued coordinator handoffs'
          ))
        ) {
          continue
        }
        void this.drainCoordinatorHandoffQueue(projectId, threadId).catch((error) =>
          Logger.error('Queued coordinator handoff could not be restored', {
            projectId,
            threadId,
            error: rawErrorMessage(error)
          })
        )
      }
    }
  }

  /** Stop every runtime owned by an Assignment and persist a non-recoverable terminal state. */
  async stopAssignment(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    const current = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!current) throw new AssignmentEngineError('not_found', 'Assignment not found')
    const auditRunKey = `${projectId}:${current.id}`
    this.host.state.stoppedAssignmentAuditRuns.add(auditRunKey)
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)

    let assignment: AssignmentPlan
    try {
      assignment = await this.host.units['assignment-run'].withAssignmentApiLock(current.id, () =>
        this.host.state.assignmentEngine.stop(
          projectId,
          coordinatorThreadId,
          coordinator?.settings?.loopMode === true
        )
      )
    } catch (error) {
      this.host.state.stoppedAssignmentAuditRuns.delete(auditRunKey)
      throw error
    }
    this.revokeAssignmentCapabilities(assignment.id)
    this.host.state.activeAssignmentAuditRuns.delete(auditRunKey)

    if (coordinator?.settings) {
      await this.host.threadManager.updateSettings(projectId, coordinatorThreadId, {
        ...coordinator.settings,
        assignmentMode: false,
        loopMode: false,
        loopAuditor: undefined
      })
    }
    if (coordinator?.auditState) {
      await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, undefined)
    }

    const threadIds = new Set<string>([
      coordinatorThreadId,
      ...assignment.content.tasks.flatMap((task) => (task.threadId ? [task.threadId] : [])),
      ...(assignment.auditorThreadId ? [assignment.auditorThreadId] : [])
    ])
    const results = await Promise.allSettled(
      [...threadIds].map((threadId) => this.stopAssignmentThread(projectId, threadId))
    )
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        Logger.error('Assignment thread stop was incomplete', {
          assignmentId: assignment.id,
          threadId: [...threadIds][index],
          error: rawErrorMessage(result.reason)
        })
      }
    })
    return assignment
  }

  /** Resume only after an explicit user action, restoring safe orchestration state. */
  async resumeAssignment(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    const current = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!current) throw new AssignmentEngineError('not_found', 'Assignment not found')
    const assignment = await this.host.units['assignment-run'].withAssignmentApiLock(
      current.id,
      () => this.host.state.assignmentEngine.resume(projectId, coordinatorThreadId)
    )
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator?.settings) throw new Error('Sr. Engineer settings are missing')
    const resumedThreadIds = new Set<string>([
      coordinatorThreadId,
      ...assignment.content.tasks.flatMap((task) => (task.threadId ? [task.threadId] : [])),
      ...(assignment.auditorThreadId ? [assignment.auditorThreadId] : [])
    ])
    const resumedThreads = await Promise.all(
      [...resumedThreadIds].map((threadId) =>
        this.host.threadManager.getThread(projectId, threadId)
      )
    )
    resumedThreads.forEach((thread) => {
      if (thread?.sessionId) this.host.state.stoppedAssignmentSessions.delete(thread.sessionId)
    })
    for (const [sessionId, owner] of this.host.state.childSessionOwners) {
      if (owner.projectId === projectId && resumedThreadIds.has(owner.threadId)) {
        this.host.state.stoppedAssignmentSessions.delete(sessionId)
      }
    }
    const settings: ThreadSettings = {
      ...coordinator.settings,
      assignmentMode: false,
      loopMode: assignment.loopModeBeforeStop === true
    }
    await this.host.threadManager.updateSettings(projectId, coordinatorThreadId, settings)
    await this.host.units['assignment-run'].ensureAssignmentApi()

    if (['approved', 'running', 'attention'].includes(assignment.status)) {
      await this.sendAssignmentCoordinatorPrompt(
        assignment,
        settings,
        this.coordinatorAssignmentPrompt(assignment),
        { action: 'Resume Assignment' },
        true
      )
    } else if (assignment.auditCycle?.status === 'available') {
      const auditor = assignment.auditorThreadId
        ? await this.host.threadManager.getThread(projectId, assignment.auditorThreadId)
        : null
      void this.host
        .generateAssignmentAudit(projectId, coordinatorThreadId, auditor?.settings ?? settings)
        .catch((error) => {
          Logger.error('Resumed Assignment audit failed', {
            assignmentId: assignment.id,
            error: rawErrorMessage(error)
          })
        })
    } else if (
      assignment.auditCycle?.status === 'planning_rework' ||
      assignment.auditCycle?.status === 'reworking'
    ) {
      await this.sendAssignmentCoordinatorPrompt(
        assignment,
        settings,
        this.coordinatorAssignmentPrompt(assignment),
        { action: 'Resume Assignment' },
        true
      )
    }
    return assignment
  }

  async stopAssignmentThread(projectId: string, threadId: string): Promise<void> {
    const childSessions = [...this.host.state.childSessionOwners.entries()].filter(
      ([, owner]) => owner.projectId === projectId && owner.threadId === threadId
    )
    const childResults = await Promise.allSettled(
      childSessions.map(async ([sessionId, owner]) => {
        this.host.state.stoppedAssignmentSessions.add(sessionId)
        this.host.state.userAbortedSessions.add(sessionId)
        this.host.state.activeCompactions.delete(sessionId)
        this.host.units['runtime-connectivity'].rejectCompletionWaiter(
          sessionId,
          'Assignment stopped by user'
        )
        const driver = this.host.units['turns-dispatch'].driverForRuntime(
          owner.driverId,
          owner.accountId
        )
        try {
          if (driver && this.host.sessionStatuses.get(sessionId)?.state === 'working') {
            await driver.abort(owner.projectPath, sessionId)
          }
        } finally {
          await this.host.units['utilities'].cleanupTurnUtilities(sessionId)
          this.host.state.retryScheduler?.clear(sessionId)
          updateRetryWakeWindow(sessionId, null)
          this.host.units['turns-sessions'].clearSessionWatchdog(sessionId)
          this.host.units['questions'].clearPendingQuestionsForSession(sessionId)
          this.host.units['permissions'].clearPendingPermissionsForSession(sessionId)
          this.host.sessionStatuses.set(sessionId, { state: 'idle' })
          this.host.broadcast({ type: 'session.status', sessionId, status: { state: 'idle' } })
        }
      })
    )
    const childFailure = childResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )

    try {
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (thread?.sessionId) this.host.state.stoppedAssignmentSessions.add(thread.sessionId)
      await this.host.abort(projectId, threadId)
    } finally {
      await this.host.state.agentProcesses.releaseThread(projectId, threadId)
      this.host.state.activeLoopRuns.delete(`${projectId}:${threadId}`)
      const thread = await this.host.threadManager.getThread(projectId, threadId)
      if (
        thread &&
        ['created', 'planning', 'awaiting_approval', 'executing', 'working-paused'].includes(
          thread.status
        )
      ) {
        await this.host.threadManager.setStatus(projectId, threadId, 'interrupted', { read: true })
      }
    }
    if (childFailure) throw childFailure.reason
  }

  async sendAssignmentCoordinatorPrompt(
    assignment: AssignmentPlan,
    settings: ThreadSettings,
    prompt: string,
    presentation?: UserMessagePresentation,
    force = false
  ): Promise<boolean> {
    const snapshotHash = await this.host.state.assignmentEngine.claimCoordinatorSnapshot(
      assignment.id
    )
    if (!snapshotHash && !force) return false
    try {
      await this.host.sendPrompt(
        assignment.projectId,
        assignment.coordinatorThreadId,
        settings,
        prompt,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal',
        presentation
      )
      return true
    } catch (error) {
      if (snapshotHash)
        this.host.state.assignmentEngine.releaseCoordinatorSnapshot(assignment.id, snapshotHash)
      throw error
    }
  }

  async assignmentNeedsCoordinatorTurn(assignment: AssignmentPlan): Promise<boolean> {
    const immediatelyActionable = assignment.content.tasks.some(
      (task) =>
        task.status === 'ready' ||
        task.status === 'rework' ||
        task.status === 'reported' ||
        task.status === 'attention' ||
        task.status === 'failed' ||
        (task.owner === 'senior' && task.status === 'running')
    )
    if (immediatelyActionable) return true

    const runningWorkers = assignment.content.tasks.filter(
      (task) => task.owner === 'worker' && task.status === 'running'
    )
    if (runningWorkers.length > 0) {
      const workers = await Promise.all(
        runningWorkers.map((task) =>
          task.threadId
            ? this.host.threadManager.getThread(assignment.projectId, task.threadId)
            : Promise.resolve(null)
        )
      )
      return workers.some(
        (worker) =>
          !worker ||
          (worker.status !== 'created' &&
            worker.status !== 'planning' &&
            worker.status !== 'executing')
      )
    }

    return assignment.content.tasks.some((task) => task.status !== 'completed')
  }

  coordinatorAssignmentPrompt(assignment: AssignmentPlan): string {
    const actionableTasks = assignment.content.tasks.filter(
      (task) => task.status !== 'completed' && task.status !== 'blocked'
    )
    return [
      'You are the Sr. Engineer coordinating an approved Assignment. This is a live user-facing coordinator thread: the user can steer or stop you at any time.',
      'Assign ready tasks using the deterministic local API. For a worker task, the API creates and prompts its durable worker thread. For a Sr. Engineer task, the API returns the task and you perform it in this coordinator thread.',
      'When the user changes direction, use the steer-worker or stop-worker endpoint for any affected worker before continuing.',
      'The approved Assignment may include user annotations. Treat every open annotation as a signed correction to its anchored section and incorporate it before dispatching affected work.',
      'Do not assign blocked tasks. When a worker reports, audit its checklist and evidence, then call the review endpoint. A passing review unblocks dependent tasks. A rework review automatically returns the same approved task and your complete review findings to its worker; do not create a replacement Assignment or ask the user to sign off again.',
      'Senior-owned tasks are already approved work. Complete them in this coordinator thread without asking the user for assistant implementation permission. Submit baseline and check evidence with this coordinator thread ID, report the task, and review it before continuing.',
      'A task whose worker crashed or whose deliverable was rejected is marked failed   that is not terminal. A stopped worker leaves an attention task without a report. Re-dispatch either state by calling assign-task again: the API retires the stale worker and returns a fresh worker thread. Attention tasks that contain a report must be reviewed instead.',
      'Task rework remains inside the signed Assignment. Let review-task dispatch it directly. Only propose a new Assignment when the user has requested genuinely new product scope that is not a correction of the approved task.',
      this.host.units['assignment-run'].assignmentApiInstructions(
        this.host.units['assignment-run'].assignmentApiCapability({
          role: 'coordinator',
          assignmentId: assignment.id,
          threadId: assignment.coordinatorThreadId
        })
      ),
      'Approved Assignment:',
      JSON.stringify(
        {
          id: assignment.id,
          version: assignment.version,
          scopeBucketId: assignment.scopeBucketId,
          annotations: (assignment.annotations ?? []).filter(
            (annotation) => annotation.status === 'open'
          ),
          actionableTasks
        },
        null,
        2
      )
    ].join('\n\n')
  }

  async assignmentCoordinatorUserTurnPrompt(
    thread: Thread | null,
    origin: 'user' | 'internal'
  ): Promise<string> {
    if (origin !== 'user' || thread?.assignmentRole !== 'coordinator' || !thread.assignmentId) {
      return ''
    }
    const assignment = this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)
    if (!assignment || assignment.id !== thread.assignmentId || assignment.status === 'completed') {
      return ''
    }
    await this.host.units['assignment-run'].ensureAssignmentApi()
    const token = this.host.units['assignment-run'].assignmentApiCapability({
      role: 'coordinator',
      assignmentId: assignment.id,
      threadId: thread.id
    })
    return [
      'Assignment coordinator delegation policy:',
      'Resolve which Assignment task the user is addressing from tagged task state first, then from an unambiguous task title or worker name in the message.',
      'The application automatically forwards tagged tasks that already have worker threads. When the system prompt includes an application routing receipt, do not call steer-worker again for those tasks.',
      'For an untagged but unambiguous targeted task that already has a worker thread, forward the user’s instruction with steer-worker by default. Do not implement the task in the coordinator thread merely because the user addressed you.',
      'Work on that linked worker task yourself only when the user explicitly says that the Sr. Engineer or coordinator should personally perform the work instead of the assigned worker.',
      'Preserve the user’s intent when forwarding, include any relevant tagged-task context, and never claim that a worker was updated until steer-worker returns successfully.',
      'After a successful steer, tell the user exactly which worker and task were updated and that its live progress is visible in the Assignment coordinator panel, where the worker row opens its thread.',
      'If a targeted task has no worker thread, use the normal dependency and assignment rules; do not call steer-worker without a linked thread.',
      this.host.units['assignment-run'].assignmentApiInstructions(token),
      'Current Assignment routing state:',
      JSON.stringify(
        {
          assignmentId: assignment.id,
          tasks: assignment.content.tasks.map((task) => ({
            id: task.id,
            title: task.title,
            owner: task.owner,
            status: task.status,
            workerName: task.workerName,
            threadId: task.threadId
          }))
        },
        null,
        2
      )
    ].join('\n\n')
  }

  revokeAssignmentCapabilities(assignmentId: string): void {
    for (const [token, capability] of this.host.state.assignmentApiCapabilities) {
      if (capability.assignmentId === assignmentId)
        this.host.state.assignmentApiCapabilities.delete(token)
    }
    this.host.state.assignmentEngine.removeApiCapabilitiesForAssignment(assignmentId)
  }

  /**
   * Generate a reviewable Assignment from the exact active Spec without revising
   * that Spec, or from the thread conversation when no Spec exists. `instructions`
   * is the user's own request for the Assignment and is optional either way.
   */
  async generateAssignmentDraft(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings,
    instructions?: string
  ): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    if (settings.assignmentMode !== true) {
      throw new Error('Assignment mode must be enabled to generate an Assignment.')
    }
    const request =
      instructions === undefined
        ? undefined
        : validateBoundedString(instructions, 'Assignment instructions', 1, 20_000)

    const active = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (active) return active

    const key = `${projectId}:${coordinatorThreadId}`
    const running = this.host.state.activeAssignmentDraftRuns.get(key)
    if (running) return running

    const task = this.createAssignmentDraftFromSource(
      projectId,
      coordinatorThreadId,
      settings,
      request
    )
    this.host.state.activeAssignmentDraftRuns.set(key, task)
    void task.then(
      () => {
        if (this.host.state.activeAssignmentDraftRuns.get(key) === task) {
          this.host.state.activeAssignmentDraftRuns.delete(key)
        }
      },
      () => {
        if (this.host.state.activeAssignmentDraftRuns.get(key) === task) {
          this.host.state.activeAssignmentDraftRuns.delete(key)
        }
      }
    )
    return task
  }

  /**
   * An approved specification is the authoritative source when one exists.
   * Without one the Assignment is decomposed from the thread conversation, so a
   * thread that already describes its work never needs a specification first.
   */
  async createAssignmentDraftFromSource(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings,
    instructions?: string
  ): Promise<AssignmentPlan> {
    const existing = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (existing) return existing

    const spec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    if (spec && spec.status !== 'approved') {
      throw new Error(
        'Approve the specification before generating an Assignment from it, or dismiss the specification to build the Assignment from this conversation.'
      )
    }
    const source: AssignmentGenerationSource = spec
      ? { kind: 'spec', spec }
      : { kind: 'conversation' }

    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'planning', {
      read: false
    })
    try {
      const content = await this.generateAssignmentContent(
        projectId,
        coordinatorThreadId,
        settings,
        source,
        instructions
      )
      const concurrentlyCreated = this.host.state.assignmentEngine.getActive(
        projectId,
        coordinatorThreadId
      )
      if (concurrentlyCreated) {
        await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
          read: false
        })
        return concurrentlyCreated
      }

      if (source.kind === 'spec') {
        const currentSpec = await this.host.units['spec'].getActiveSpec(
          projectId,
          coordinatorThreadId
        )
        if (
          !currentSpec ||
          currentSpec.id !== source.spec.id ||
          currentSpec.version !== source.spec.version
        ) {
          throw new Error(
            'The active specification changed while the Assignment was being generated. Review it and generate the Assignment again.'
          )
        }
      }

      const assignment = await this.persistAssignmentDraft({
        projectId,
        coordinatorThreadId,
        content,
        // A draft that appeared while this graph was being generated is the
        // user's, so it is left in place rather than overwritten.
        replaceDraft: false,
        provenance: {
          source: 'agent',
          actor: 'Sr. Engineer',
          harnessId: settings.harnessId,
          providerId: settings.providerId,
          modelId: settings.modelId
        }
      })
      await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
        read: false
      })
      return assignment
    } catch (error) {
      await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
        read: false
      })
      this.host.units['turns'].markEngineeringLifecycleFailure(
        projectId,
        coordinatorThreadId,
        error
      )
      throw error
    }
  }

  /**
   * Persist a submitted task graph as the thread's unsigned Assignment draft.
   * The approved specification stays the recorded source when one exists; with
   * no specification the conversation is the source and the draft carries none.
   *
   * An existing unsigned draft is replaced only when the caller owns the turn
   * that produced the graph (`replaceDraft`), so a concurrent background run
   * never clobbers it; a signed, running, or completed Assignment is never
   * touched.
   */
  async persistAssignmentDraft(input: {
    projectId: string
    coordinatorThreadId: string
    content: AssignmentPlanContent
    provenance: Pick<
      AssignmentProvenance,
      'source' | 'actor' | 'harnessId' | 'providerId' | 'modelId'
    >
    replaceDraft: boolean
  }): Promise<AssignmentPlan> {
    const { projectId, coordinatorThreadId, content, provenance, replaceDraft } = input
    const spec = await this.host.units['spec'].getActiveSpec(projectId, coordinatorThreadId)
    if (spec && spec.status !== 'approved') {
      throw new Error(
        'Approve the specification before generating an Assignment from it, or dismiss the specification to build the Assignment from this conversation.'
      )
    }
    const existing = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (existing && existing.status !== 'draft') return existing
    const assignment =
      existing === null
        ? await this.host.state.assignmentEngine.createDraft({
            projectId,
            coordinatorThreadId,
            ...(spec ? { specId: spec.id, specVersion: spec.version } : {}),
            content,
            provenance
          })
        : replaceDraft
          ? await this.host.state.assignmentEngine.saveDraft(
              projectId,
              coordinatorThreadId,
              content,
              provenance
            )
          : existing
    const lifecycle = this.host.state.engineeringLifecycleEngine.get(projectId, coordinatorThreadId)
    if (lifecycle?.activeStage === 'assignment') {
      this.host.state.engineeringLifecycleEngine.advance(projectId, coordinatorThreadId, {
        gate: 'assignment_approval'
      })
    }
    return assignment
  }

  async generateAssignmentContent(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings,
    source: AssignmentGenerationSource,
    instructions?: string
  ): Promise<AssignmentPlanContent> {
    const driverId = settings.harnessId || DEFAULT_HARNESS
    const { driver, projectPath } = await this.host.resolve(
      projectId,
      driverId,
      coordinatorThreadId
    )
    const messages = await this.host.threadManager.loadMessageRecords(
      projectId,
      coordinatorThreadId
    )
    const transcript = formatConversationTranscript(messages, { maxCharacters: 80_000 })
    const artifactDirectory = featureArtifactDirectory(
      await ensureFeatureSlug(this.host.database, projectId, coordinatorThreadId)
    )
    const assignmentSystemPrompt = [
      await this.host.units['turns-dispatch'].cioPrompt('assignment-plan'),
      engineeringArtifactBoundaryInstruction(artifactDirectory)
    ].join('\n\n')
    // The specification branch reads the persisted spec by path; the
    // conversation branch has no spec to read, so the transcript is the only
    // authoritative scope and the model verifies it against the project.
    const prompt =
      source.kind === 'spec'
        ? [
            `Create an Assignment graph for the specification at this project-relative path (read it first): ${await this.host.units[
              'media-artifacts'
            ].artifactRef(
              projectId,
              coordinatorThreadId,
              join('versions', `${source.spec.id}-v${source.spec.version}.md`)
            )}`,
            `Open annotations on the specification:\n${formatOpenAnnotations(source.spec.annotations)}`,
            instructions ? `The user's request for this Assignment:\n${instructions}` : '',
            transcript ? `Conversation context:\n${transcript}` : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        : [
            CONVERSATION_ASSIGNMENT_INSTRUCTION,
            instructions ? `The user's request for this Assignment:\n${instructions}` : '',
            transcript
              ? `Conversation context (authoritative scope):\n${transcript}`
              : 'Conversation context (authoritative scope):\n(none recorded)'
          ]
            .filter(Boolean)
            .join('\n\n')
    const structuredOutputKey = `${driverId}:${settings.providerId}:${settings.modelId}`
    const isZenFreeModel =
      driverId === 'opencode' &&
      settings.providerId === 'opencode' &&
      settings.modelId.endsWith('-free')
    const structured =
      driver.capabilities?.structuredOutput === true &&
      !isZenFreeModel &&
      !this.host.state.unsupportedStructuredOutputModels.has(structuredOutputKey)
    let lastError: Error | null = null
    const draftKey = `${projectId}:${coordinatorThreadId}`

    for (const useStructuredOutput of structured ? [true, false] : [false]) {
      const isolated = supportsIsolatedSessions(driver)
        ? await driver.createIsolatedSession(
            projectPath,
            `Assignment draft ${new Date().toISOString()}`
          )
        : undefined
      const sessionId =
        isolated?.sessionId ??
        (await driver.createSession(projectPath, `Assignment draft ${new Date().toISOString()}`))
      this.host.registerSession(
        sessionId,
        projectId,
        coordinatorThreadId,
        projectPath,
        'auto_review',
        driverId,
        undefined,
        true
      )
      this.host.state.activeAssignmentDraftSessions.set(draftKey, {
        sessionId,
        driver,
        driverId,
        projectPath,
        ...(isolated ? { isolated } : {})
      })
      const completion = this.host.units['turns-sessions'].waitForSessionCompletion(
        sessionId,
        180_000,
        'Assignment generation'
      )
      try {
        const request: SendPromptOptions = {
          sessionId,
          settings: {
            ...settings,
            permissionLevel: 'auto_review',
            assignmentMode: false,
            loopMode: false
          },
          text: prompt,
          attachments: [],
          systemPrompt: assignmentSystemPrompt,
          allowedTools: PROMPT_READ_ONLY_TOOLS,
          ...(useStructuredOutput
            ? { structuredOutput: { schema: ASSIGNMENT_PLAN_SCHEMA, retryCount: 2 } }
            : {})
        }
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.sendPrompt(projectPath, request, isolated)
        } else {
          await driver.sendPrompt(projectPath, request)
        }
        const streamed = await completion
        if (streamed !== undefined) return parseGeneratedAssignmentContent(streamed)
        const generated =
          isolated && supportsIsolatedSessions(driver)
            ? await driver.loadMessages(projectPath, sessionId, isolated)
            : await driver.loadMessages(projectPath, sessionId)
        const response = [...generated].reverse().find((message) => message.role === 'assistant')
        if (!response) throw new Error('The Sr. Engineer returned no Assignment')
        if (response.error) throw new Error(response.error)
        if (response.structuredOutput !== undefined) {
          return parseGeneratedAssignmentContent(response.structuredOutput)
        }
        const text = response.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        return parseGeneratedAssignmentContent(
          parseGeneratedJson(text, 'The Sr. Engineer returned invalid Assignment JSON')
        )
      } catch (error) {
        if (isolated && supportsIsolatedSessions(driver)) {
          await driver.abort(projectPath, sessionId, isolated).catch(() => undefined)
        } else {
          await driver.abort(projectPath, sessionId).catch(() => undefined)
        }
        lastError = error instanceof Error ? error : new Error('Assignment generation failed.')
        if (this.host.state.userAbortedAssignmentDraftOperations.delete(draftKey)) throw lastError
        if (useStructuredOutput) {
          this.host.state.unsupportedStructuredOutputModels.add(structuredOutputKey)
          Logger.info('Structured Assignment generation failed; using JSON-only output:', {
            driverId,
            providerId: settings.providerId,
            modelId: settings.modelId,
            error: lastError.message
          })
        }
      } finally {
        await this.host.units['messages-write'].recordEphemeralSessionUsage({
          projectId,
          threadId: coordinatorThreadId,
          sessionId,
          projectPath,
          driver,
          isolated
        })
        this.host.units['runtime-connectivity'].clearCompletionWaiter(sessionId)
        this.host.sessionRegistry.delete(sessionId)
        this.host.state.reasoningTimes.delete(sessionId)
        this.host.state.toolTimes.delete(sessionId)
        if (isolated && supportsIsolatedSessions(driver)) driver.disposeIsolatedSession(isolated)
        if (this.host.state.activeAssignmentDraftSessions.get(draftKey)?.sessionId === sessionId) {
          this.host.state.activeAssignmentDraftSessions.delete(draftKey)
        }
      }
    }
    throw lastError ?? new Error('Assignment generation failed.')
  }

  /**
   * The Sr. Engineer coordinator that owns the workflow `thread` belongs to, or
   * `null` when the thread is not part of a coordinated workflow.
   *
   * A coordinator is its own root. A worker or auditor walks up its
   * `coordinatorThreadId` chain, which is one hop for every workflow the app
   * creates and is walked transitively only to stay correct if a sub-agent ever
   * dispatches one of its own. Pass `threads` to resolve from an already-loaded
   * snapshot instead of reading again.
   */
  async workflowCoordinatorFor(
    projectId: string,
    thread: Thread,
    threads?: Thread[]
  ): Promise<string | null> {
    if (threads) return resolveWorkflowCoordinatorThreadId(threads, thread.id)
    if (isWorkflowCoordinatorThread(thread)) return thread.id
    const seen = new Set<string>([thread.id])
    let current: Thread | undefined = thread
    while (current?.coordinatorThreadId) {
      const parentId = current.coordinatorThreadId
      if (seen.has(parentId)) return null
      seen.add(parentId)
      const parent = await this.host.threadManager.getThread(projectId, parentId)
      if (!parent) return parentId
      if (isWorkflowCoordinatorThread(parent)) return parent.id
      current = parent
    }
    return null
  }

  readPendingAssignmentTurn(
    projectId: string,
    threadId: string
  ): Promise<PendingAssignmentTurn | null> {
    return this.host.storage.read<PendingAssignmentTurn>(
      pendingAssignmentTurnPath(projectId, threadId)
    )
  }

  writePendingAssignmentTurn(pending: PendingAssignmentTurn): Promise<void> {
    return this.host.storage.write(
      pendingAssignmentTurnPath(pending.projectId, pending.threadId),
      pending
    )
  }

  clearPendingAssignmentTurn(projectId: string, threadId: string): Promise<void> {
    return this.host.storage.remove(pendingAssignmentTurnPath(projectId, threadId))
  }

  /**
   * Capture an Assignment the agent submitted inside its own conversational
   * turn. A turn that ends without a submission is the interview outcome, never
   * a failure: the agent asked the user the task-graph questions the source
   * could not answer, and the conversation continues with the answers.
   */
  async persistPendingAssignmentTurn(
    sessionId: string,
    loadedMessages?: AgentMessage[],
    scope?: { projectId: string; threadId: string }
  ): Promise<AssignmentPlan | null> {
    const pending =
      this.host.state.pendingAssignmentTurns.get(sessionId) ??
      (scope ? await this.readPendingAssignmentTurn(scope.projectId, scope.threadId) : null)
    if (!pending || pending.sessionId !== sessionId) return null
    this.host.state.pendingAssignmentTurns.delete(sessionId)
    await this.clearPendingAssignmentTurn(pending.projectId, pending.threadId)

    // Re-derive the turn intent before touching anything. A record retained
    // across a question-tool turn is consumed by the next finalization for this
    // session, which may belong to a later stage once the Assignment was signed
    // off or the lifecycle moved on, and creating a draft there would be wrong.
    const turnLifecycle = this.host.state.engineeringLifecycleEngine.get(
      pending.projectId,
      pending.threadId
    )
    if (
      turnLifecycle?.activeStage !== 'assignment' &&
      turnLifecycle?.humanGate !== 'assignment_approval'
    ) {
      return null
    }

    const driver = this.host.units['turns-dispatch'].driverForRuntime(
      pending.harnessId,
      this.host.sessionRegistry.get(sessionId)?.accountId
    )
    if (!driver) throw new Error(`Unknown harness: ${pending.harnessId}`)
    const projectPath =
      this.host.sessionRegistry.get(sessionId)?.projectPath ??
      (await this.host.resolveThreadPath(pending.projectId, pending.threadId))
    const messages = loadedMessages ?? (await driver.loadMessages(projectPath, sessionId))
    const response = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!response) return null
    if (response.error) throw new Error(response.error)
    const text = response.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    // No decodable JSON object in the answer is the interview outcome: the agent
    // asked its questions or narrated instead of submitting, so nothing is
    // captured and nothing failed. A decodable object that then fails Assignment
    // validation is a rejected submission and throws below.
    let submitted: unknown
    if (response.structuredOutput === undefined) {
      try {
        submitted = parseGeneratedJson(text, 'The Assignment agent returned invalid JSON')
      } catch (error) {
        if (error instanceof GeneratedJsonParseError) return null
        throw error
      }
    } else {
      submitted = response.structuredOutput
    }
    const content = parseGeneratedAssignmentContent(submitted)
    const assignment = await this.persistAssignmentDraft({
      projectId: pending.projectId,
      coordinatorThreadId: pending.threadId,
      content,
      // The agent owns the turn that produced this graph, so an unsigned draft it
      // is re-deriving is replaced instead of left stale.
      replaceDraft: true,
      provenance: {
        source: 'agent',
        actor: 'Sr. Engineer',
        harnessId: pending.harnessId,
        ...(pending.providerId ? { providerId: pending.providerId } : {}),
        ...(pending.modelId ? { modelId: pending.modelId } : {})
      }
    })
    this.host.broadcast({
      type: 'assignment.ready',
      sessionId,
      projectId: pending.projectId,
      threadId: pending.threadId,
      assignmentId: assignment.id,
      version: assignment.version
    })
    return assignment
  }

  /** Bubble the active isolated Assignment draft up to its coordinator thread:
   *  any offshoot session of the Sr. Engineer must stay visible there while it
   *  works. Mirrors the specification-generation trace forwarding. */
  forwardAssignmentDraftTrace(owner: SessionInfo, event: AgentEvent): void {
    if (!owner.ephemeral || !('sessionId' in event)) return
    const key = `${owner.projectId}:${owner.threadId}`
    const active = this.host.state.activeAssignmentDraftSessions.get(key)
    if (!active || active.sessionId !== event.sessionId) return

    if (event.type === 'session.idle' || event.type === 'session.error') {
      this.host.broadcast({
        type: 'assignment.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: { type: 'completed' }
      })
      return
    }

    if (event.type === 'message.part.delta') {
      this.host.broadcast({
        type: 'assignment.trace',
        sessionId: event.sessionId,
        projectId: owner.projectId,
        threadId: owner.threadId,
        update: {
          type: 'part.delta',
          partId: `${event.sessionId}:${event.partId}`,
          field: event.field,
          delta: event.delta
        }
      })
      return
    }

    if (event.type !== 'message.part.updated') return
    const sourcePart = event.part
    if (!['reasoning', 'tool', 'subagent', 'step-finish'].includes(sourcePart.type)) return
    this.host.broadcast({
      type: 'assignment.trace',
      sessionId: event.sessionId,
      projectId: owner.projectId,
      threadId: owner.threadId,
      update: {
        type: 'part.updated',
        part: { ...sourcePart, id: `${event.sessionId}:${sourcePart.id}` }
      }
    })
  }
}
