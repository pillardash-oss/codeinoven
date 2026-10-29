import { join, resolve } from 'path'
import { createHash, randomInt } from 'crypto'
import { Logger } from '../../system/logger'
import { broadcastThreadUpdate, notifyIndependentAudit } from '../thread-events'
import {
  validateBoundedString,
  validateEntityId,
  validateThreadSettings
} from '../../ipc/ipc-validation'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { UtilityTurnBudgetContext } from '../../utilities/utility-orchestration-service'
import type {
  AgentMessage,
  AssignmentPlan,
  AssignmentTaskReport,
  AuditGenerationRequest,
  AuditReport,
  AuditReportContent,
  EngineeringSpec,
  Thread,
  ThreadSettings
} from '../../../lib/types'
import { isOrchestrationChildThread } from '../../../lib/types'
import { workflowActionPresentation } from '../../../lib/workflow-action-presentation'
import { ensureFeatureSlug, requireLocalProject } from '../../../lib/project-artifacts'
import type { AssignmentAuditRepairManifest } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { formatOpenAnnotations } from './chat-engine-prompts'
import { isRecord } from './chat-engine-generated-artifacts'
import { auditRequiresRework } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine audit: one concern, moved verbatim from the composition root. */
export class ChatEngineAudit {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Prepare the app utility gateway for one audit turn. Every audit dispatch
   * path (independent, implementation, achievement, Assignment) routes through
   * this shared helper so the auditor always reaches cio_util_find / activate
   * / invoke (and any MCP-backed knowledge utility such as framework docs)
   * exactly like a regular project thread. On preparation failure the
   * instructions carry the limitation note the auditor must record in its
   * report instead of silently auditing without the gateway.
   */
  async prepareAuditUtilities(
    driver: HarnessDriver,
    projectId: string,
    auditorThread: Thread,
    sessionId: string,
    projectPath: string,
    settings: ThreadSettings,
    budgetContext: UtilityTurnBudgetContext
  ): Promise<{ instructions: string; runtimeAvailable: boolean }> {
    try {
      const instructions = await this.host.units['utilities'].prepareTurnUtilities(
        driver,
        projectId,
        auditorThread.id,
        sessionId,
        projectPath,
        settings,
        budgetContext,
        auditorThread.title,
        auditorThread.scopeBucketId
      )
      return { instructions, runtimeAvailable: Boolean(instructions) }
    } catch (error) {
      Logger.error('Audit utility preparation failed', {
        projectId,
        threadId: auditorThread.id,
        sessionId,
        error: rawErrorMessage(error)
      })
      return {
        instructions: `The app utility gateway could not be prepared for this audit: ${rawErrorMessage(error)}. Record this exact limitation in verification.utilities and verification.limitations.`,
        runtimeAvailable: false
      }
    }
  }

  /** Turn-scoped utility gateway cleanup shared by every audit dispatch path. */
  async cleanupAuditUtilities(
    scope: string,
    projectId: string,
    coordinatorThreadId: string,
    auditorThreadId: string,
    sessionId: string
  ): Promise<void> {
    await this.host.units['utilities'].cleanupTurnUtilities(sessionId).catch((error) => {
      Logger.error(`${scope} audit utility cleanup failed`, {
        projectId,
        threadId: coordinatorThreadId,
        auditorThreadId,
        error: rawErrorMessage(error)
      })
    })
  }

  async implementationAuditEligible(thread: Thread | null): Promise<boolean> {
    if (!thread?.settings) return false
    if (
      this.host.units['turns'].engineeringLifecycleActive(thread.projectId, thread.id) ||
      thread.settings.loopMode
    ) {
      return true
    }
    if (
      this.host.state.assignmentEngine.getActive(thread.projectId, thread.id)?.status ===
      'completed'
    )
      return true
    return (
      (await this.host.units['brainstorm'].implementationBrainstormContract(
        thread.projectId,
        thread.id
      )) !== null
    )
  }

  async promptCoordinatorForAudit(
    assignment: AssignmentPlan,
    taskId: string,
    report: AssignmentTaskReport
  ): Promise<void> {
    const coordinator = await this.host.threadManager.getThread(
      assignment.projectId,
      assignment.coordinatorThreadId
    )
    if (!coordinator?.settings) return
    const task = assignment.content.tasks.find((candidate) => candidate.id === taskId)
    await this.host.units['assignment'].sendAssignmentCoordinatorPrompt(
      assignment,
      coordinator.settings,
      [
        `Worker ${task?.workerName ?? task?.threadId ?? taskId} reported task “${task?.title ?? taskId}”.`,
        'Inspect the worker thread, project changes, audit-checklist.md, baseline.txt, and check.txt. Correctly audit every checklist item.',
        'Call the review-task API with pass, rework, or fail. If it passes, assign every newly ready task returned by the API. If you mark it fail, re-dispatch it immediately with assign-task so a fresh worker retries it   a failed task is not terminal.',
        this.host.units['assignment-run'].assignmentApiInstructions(
          this.host.units['assignment-run'].assignmentApiCapability({
            role: 'coordinator',
            assignmentId: assignment.id,
            threadId: assignment.coordinatorThreadId
          })
        ),
        JSON.stringify({ assignmentId: assignment.id, task, report }, null, 2)
      ].join('\n\n')
    )
  }

  async generateAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<AuditReport> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const settings = validateThreadSettings(request.settings)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread?.settings || !(await this.implementationAuditEligible(thread))) {
      throw new Error(
        'Implementation audits require Engineering, Achievement, or a completed Assignment'
      )
    }
    const completedAssignment = this.host.state.assignmentEngine.getActive(projectId, threadId)
    if (completedAssignment?.status === 'completed') {
      return (await this.host.generateAssignmentAudit(projectId, threadId, settings)).report
    }
    if (thread?.settings?.loopMode === true && !completedAssignment) {
      return (await this.host.generateAchievementAudit(projectId, threadId, settings)).report
    }
    const key = `${projectId}:${threadId}`
    const running = this.host.state.activeImplementationAuditRuns.get(key)
    if (running) return (await running).report
    const run = this.host.units['audit-run'].runImplementationAudit(projectId, threadId, settings)
    this.host.state.activeImplementationAuditRuns.set(key, run)
    try {
      return (await run).report
    } finally {
      if (this.host.state.activeImplementationAuditRuns.get(key) === run) {
        this.host.state.activeImplementationAuditRuns.delete(key)
      }
    }
  }

  async ensureImplementationAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const key = `${projectId}:${coordinatorThreadId}`
    const running = this.host.state.activeImplementationAuditorEnsures.get(key)
    if (running) return running
    const task = this.createOrUpdateImplementationAuditor(projectId, coordinatorThreadId, settings)
    this.host.state.activeImplementationAuditorEnsures.set(key, task)
    try {
      return await task
    } finally {
      if (this.host.state.activeImplementationAuditorEnsures.get(key) === task) {
        this.host.state.activeImplementationAuditorEnsures.delete(key)
      }
    }
  }

  async createOrUpdateImplementationAuditor(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new Error('Engineering audit coordinator not found.')
    if (!(await this.implementationAuditEligible(coordinator))) {
      throw new Error('An approved Engineering implementation is required before audit.')
    }
    if (this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)) {
      throw new Error('Assignment audits use their Assignment auditor thread.')
    }
    if (coordinator.settings?.loopMode === true) {
      throw new Error('Achievement audits use their Achievement Auditor thread.')
    }
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
    let auditor = coordinator.auditorThreadId
      ? await this.host.threadManager.getThread(projectId, coordinator.auditorThreadId)
      : null
    if (
      !auditor ||
      auditor.achievementRole !== 'auditor' ||
      auditor.coordinatorThreadId !== coordinatorThreadId
    ) {
      auditor =
        (await this.host.threadManager.listThreads(projectId)).find(
          (candidate) =>
            candidate.achievementRole === 'auditor' &&
            candidate.coordinatorThreadId === coordinatorThreadId
        ) ?? null
    }
    if (!auditor) {
      const names = await this.host.storage.getWorkerNames()
      const name = names[randomInt(names.length)]
      auditor = await this.host.threadManager.createThread({
        projectId,
        providerId: auditorSettings.providerId,
        title: `audit-${name}: ${coordinator.title}`,
        titleSource: 'manual',
        settings: auditorSettings,
        featureSlug: coordinator.featureSlug,
        scopeBucketId: coordinator.scopeBucketId,
        workingDirectory: coordinator.workingDirectory,
        coordinatorThreadId,
        achievementRole: 'auditor',
        userInputLocked: true
      })
    }
    if (
      auditor.sessionId &&
      auditor.settings?.harnessId &&
      auditor.settings.harnessId !== auditorSettings.harnessId
    ) {
      await this.host.units['utilities'].cleanupTurnUtilities(auditor.sessionId)
      this.host.units['turns-sessions'].retireSessionState(auditor.sessionId)
      await this.host.threadManager.clearSessionId(projectId, auditor.id)
    }
    await this.host.threadManager.updateSettings(projectId, auditor.id, auditorSettings)
    await this.host.threadManager.updateThread(projectId, auditor.id, {
      achievementRole: 'auditor',
      coordinatorThreadId,
      scopeBucketId: coordinator.scopeBucketId,
      userInputLocked: true
    })
    await this.host.threadManager.updateThread(projectId, coordinatorThreadId, {
      auditorThreadId: auditor.id
    })
    return (await this.host.threadManager.getThread(projectId, auditor.id)) ?? auditor
  }

  /**
   * Run an independent (spec-less) audit: the thread's own request/output
   * transcript is the contract, and the auditor verifies claims against the
   * repository with read-only tools plus evidence-backed checks.
   */
  async generateIndependentAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const settings = validateThreadSettings(request.settings)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread || thread.independentAudit !== true) {
      throw new Error('Independent audit is not enabled for this thread.')
    }
    if (isOrchestrationChildThread(thread)) {
      throw new Error('Independent audit is not available on orchestration threads.')
    }
    const key = `${projectId}:${threadId}`
    const running = this.host.state.activeIndependentAuditRuns.get(key)
    if (running) return running
    const run = this.host.units['audit-run'].runIndependentAudit(projectId, threadId, settings)
    this.host.state.activeIndependentAuditRuns.set(key, run)
    try {
      return await run
    } finally {
      if (this.host.state.activeIndependentAuditRuns.get(key) === run) {
        this.host.state.activeIndependentAuditRuns.delete(key)
      }
    }
  }

  /**
   * Delete the durable auditor thread that owns this coordinator's independent
   * audits. The next audit then creates a brand-new auditor session instead of
   * resuming the deleted one. Reports live on the coordinator thread, so the
   * report history is preserved.
   */
  async deleteIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<void> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator || coordinator.independentAudit !== true) {
      throw new Error('Independent audit is not enabled for this thread.')
    }
    if (this.host.state.activeIndependentAuditRuns.has(`${projectId}:${coordinatorThreadId}`)) {
      throw new Error('The independent audit is still running.')
    }
    await this.removeIndependentAuditorThread(projectId, coordinatorThreadId, coordinator)
  }

  /**
   * Start a brand-new independent audit with a fresh auditor thread.
   *
   * The auditor session is deliberately durable across audits: it resumes its
   * own context so a rework pass can verify the previous findings. That also
   * means a thread that gets stuck, keeps failing validation, or drifts stays
   * that way. This replaces it: the previous auditor thread is deleted and a
   * new auditor is created for a fresh independent audit of the same work. The
   * coordinator keeps its report lineage, so a new auditor still reads the
   * previous report and verifies the rework against it when one exists, and
   * audits the thread transcript alone when it does not.
   */
  async startFreshIndependentAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const settings = validateThreadSettings(request.settings)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread || thread.independentAudit !== true) {
      throw new Error('Independent audit is not enabled for this thread.')
    }
    if (isOrchestrationChildThread(thread)) {
      throw new Error('Independent audit is not available on orchestration threads.')
    }
    if (this.host.state.activeIndependentAuditRuns.has(`${projectId}:${threadId}`)) {
      throw new Error('The independent audit is still running.')
    }
    await this.removeIndependentAuditorThread(projectId, threadId, thread)
    return this.host.generateIndependentAudit(projectId, threadId, { settings })
  }

  async ensureIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const key = `${projectId}:${coordinatorThreadId}`
    const running = this.host.state.activeIndependentAuditorEnsures.get(key)
    if (running) return running
    const task = this.createOrUpdateIndependentAuditor(projectId, coordinatorThreadId, settings)
    this.host.state.activeIndependentAuditorEnsures.set(key, task)
    try {
      return await task
    } finally {
      if (this.host.state.activeIndependentAuditorEnsures.get(key) === task) {
        this.host.state.activeIndependentAuditorEnsures.delete(key)
      }
    }
  }

  /**
   * The durable auditor thread that owns independent audits for this
   * coordinator: the recorded pointer when it still resolves to a live auditor,
   * otherwise the matching orchestration child looked up by coordinator id.
   * Returns null when the coordinator has no auditor yet, or any more.
   */
  async findIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    coordinator?: Thread
  ): Promise<Thread | null> {
    const owner =
      coordinator ?? (await this.host.threadManager.getThread(projectId, coordinatorThreadId))
    if (!owner) return null
    if (owner.auditorThreadId) {
      const auditor = await this.host.threadManager.getThread(projectId, owner.auditorThreadId)
      if (
        auditor &&
        auditor.achievementRole === 'auditor' &&
        auditor.coordinatorThreadId === coordinatorThreadId
      ) {
        return auditor
      }
    }
    const candidates = await this.host.threadManager.listThreads(projectId)
    return (
      candidates.find(
        (candidate) =>
          candidate.achievementRole === 'auditor' &&
          candidate.coordinatorThreadId === coordinatorThreadId
      ) ?? null
    )
  }

  /**
   * Delete the durable auditor thread for an independent audit coordinator, so
   * the next audit starts from a brand-new auditor session. Reports are stored
   * on the coordinator thread, so the report lineage is untouched.
   */
  async removeIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    coordinator: Thread
  ): Promise<void> {
    const auditor = await this.findIndependentAuditorThread(
      projectId,
      coordinatorThreadId,
      coordinator
    )
    if (!auditor) return
    await this.host.threadManager.deleteThread(projectId, auditor.id)
  }

  async createOrUpdateIndependentAuditor(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator || coordinator.independentAudit !== true) {
      throw new Error('Independent audit is not enabled for this thread.')
    }
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
    let auditor = await this.findIndependentAuditorThread(
      projectId,
      coordinatorThreadId,
      coordinator
    )
    if (!auditor) {
      const names = await this.host.storage.getWorkerNames()
      const name = names[randomInt(names.length)]
      auditor = await this.host.threadManager.createThread({
        projectId,
        providerId: auditorSettings.providerId,
        title: `audit-${name}: ${coordinator.title}`,
        titleSource: 'manual',
        settings: auditorSettings,
        featureSlug: coordinator.featureSlug,
        scopeBucketId: coordinator.scopeBucketId,
        workingDirectory: coordinator.workingDirectory,
        coordinatorThreadId,
        achievementRole: 'auditor',
        userInputLocked: true
      })
    }
    if (
      auditor.sessionId &&
      auditor.settings?.harnessId &&
      auditor.settings.harnessId !== auditorSettings.harnessId
    ) {
      await this.host.units['utilities'].cleanupTurnUtilities(auditor.sessionId)
      this.host.units['turns-sessions'].retireSessionState(auditor.sessionId)
      await this.host.threadManager.clearSessionId(projectId, auditor.id)
    }
    await this.host.threadManager.updateSettings(projectId, auditor.id, auditorSettings)
    await this.host.threadManager.updateThread(projectId, auditor.id, {
      achievementRole: 'auditor',
      coordinatorThreadId,
      scopeBucketId: coordinator.scopeBucketId,
      userInputLocked: true
    })
    await this.host.threadManager.updateThread(projectId, coordinatorThreadId, {
      auditorThreadId: auditor.id
    })
    return (await this.host.threadManager.getThread(projectId, auditor.id)) ?? auditor
  }

  /** Route an independent audit completion through the coordinator thread's
   *  notification channel, mirroring the temporary-chat completion path. */
  async notifyIndependentAuditCompletion(
    projectId: string,
    coordinatorThreadId: string,
    kind: 'completed' | 'error',
    errorDetail?: string
  ): Promise<void> {
    try {
      const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
      if (!coordinator) return
      notifyIndependentAudit(coordinator, kind, errorDetail)
    } catch (error) {
      Logger.dev('Independent audit notification dispatch failed:', error)
    }
  }

  async ensureAchievementAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const key = `${projectId}:${coordinatorThreadId}`
    const running = this.host.state.activeAchievementAuditorEnsures.get(key)
    if (running) return running
    const task = this.createOrUpdateAchievementAuditor(projectId, coordinatorThreadId, settings)
    this.host.state.activeAchievementAuditorEnsures.set(key, task)
    try {
      return await task
    } finally {
      if (this.host.state.activeAchievementAuditorEnsures.get(key) === task) {
        this.host.state.activeAchievementAuditorEnsures.delete(key)
      }
    }
  }

  async createOrUpdateAchievementAuditor(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const scopedCoordinator = await this.host.ensureAchievementScope(projectId, coordinatorThreadId)
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
    let auditor = scopedCoordinator.auditorThreadId
      ? await this.host.threadManager.getThread(projectId, scopedCoordinator.auditorThreadId)
      : null
    if (
      !auditor ||
      auditor.achievementRole !== 'auditor' ||
      auditor.coordinatorThreadId !== coordinatorThreadId
    ) {
      auditor =
        (await this.host.threadManager.listThreads(projectId)).find(
          (candidate) =>
            candidate.achievementRole === 'auditor' &&
            candidate.coordinatorThreadId === coordinatorThreadId
        ) ?? null
    }
    if (!auditor) {
      const names = await this.host.storage.getWorkerNames()
      const name = names[randomInt(names.length)]
      auditor = await this.host.threadManager.createThread({
        projectId,
        providerId: auditorSettings.providerId,
        title: `audit-${name}: ${scopedCoordinator.title}`,
        titleSource: 'manual',
        settings: auditorSettings,
        featureSlug: scopedCoordinator.featureSlug,
        scopeBucketId: scopedCoordinator.scopeBucketId,
        workingDirectory: scopedCoordinator.workingDirectory,
        coordinatorThreadId,
        achievementRole: 'auditor',
        userInputLocked: true
      })
    }
    if (
      auditor.sessionId &&
      auditor.settings?.harnessId &&
      auditor.settings.harnessId !== auditorSettings.harnessId
    ) {
      await this.host.units['utilities'].cleanupTurnUtilities(auditor.sessionId)
      this.host.units['turns-sessions'].retireSessionState(auditor.sessionId)
      await this.host.threadManager.clearSessionId(projectId, auditor.id)
    }
    await this.host.threadManager.updateSettings(projectId, auditor.id, auditorSettings)
    await this.host.threadManager.updateThread(projectId, auditor.id, {
      achievementRole: 'auditor',
      coordinatorThreadId,
      scopeBucketId: scopedCoordinator.scopeBucketId,
      userInputLocked: true
    })
    await this.host.threadManager.updateThread(projectId, coordinatorThreadId, {
      achievementRole: 'coordinator',
      auditorThreadId: auditor.id
    })
    return (await this.host.threadManager.getThread(projectId, auditor.id)) ?? auditor
  }

  async ensureAssignmentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
    const auditor = await this.host.state.assignmentEngine.ensureAuditorThread(
      projectId,
      coordinatorThreadId,
      auditorSettings
    )
    if (
      auditor.sessionId &&
      auditor.settings?.harnessId &&
      auditor.settings.harnessId !== auditorSettings.harnessId
    ) {
      await this.host.units['utilities'].cleanupTurnUtilities(auditor.sessionId)
      this.host.units['turns-sessions'].retireSessionState(auditor.sessionId)
      await this.host.threadManager.clearSessionId(projectId, auditor.id)
    }
    await this.host.threadManager.updateSettings(projectId, auditor.id, auditorSettings)
    await this.host.threadManager.updateThread(projectId, auditor.id, { userInputLocked: true })
    return (await this.host.threadManager.getThread(projectId, auditor.id)) ?? auditor
  }

  async startAssignmentReaudit(
    assignment: AssignmentPlan,
    fallbackSettings?: ThreadSettings
  ): Promise<void> {
    const [auditor, coordinator] = await Promise.all([
      assignment.auditorThreadId
        ? this.host.threadManager.getThread(assignment.projectId, assignment.auditorThreadId)
        : Promise.resolve(null),
      this.host.threadManager.getThread(assignment.projectId, assignment.coordinatorThreadId)
    ])
    const settings = auditor?.settings ?? fallbackSettings ?? coordinator?.settings
    if (!settings) throw new Error('Assignment auditor settings are missing')
    await this.host.generateAssignmentAudit(
      assignment.projectId,
      assignment.coordinatorThreadId,
      settings
    )
  }

  async resumeInterruptedAssignmentAudit(
    assignment: AssignmentPlan,
    fallbackSettings?: ThreadSettings
  ): Promise<void> {
    try {
      Logger.info('Resuming interrupted Assignment audit', {
        projectId: assignment.projectId,
        threadId: assignment.coordinatorThreadId,
        assignmentId: assignment.id,
        auditorThreadId: assignment.auditorThreadId,
        startedAt: assignment.auditCycle?.startedAt
      })
      await this.startAssignmentReaudit(assignment, fallbackSettings)
    } catch (error) {
      const failure = rawErrorMessage(error)
      Logger.error('Interrupted Assignment audit recovery failed', {
        projectId: assignment.projectId,
        threadId: assignment.coordinatorThreadId,
        auditorThreadId: assignment.auditorThreadId,
        error: failure
      })
      const current = this.host.state.assignmentEngine.getActive(
        assignment.projectId,
        assignment.coordinatorThreadId
      )
      if (current?.status === 'completed' && current.auditCycle?.status === 'running') {
        await this.host.state.assignmentEngine.failAuditCycle(
          assignment.projectId,
          assignment.coordinatorThreadId,
          failure
        )
        await this.host.threadManager.setAuditState(
          assignment.projectId,
          assignment.coordinatorThreadId,
          'offered'
        )
        await this.host.threadManager.setStatus(
          assignment.projectId,
          assignment.coordinatorThreadId,
          'spec',
          { read: false }
        )
        if (assignment.auditorThreadId) {
          await this.host.threadManager.setStatus(
            assignment.projectId,
            assignment.auditorThreadId,
            'failed',
            { read: false }
          )
        }
      }
    }
  }

  async generateAssignmentAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (!assignment || assignment.status !== 'completed') {
      throw new Error('A completed Assignment is required before its durable audit can start.')
    }
    const key = `${projectId}:${assignment.id}`
    const existing = this.host.state.activeAssignmentAuditRuns.get(key)
    if (existing) return existing
    this.host.state.stoppedAssignmentAuditRuns.delete(key)
    const run = this.host.units['audit-run'].runAssignmentAudit(
      projectId,
      coordinatorThreadId,
      settings
    )
    this.host.state.activeAssignmentAuditRuns.set(key, run)
    try {
      return await run
    } finally {
      if (this.host.state.activeAssignmentAuditRuns.get(key) === run) {
        this.host.state.activeAssignmentAuditRuns.delete(key)
      }
    }
  }

  async generateAchievementAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    settings = validateThreadSettings(settings)
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (assignment) {
      if (assignment.status !== 'completed') {
        throw new Error('Achievement waits for its signed-off Assignment to complete before audit.')
      }
      return this.host.generateAssignmentAudit(projectId, coordinatorThreadId, settings)
    }
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (coordinator?.settings?.loopMode !== true) {
      throw new Error('Achievement must be enabled before its durable audit can start.')
    }
    const key = `${projectId}:${coordinatorThreadId}`
    const running = this.host.state.activeAchievementAuditRuns.get(key)
    if (running) return running
    const run = this.host.units['audit-run'].runAchievementAudit(
      projectId,
      coordinatorThreadId,
      settings
    )
    this.host.state.activeAchievementAuditRuns.set(key, run)
    try {
      return await run
    } finally {
      if (this.host.state.activeAchievementAuditRuns.get(key) === run) {
        this.host.state.activeAchievementAuditRuns.delete(key)
      }
    }
  }

  async submitAchievementAuditFeedback(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number,
    feedback: string
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    reportId = validateEntityId(reportId, 'Audit report ID')
    if (!Number.isSafeInteger(reportVersion) || reportVersion < 1) {
      throw new TypeError('Audit report version must be a positive integer')
    }
    feedback = validateBoundedString(feedback, 'Audit feedback', 0, 20_000)
    if (this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)) {
      throw new Error('Assignment-backed Achievement uses Assignment audit feedback.')
    }
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new Error('No coordinator thread exists for this audit.')
    const { settings, achievement } = await this.resolveAuditReviewContext(
      projectId,
      coordinatorThreadId,
      coordinator,
      ['report_ready', 'reworking']
    )
    if (
      coordinator.activeAuditId !== reportId ||
      coordinator.activeAuditVersion !== reportVersion ||
      (coordinator.auditState !== 'report_ready' && coordinator.auditState !== 'reworking')
    ) {
      throw new Error('The selected audit report is not ready for feedback.')
    }
    const report = this.host.state.auditEngine
      .listVersions(projectId, coordinatorThreadId, reportId)
      .find((candidate) => candidate.version === reportVersion)
    if (!report)
      throw new Error(
        achievement ? 'Achievement audit report not found.' : 'Audit report not found.'
      )

    const handoffDigest = createHash('sha256')
      .update(
        JSON.stringify({
          reportId: report.id,
          reportVersion: report.version,
          feedback,
          annotations: report.annotations
        })
      )
      .digest('hex')
      .slice(0, 16)
    const marker = `[achievement-audit-rework:${report.id}:v${report.version}:${handoffDigest}]`
    const messages = await this.host.threadManager.loadMessageRecords(
      projectId,
      coordinatorThreadId
    )
    const alreadyNotified = messages.some((message) =>
      (message.transportParts ?? message.parts).some(
        (part) => part.type === 'text' && part.text.includes(marker)
      )
    )
    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'reworking', {
      id: report.id,
      version: report.version
    })
    if (!alreadyNotified) {
      const auditPath = await this.host.units['media-artifacts'].artifactRef(
        report.projectId,
        report.threadId,
        join('versions', `${report.id}-audit-v${report.version}.md`)
      )
      await this.host.sendPrompt(
        projectId,
        coordinatorThreadId,
        settings,
        [
          marker,
          'The Auditor findings and the user rework request require implementation corrections.',
          achievement
            ? 'Digest every actionable finding, open audit annotation, and user note. Implement the corrections in this Sr. Engineer thread, run focused verification, then allow Achievement to audit again.'
            : 'Digest every actionable finding, open audit annotation, and user note. Implement the corrections in this Sr. Engineer thread, run focused verification, then request a fresh audit when ready.',
          ...(achievement
            ? [await this.host.units['turns-dispatch'].cioPrompt('achievement-implementation')]
            : []),
          ...(report.brainstormId && report.brainstormVersion
            ? [
                `Implementation contract: ${await this.host.units['media-artifacts'].artifactRef(projectId, coordinatorThreadId, join('versions', `${report.brainstormId}-v${report.brainstormVersion}-brainstorm.md`))}. Use this finalized Brainstorm for the corrections.`
              ]
            : []),
          `Audit report: ${auditPath}`,
          `User feedback:\n${feedback.trim()}`,
          `Open audit annotations:\n${formatOpenAnnotations(report.annotations)}`
        ].join('\n\n'),
        [],
        'implement',
        undefined,
        undefined,
        undefined,
        undefined,
        'internal',
        workflowActionPresentation(
          achievement
            ? `Apply Achievement audit v${report.version}`
            : `Apply audit v${report.version}`,
          feedback
        )
      )
    }
    return (await this.host.threadManager.getThread(projectId, coordinatorThreadId)) ?? coordinator
  }

  /**
   * Classifies a coordinator thread for an audit review action (feedback or
   * return-to-offer). A durable Achievement cycle that outlived its Achievement
   * switch (the loop toggle can flip off mid-review while a `report_ready`
   * report persists) stays recoverable: an explicit review action on a persisted
   * report reactivates Achievement instead of wedging the review surface
   * forever. A plain implementation audit that was never run under Achievement
   * stays plain: the review proceeds without touching loopMode, because audits
   * must be reviewable without Achievement turned on.
   */
  async resolveAuditReviewContext(
    projectId: string,
    coordinatorThreadId: string,
    coordinator: Thread,
    reviewableStates: readonly NonNullable<Thread['auditState']>[]
  ): Promise<{ settings: ThreadSettings; achievement: boolean }> {
    const settings = coordinator.settings
    if (!settings) throw new Error('The coordinator thread has no settings to review against.')
    if (settings.loopMode === true) return { settings, achievement: true }
    const revivable =
      coordinator.achievementRole === 'coordinator' &&
      coordinator.activeAuditId !== undefined &&
      coordinator.auditState !== undefined &&
      reviewableStates.includes(coordinator.auditState)
    if (revivable) {
      const revived = { ...settings, loopMode: true }
      await this.host.threadManager.updateSettings(projectId, coordinatorThreadId, revived)
      return { settings: revived, achievement: true }
    }
    const plainReviewable =
      coordinator.activeAuditId !== undefined &&
      coordinator.auditState !== undefined &&
      reviewableStates.includes(coordinator.auditState)
    if (!plainReviewable) {
      throw new Error('No audit report is awaiting review on this thread.')
    }
    return { settings, achievement: false }
  }

  async returnAchievementAuditToOffer(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<Thread> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    if (this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)) {
      throw new Error('Assignment-backed Achievement uses the Assignment audit lifecycle.')
    }
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new Error('No coordinator thread exists for this audit.')
    await this.resolveAuditReviewContext(projectId, coordinatorThreadId, coordinator, [
      'offered',
      'report_ready',
      'reworking'
    ])
    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'offered')
    await this.host.threadManager.setStatus(projectId, coordinatorThreadId, 'spec', {
      read: false
    })
    return (await this.host.threadManager.getThread(projectId, coordinatorThreadId)) ?? coordinator
  }

  async submitAssignmentAuditFeedback(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number,
    feedback: string
  ): Promise<AssignmentPlan> {
    projectId = validateEntityId(projectId, 'Project ID')
    coordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
    reportId = validateEntityId(reportId, 'Audit report ID')
    if (!Number.isSafeInteger(reportVersion) || reportVersion < 1) {
      throw new TypeError('Audit report version must be a positive integer')
    }
    feedback = validateBoundedString(feedback, 'Audit feedback', 0, 20_000)
    const assignment = this.host.state.assignmentEngine.getActive(projectId, coordinatorThreadId)
    if (
      !assignment ||
      !['completed', 'running'].includes(assignment.status) ||
      !assignment.auditCycle ||
      !['report_ready', 'planning_rework'].includes(assignment.auditCycle.status) ||
      assignment.auditCycle.reportId !== reportId ||
      assignment.auditCycle.reportVersion !== reportVersion
    ) {
      throw new Error('The selected Assignment audit report is not ready for feedback.')
    }
    const report = this.host.state.auditEngine
      .listVersions(projectId, coordinatorThreadId, reportId)
      .find((candidate) => candidate.version === reportVersion)
    if (!report) throw new Error('Assignment audit report not found.')

    const updated = await this.host.state.assignmentEngine.beginAuditRework(
      projectId,
      coordinatorThreadId
    )
    await this.host.threadManager.setAuditState(projectId, coordinatorThreadId, 'reworking', {
      id: report.id,
      version: report.version
    })
    const coordinator = await this.host.threadManager.getThread(projectId, coordinatorThreadId)
    if (!coordinator?.settings) throw new Error('Sr. Engineer settings are missing.')
    const handoffDigest = createHash('sha256')
      .update(
        JSON.stringify({
          reportId: report.id,
          reportVersion: report.version,
          feedback,
          annotations: report.annotations
        })
      )
      .digest('hex')
      .slice(0, 16)
    const marker = `[assignment-audit-rework:${report.id}:v${report.version}:${handoffDigest}]`
    const coordinatorMessages = await this.host.threadManager.loadMessageRecords(
      projectId,
      coordinatorThreadId
    )
    const alreadyNotified = coordinatorMessages.some((message) =>
      (message.transportParts ?? message.parts).some(
        (part) => part.type === 'text' && part.text.includes(marker)
      )
    )
    if (!alreadyNotified) {
      await this.host.units['assignment-run'].ensureAssignmentApi()
      const coordinatorToken = this.host.units['assignment-run'].assignmentApiCapability({
        role: 'coordinator',
        assignmentId: updated.id,
        threadId: coordinatorThreadId
      })
      const auditPath = await this.host.units['media-artifacts'].artifactRef(
        report.projectId,
        report.threadId,
        join('versions', `${report.id}-audit-v${report.version}.md`)
      )
      await this.host.sendPrompt(
        projectId,
        coordinatorThreadId,
        coordinator.settings,
        [
          marker,
          `Audit report v${report.version} and the user's rework request are ready for your decision. No new Assignment version has been created.`,
          'You are the Sr. Engineer. First digest the audit findings, open annotations, and user feedback below, then explain your proposed response in this coordinator conversation.',
          'Apply the corrections without another user approval gate. Use reopen-task for completed tasks that require correction and add-followup-task only when an audit finding genuinely needs an additional task; assign every ready worker task immediately. Perform senior-owned corrections here. Call request-reaudit only after every correction and focused check is complete. Never call propose-rework-assignment for audit findings or corrective rework.',
          this.host.units['assignment-run'].assignmentApiInstructions(coordinatorToken),
          `Assignment ${updated.id} v${updated.version}`,
          `Audit report: ${auditPath}`,
          `User feedback:\n${feedback.trim()}`,
          `Open audit annotations:\n${formatOpenAnnotations(report.annotations)}`
        ].join('\n\n'),
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'internal',
        workflowActionPresentation(`Rework from audit report v${report.version}`, feedback)
      )
    }
    return updated
  }

  async readAssignmentAuditRepairManifest(
    projectId: string,
    threadId: string
  ): Promise<AssignmentAuditRepairManifest | null> {
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, threadId)
    const raw = await this.host.storage.readProjectSpecRaw(
      projectId,
      featureSlug,
      join('audit', 'latest-repair.json'),
      requireLocalProject(this.host.database, projectId)
    )
    if (raw === null) return null
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
    if (
      !isRecord(value) ||
      value['schemaVersion'] !== 1 ||
      (value['status'] !== 'invalid' && value['status'] !== 'valid') ||
      typeof value['projectId'] !== 'string' ||
      typeof value['threadId'] !== 'string' ||
      typeof value['assignmentId'] !== 'string' ||
      typeof value['specId'] !== 'string' ||
      typeof value['specVersion'] !== 'number' ||
      typeof value['runId'] !== 'string' ||
      typeof value['attempt'] !== 'number' ||
      typeof value['attemptPath'] !== 'string' ||
      !Array.isArray(value['errors']) ||
      !value['errors'].every((error) => typeof error === 'string') ||
      (value['previousErrors'] !== undefined &&
        (!Array.isArray(value['previousErrors']) ||
          !value['previousErrors'].every((error) => typeof error === 'string'))) ||
      typeof value['updatedAt'] !== 'number'
    ) {
      return null
    }
    return {
      schemaVersion: 1,
      status: value['status'],
      projectId: value['projectId'],
      threadId: value['threadId'],
      assignmentId: value['assignmentId'],
      specId: value['specId'],
      specVersion: value['specVersion'],
      runId: value['runId'],
      attempt: value['attempt'],
      attemptPath: value['attemptPath'],
      errors: value['errors'],
      ...(value['previousErrors'] !== undefined ? { previousErrors: value['previousErrors'] } : {}),
      updatedAt: value['updatedAt']
    }
  }

  async completeAssignmentAudit(input: {
    projectId: string
    coordinatorThreadId: string
    /** Approved specification, or null for a spec-less Assignment audit. */
    spec: EngineeringSpec | null
    assignment: AssignmentPlan
    content: AuditReportContent
    auditorThread: Thread
    auditorSettings: ThreadSettings
    /** Partial evidence-validation stamp for reports persisted after the
     *  evidence matcher could still not back every claim. */
    evidenceValidation?: AuditReport['evidenceValidation']
    evidenceIssues?: string[]
  }): Promise<{ report: AuditReport; auditorThread: Thread }> {
    const report = await this.host.state.auditEngine.create({
      projectId: input.projectId,
      threadId: input.coordinatorThreadId,
      ...(input.spec ? { specId: input.spec.id, specVersion: input.spec.version } : {}),
      assignmentId: input.assignment.id,
      assignmentVersion: input.assignment.version,
      reworkCycle: input.assignment.auditCycle?.reworkCycle,
      content: input.content,
      outcome: auditRequiresRework(input.content) ? 'rework_required' : 'passed',
      evidenceValidation: input.evidenceValidation,
      evidenceIssues: input.evidenceIssues,
      provenance: {
        source: 'agent',
        actor: 'auditor',
        harnessId: input.auditorSettings.harnessId,
        providerId: input.auditorSettings.providerId,
        modelId: input.auditorSettings.modelId
      }
    })
    await this.host.state.assignmentEngine.reportAuditCycle(
      input.projectId,
      input.coordinatorThreadId,
      report.id,
      report.version
    )
    await this.host.threadManager.setAuditState(
      input.projectId,
      input.coordinatorThreadId,
      'report_ready',
      { id: report.id, version: report.version }
    )
    await this.host.threadManager.setStatus(input.projectId, input.auditorThread.id, 'completed', {
      read: false
    })
    await this.host.threadManager.setStatus(input.projectId, input.coordinatorThreadId, 'spec', {
      read: false
    })
    await this.host.loadMessages(input.projectId, input.auditorThread.id)
    return {
      report,
      auditorThread:
        (await this.host.threadManager.getThread(input.projectId, input.auditorThread.id)) ??
        input.auditorThread
    }
  }

  async loopAuditSettings(settings: ThreadSettings): Promise<ThreadSettings> {
    const configuredAuditor = (await this.host.storage.getConfig()).agentDefaults.auditor
    return {
      ...settings,
      ...(settings.loopAuditor ?? configuredAuditor ?? {}),
      permissionLevel: 'auto_review',
      loopMode: false,
      loopAuditor: undefined
    }
  }

  /** Re-announce the coordinator thread so every view of its Assignment plan
   *  reconciles after an audit-cycle transition. The renderer keys the audit
   *  cards   the Sr. Engineer's and the auditor's   off that one plan, so this is
   *  what keeps the two connected. */
  async reannounceAssignmentAudit(plan: AssignmentPlan): Promise<void> {
    try {
      const thread = await this.host.threadManager.getThread(
        plan.projectId,
        plan.coordinatorThreadId
      )
      if (thread) broadcastThreadUpdate(thread)
    } catch (error) {
      Logger.dev('Assignment audit reannounce failed:', error)
    }
  }

  // ─── History mirror ───────────────────────────────────────────────────────

  async notifyCoordinatorOfAssignmentAuditFeedback(
    auditor: Thread,
    response: AgentMessage | undefined
  ): Promise<void> {
    if (
      !response ||
      response.error ||
      !auditor.assignmentId ||
      !auditor.coordinatorThreadId ||
      auditor.assignmentRole === 'worker'
    ) {
      return
    }
    const assignment = this.host.state.assignmentEngine.getActive(
      auditor.projectId,
      auditor.coordinatorThreadId
    )
    if (
      !assignment ||
      assignment.id !== auditor.assignmentId ||
      assignment.auditorThreadId !== auditor.id ||
      assignment.status !== 'completed' ||
      assignment.auditCycle?.status !== 'reworking'
    ) {
      return
    }
    const coordinator = await this.host.threadManager.getThread(
      auditor.projectId,
      auditor.coordinatorThreadId
    )
    if (!coordinator?.settings) return
    const marker = `[assignment-audit-feedback:${response.id}]`
    const coordinatorMessages = await this.host.threadManager.loadMessageRecords(
      auditor.projectId,
      coordinator.id
    )
    const directHandoffMarker = assignment.auditCycle.reportId
      ? `[assignment-audit-rework:${assignment.auditCycle.reportId}:v${assignment.auditCycle.reportVersion}:`
      : null
    if (
      directHandoffMarker &&
      coordinatorMessages.some((message) =>
        (message.transportParts ?? message.parts).some(
          (part) => part.type === 'text' && part.text.includes(directHandoffMarker)
        )
      )
    ) {
      return
    }
    const alreadyNotified = coordinatorMessages.some((message) =>
      (message.transportParts ?? message.parts).some(
        (part) => part.type === 'text' && part.text.includes(marker)
      )
    )
    if (alreadyNotified) return
    const responseText = response.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (!responseText) return
    await this.host.units['assignment-run'].ensureAssignmentApi()
    const coordinatorToken = this.host.units['assignment-run'].assignmentApiCapability({
      role: 'coordinator',
      assignmentId: assignment.id,
      threadId: coordinator.id
    })
    await this.host.sendPrompt(
      auditor.projectId,
      coordinator.id,
      coordinator.settings,
      [
        marker,
        'The dedicated Assignment auditor reviewed the user’s audit feedback and returned the rework directive below.',
        'Decide surgically whether each correction belongs to you, an existing worker, or a new worker. Use reopen-task for completed tasks that need more work, add-followup-task only for genuinely new scope, then assign every ready worker task. You may implement senior-owned tasks yourself. Keep the user informed through this coordinator conversation. When every rework task passes review, the Assignment will offer another audit automatically.',
        this.host.units['assignment-run'].assignmentApiInstructions(coordinatorToken),
        JSON.stringify(
          {
            assignmentId: assignment.id,
            auditCycle: assignment.auditCycle,
            auditorThreadId: auditor.id,
            auditorDirective: responseText
          },
          null,
          2
        )
      ].join('\n\n'),
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'internal',
      {
        action: 'Auditor requested rework',
        body: responseText.slice(0, 20_000)
      }
    )
  }
}
