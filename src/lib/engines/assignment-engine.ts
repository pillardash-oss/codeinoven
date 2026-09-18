import { createHash, randomInt } from 'crypto'
import type { Database } from '../../main/database/database'
import { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { AssignmentApiCapabilityRow } from '../../main/database/repositories/assignment-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import type { StorageEngine } from '../../main/storage/storage-engine'
import type {
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentProvenance,
  AssignmentModelSelection,
  AssignmentFollowUpTaskInput,
  AssignmentTask,
  AssignmentTaskReport,
  AssignmentTaskReview,
  AssignmentToolResult,
  Thread,
  ThreadSettings
} from '../types'
import { DEFAULT_SCOPE_BUCKET_ID, workerReportsToCoordinator } from '../types'
import { generateId } from '../utils'
import { validateAssignment } from '../assignment/assignment-validation'
import { ThreadManager } from './thread-manager'
import type { SpecEngine } from './spec-engine'
import { AssignmentEngineError } from './assignment-engine-error'
import {
  AssignmentAnnotations,
  type AddAssignmentAnnotationInput
} from './assignment-engine-annotations'
import { AssignmentArtifactWriter } from './assignment-engine-artifacts'
import { AssignmentAuditCycleBook } from './assignment-engine-audit-cycle'
import {
  requireActivePlan,
  requirePlanById,
  requireTaskInPlan
} from './assignment-engine-plan-lookup'
import { buildCoordinatorSnapshotJson } from './assignment-engine-snapshot'
import {
  allTasksCompleted,
  anyTaskFailed,
  buildActivationTaskGraph,
  buildFollowUpTask,
  buildReopenedTask,
  buildResumedTasks,
  buildReworkAmendedContent,
  buildReworkDraftTasks,
  buildReviewedTask,
  buildSteeredTasks,
  buildStoppedTasks,
  completedTaskIds,
  dependencyStatus,
  deriveReworkCycle,
  deriveResumedStatus,
  planStatusAfterSteer,
  restoreStoppedAuditCycle,
  unblockDependentTasks
} from './assignment-engine-tasks'
import { AssignmentWorkerSelection, buildWorkerPrompt } from './assignment-engine-workers'

export { AssignmentEngineError } from './assignment-engine-error'
export type { AddAssignmentAnnotationInput } from './assignment-engine-annotations'
export { ASSIGNMENT_WORKER_INSTRUCTION } from './assignment-engine-workers'

type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>

export interface CreateAssignmentInput {
  projectId: string
  coordinatorThreadId: string
  /** Approved specification this Assignment implements. Omit both fields when the
   *  Assignment was decomposed from the thread conversation instead. */
  specId?: string
  specVersion?: number
  content: AssignmentPlanContent
  provenance: NewAssignmentProvenance
}

export class AssignmentEngine {
  private readonly repo: AssignmentRepo
  private readonly threads: ThreadManager
  private readonly artifacts: AssignmentArtifactWriter
  private readonly workers: AssignmentWorkerSelection
  private readonly annotations: AssignmentAnnotations
  private readonly auditCycle: AssignmentAuditCycleBook

  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly idFactory: () => string = generateId,
    private readonly randomIndex: (upperBound: number) => number = randomInt
  ) {
    this.repo = new AssignmentRepo(db)
    this.threads = new ThreadManager(db)
    this.artifacts = new AssignmentArtifactWriter(storage, db)
    this.workers = new AssignmentWorkerSelection(this.repo, this.threads, storage, randomIndex)
    this.annotations = new AssignmentAnnotations(this.repo, this.artifacts, now, idFactory)
    this.auditCycle = new AssignmentAuditCycleBook(this.repo, this.artifacts, now)
  }

  async createDraft(input: CreateAssignmentInput): Promise<AssignmentPlan> {
    const coordinator = await this.threads.getThread(input.projectId, input.coordinatorThreadId)
    if (!coordinator || coordinator.projectId !== input.projectId) {
      throw new AssignmentEngineError(
        'unauthorized',
        'Coordinator thread does not belong to the project'
      )
    }
    if (input.specId !== undefined) {
      if (input.specVersion === undefined) {
        throw new AssignmentEngineError(
          'validation_failed',
          'A linked specification requires its version'
        )
      }
      const spec = this.db.get<{ project_id: string; thread_id: string }>(
        'SELECT project_id, thread_id FROM spec_versions WHERE spec_id=? AND version=?',
        input.specId,
        input.specVersion
      )
      if (
        !spec ||
        spec.project_id !== input.projectId ||
        spec.thread_id !== input.coordinatorThreadId
      ) {
        throw new AssignmentEngineError(
          'unauthorized',
          'Linked specification does not belong to the coordinator'
        )
      }
    }
    const validation = validateAssignment(input.content)
    if (!validation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        validation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const now = this.now()
    const assignment: AssignmentPlan = {
      schemaVersion: 1,
      id: this.idFactory(),
      projectId: input.projectId,
      coordinatorThreadId: input.coordinatorThreadId,
      ...(input.specId !== undefined
        ? { specId: input.specId, specVersion: input.specVersion }
        : {}),
      version: 1,
      status: 'draft',
      content: structuredClone(input.content),
      annotations: [],
      provenance: { ...input.provenance, createdAt: now },
      createdAt: now,
      updatedAt: now
    }
    await this.persist(assignment)
    return assignment
  }

  getActive(projectId: string, coordinatorThreadId: string): AssignmentPlan | null {
    return this.repo.getActive(projectId, coordinatorThreadId)
  }

  listVersions(assignmentId: string): AssignmentPlan[] {
    return this.repo.listVersions(assignmentId)
  }

  async addAnnotation(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number,
    input: AddAssignmentAnnotationInput
  ): Promise<AssignmentPlan> {
    return this.annotations.add(projectId, coordinatorThreadId, assignmentId, version, input)
  }

  async updateAnnotation(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<AssignmentPlan> {
    return this.annotations.update(
      projectId,
      coordinatorThreadId,
      assignmentId,
      version,
      annotationId,
      body
    )
  }

  async resolveAnnotation(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number,
    annotationId: string
  ): Promise<AssignmentPlan> {
    return this.annotations.resolve(
      projectId,
      coordinatorThreadId,
      assignmentId,
      version,
      annotationId
    )
  }

  /** Atomically claim the current durable coordinator state for one automatic prompt. */
  async claimCoordinatorSnapshot(assignmentId: string): Promise<string | null> {
    const plan = this.requireById(assignmentId)
    if (plan.status === 'stopped') return null
    const snapshotJson = buildCoordinatorSnapshotJson(
      plan,
      await this.threads.listThreads(plan.projectId)
    )
    const snapshotHash = createHash('sha256').update(snapshotJson).digest('hex')
    return this.repo.claimCoordinatorSnapshot(plan.id, snapshotHash, snapshotJson)
      ? snapshotHash
      : null
  }

  releaseCoordinatorSnapshot(assignmentId: string, snapshotHash: string): void {
    this.repo.releaseCoordinatorSnapshot(assignmentId, snapshotHash)
  }

  /** Mark the state reached by a completed coordinator turn as already observed. */
  async rememberCoordinatorSnapshot(assignmentId: string): Promise<void> {
    await this.claimCoordinatorSnapshot(assignmentId)
  }

  /** Durable loopback port for the Assignment API (survives app restarts). */
  saveApiPort(port: number): void {
    this.repo.saveApiPort(port)
  }

  loadApiPort(): number | null {
    return this.repo.loadApiPort()
  }

  /** Persist a capability token so in-flight harness sessions survive restarts. */
  saveApiCapability(token: string, capability: AssignmentApiCapabilityRow): void {
    this.repo.saveApiCapability(token, capability)
  }

  /** Restore every persisted capability token after a restart. */
  loadApiCapabilities(): Map<string, AssignmentApiCapabilityRow> {
    return this.repo.loadApiCapabilities()
  }

  /** Drop every capability token when an Assignment is explicitly stopped. */
  removeApiCapabilitiesForAssignment(assignmentId: string): void {
    this.repo.removeApiCapabilitiesForAssignment(assignmentId)
  }

  /** Revoke completed workers while the coordinator continues into independent audit. */
  removeWorkerApiCapabilitiesForAssignment(assignmentId: string): void {
    this.repo.removeWorkerApiCapabilitiesForAssignment(assignmentId)
  }

  /** Revoke the durable capability of a worker that is no longer assigned. */
  removeApiCapabilitiesForThread(assignmentId: string, threadId: string): void {
    this.repo.removeApiCapabilitiesForThread(assignmentId, threadId)
  }

  /** Revoke one stale durable capability discovered during request validation. */
  removeApiCapability(token: string): void {
    this.repo.removeApiCapability(token)
  }

  async markdownPath(projectId: string, coordinatorThreadId: string): Promise<string> {
    return this.artifacts.markdownPath(projectId, coordinatorThreadId)
  }

  async saveDraft(
    projectId: string,
    coordinatorThreadId: string,
    content: AssignmentPlanContent,
    provenance: NewAssignmentProvenance
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'draft') {
      throw new AssignmentEngineError('immutable', 'Approved assignments cannot be edited')
    }
    const validation = validateAssignment(content)
    if (!validation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        validation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const now = this.now()
    const next: AssignmentPlan = {
      ...active,
      version: active.version + 1,
      content: structuredClone(content),
      provenance: {
        ...provenance,
        parentVersion: active.version,
        createdAt: now
      },
      updatedAt: now
    }
    await this.persist(next)
    return next
  }

  async syncDraftToSpec(
    projectId: string,
    coordinatorThreadId: string,
    specId: string,
    specVersion: number,
    content: AssignmentPlanContent,
    provenance: NewAssignmentProvenance
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'draft') {
      throw new AssignmentEngineError('immutable', 'Approved assignments cannot be edited')
    }
    const spec = this.db.get<{ project_id: string; thread_id: string }>(
      'SELECT project_id, thread_id FROM spec_versions WHERE spec_id=? AND version=?',
      specId,
      specVersion
    )
    if (!spec || spec.project_id !== projectId || spec.thread_id !== coordinatorThreadId) {
      throw new AssignmentEngineError(
        'unauthorized',
        'Linked specification does not belong to the coordinator'
      )
    }
    const validation = validateAssignment(content)
    if (!validation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        validation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const now = this.now()
    const next: AssignmentPlan = {
      ...active,
      specId,
      specVersion,
      version: active.version + 1,
      content: structuredClone(content),
      provenance: {
        ...provenance,
        parentVersion: active.version,
        createdAt: now
      },
      updatedAt: now
    }
    await this.persist(next)
    return next
  }

  async activate(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'draft') return active
    const validation = validateAssignment(active.content)
    if (!validation.valid) {
      throw new AssignmentEngineError('validation_failed', 'Assignment graph is invalid')
    }

    const now = this.now()
    const coordinator = await this.threads.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new AssignmentEngineError('not_found', 'Coordinator not found')
    // Orchestration stays inside whatever workspace scope the coordinator
    // already uses (project root or a managed worktree); workers and the
    // auditor inherit it through `scopeBucketId`. No dedicated bucket is
    // created and the coordinator is never moved between scopes.
    const scopeBucketId = coordinator.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    const tasks = buildActivationTaskGraph(active)
    const approved: AssignmentPlan = {
      ...active,
      status: 'approved',
      scopeBucketId,
      content: { ...active.content, tasks },
      ...(active.auditCycle?.status === 'awaiting_rework_approval'
        ? {
            auditCycle: {
              ...active.auditCycle,
              status: 'reworking' as const,
              reworkStartedAt: active.auditCycle.reworkStartedAt ?? now
            }
          }
        : {}),
      approvedAt: now,
      updatedAt: now
    }

    await this.artifacts.writeMarkdown(approved)
    this.db.transaction(() => {
      this.repo.save(approved, approved.version)
      new ThreadRepo(this.db).upsert({
        ...coordinator,
        assignmentId: active.id,
        assignmentRole: 'coordinator',
        // Normalized to the default only when unset; an existing custom or
        // managed-worktree scope is preserved untouched.
        scopeBucketId: coordinator.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID,
        userInputLocked: false,
        pinned: true,
        // The thread upsert never refreshes `pinned_at` on conflict, so the pin
        // time has to be stamped here: without it the row lands pinned with a
        // NULL pin time and sorts last in the Pinned slice. A thread the user
        // already pinned keeps its original pin time.
        pinnedAt: coordinator.pinnedAt ?? now,
        updatedAt: now
      })
    })
    return approved
  }

  /** Permanently stop orchestration without deleting its reviewable history. */
  async stop(
    projectId: string,
    coordinatorThreadId: string,
    loopModeBeforeStop = false
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status === 'stopped') return active
    if (active.status === 'draft') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'A draft Assignment has not started and cannot be stopped'
      )
    }
    if (active.status === 'completed' && active.auditCycle?.status === 'completed') {
      throw new AssignmentEngineError('invalid_transition', 'The Assignment is already complete')
    }

    const now = this.now()
    const stopped: AssignmentPlan = {
      ...active,
      status: 'stopped',
      statusBeforeStop: active.status,
      loopModeBeforeStop,
      content: {
        ...active.content,
        tasks: buildStoppedTasks(active.content.tasks)
      },
      ...(active.auditCycle && active.auditCycle.status !== 'completed'
        ? {
            auditCycle: {
              ...active.auditCycle,
              status: 'stopped' as const,
              statusBeforeStop:
                active.auditCycle.status === 'stopped'
                  ? (active.auditCycle.statusBeforeStop ?? 'available')
                  : active.auditCycle.status
            }
          }
        : {}),
      completedAt: undefined,
      stoppedAt: now,
      updatedAt: now
    }
    this.repo.save(stopped, active.version)
    this.removeApiCapabilitiesForAssignment(stopped.id)
    await this.artifacts.writeMarkdown(stopped)
    return stopped
  }

  /** Restore a stopped Assignment to a safe, explicitly user-requested continuation state. */
  async resume(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'stopped') {
      throw new AssignmentEngineError('invalid_transition', 'The Assignment is not stopped')
    }

    const tasks = buildResumedTasks(active.content.tasks)
    const resumedStatus = deriveResumedStatus(active, tasks)
    const auditCycle = restoreStoppedAuditCycle(active.auditCycle)
    const resumed: AssignmentPlan = {
      ...active,
      status: resumedStatus,
      statusBeforeStop: undefined,
      content: { ...active.content, tasks },
      auditCycle,
      stoppedAt: undefined,
      updatedAt: this.now()
    }
    this.repo.save(resumed, active.version)
    await this.artifacts.writeMarkdown(resumed)
    return resumed
  }

  /**
   * Sign off the active Assignment. A spec-backed Assignment approves its linked
   * specification first; a spec-less Assignment (decomposed from the
   * conversation) has nothing to approve and activates directly.
   */
  async approve(
    projectId: string,
    coordinatorThreadId: string,
    specEngine: SpecEngine
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.specId !== undefined && active.specVersion !== undefined) {
      const spec = await specEngine.getVersion(
        projectId,
        coordinatorThreadId,
        active.specId,
        active.specVersion
      )
      if (!spec) throw new AssignmentEngineError('not_found', 'Linked specification not found')
      if (spec.status === 'draft') {
        await specEngine.setReview(projectId, coordinatorThreadId, spec.id, spec.version)
      }
      if (spec.status !== 'approved') {
        await specEngine.approve(projectId, coordinatorThreadId, spec.id, spec.version)
      }
    }
    return this.activate(projectId, coordinatorThreadId)
  }

  /**
   * Update the selected model for a signed-off worker task before it has a
   * durable worker thread. Once assigned, the thread owns its own settings.
   */
  async updateUnlinkedWorkerModel(
    projectId: string,
    coordinatorThreadId: string,
    taskId: string,
    model: AssignmentModelSelection
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (!['approved', 'running', 'attention'].includes(active.status)) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Worker models can only be updated on an active signed-off Assignment'
      )
    }
    const task = this.requireTask(active, taskId)
    if (task.owner !== 'worker') {
      throw new AssignmentEngineError('invalid_transition', 'Only worker tasks have worker models')
    }
    if (task.threadId) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'The worker has already been assigned; update its thread settings instead'
      )
    }

    return this.replaceTask(active, { ...task, model: structuredClone(model) }, active.status)
  }

  /** Create or reuse the durable auditor assigned to a completed Assignment. */
  async ensureAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'An Assignment auditor is available only after the Assignment completes'
      )
    }
    if (active.auditorThreadId) {
      const existing = await this.threads.getThread(projectId, active.auditorThreadId)
      if (
        existing &&
        existing.assignmentId === active.id &&
        existing.coordinatorThreadId === coordinatorThreadId &&
        existing.assignmentRole === undefined
      ) {
        return existing
      }
    }

    const coordinator = await this.threads.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new AssignmentEngineError('not_found', 'Coordinator not found')
    const auditorName = await this.workers.auditorName(active)
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
    const auditor = await this.threads.createThread({
      projectId,
      providerId: auditorSettings.providerId,
      title: `${auditorName}: ${active.content.title}`,
      titleSource: 'manual',
      settings: auditorSettings,
      featureSlug: coordinator.featureSlug,
      scopeBucketId: active.scopeBucketId,
      workingDirectory: coordinator.workingDirectory,
      assignmentId: active.id,
      coordinatorThreadId,
      userInputLocked: true
    })
    const updated: AssignmentPlan = {
      ...active,
      auditorThreadId: auditor.id,
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return auditor
  }

  async beginAuditCycle(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    return this.auditCycle.begin(projectId, coordinatorThreadId)
  }

  async failAuditCycle(
    projectId: string,
    coordinatorThreadId: string,
    failure: string
  ): Promise<AssignmentPlan> {
    return this.auditCycle.fail(projectId, coordinatorThreadId, failure)
  }

  async reportAuditCycle(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number
  ): Promise<AssignmentPlan> {
    return this.auditCycle.report(projectId, coordinatorThreadId, reportId, reportVersion)
  }

  async beginAuditRework(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    return this.auditCycle.beginRework(projectId, coordinatorThreadId)
  }

  async proposeAuditReworkDraft(
    projectId: string,
    coordinatorThreadId: string,
    content: AssignmentPlanContent,
    provenance: NewAssignmentProvenance
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status === 'draft' && active.auditCycle?.status === 'awaiting_rework_approval') {
      return active
    }
    const auditRework =
      active.status === 'completed' && active.auditCycle?.status === 'planning_rework'
    const scopeRepair =
      ['approved', 'running', 'attention'].includes(active.status) &&
      active.content.tasks.some((task) => task.status === 'rework')
    if (!auditRework && !scopeRepair) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'The Sr. Engineer can propose rework only for an active rework task or after audit feedback is submitted'
      )
    }
    if (
      scopeRepair &&
      active.content.tasks.some((task) => ['running', 'reported', 'auditing'].includes(task.status))
    ) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Stop or review active tasks before proposing a scope repair'
      )
    }
    const validation = validateAssignment(content)
    if (!validation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        validation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const now = this.now()
    const nextVersion = active.version + 1
    const reworkCycle = deriveReworkCycle(auditRework, active.auditCycle?.reworkCycle)
    if (scopeRepair) {
      const proposedTaskIds = new Set(content.tasks.map((task) => task.id))
      const missingTask = active.content.tasks.find((task) => !proposedTaskIds.has(task.id))
      if (missingTask) {
        throw new AssignmentEngineError(
          'validation_failed',
          `Scope repair must preserve existing task ${missingTask.id}`
        )
      }
    }
    const amendedContent = buildReworkAmendedContent(active.content, content, scopeRepair)
    const amendedValidation = validateAssignment(amendedContent)
    if (!amendedValidation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        amendedValidation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const draft: AssignmentPlan = {
      ...active,
      version: nextVersion,
      status: 'draft',
      content: {
        ...amendedContent,
        tasks: buildReworkDraftTasks(amendedContent, scopeRepair, reworkCycle, nextVersion)
      },
      auditCycle: {
        ...(active.auditCycle ?? {}),
        status: 'awaiting_rework_approval',
        scopeRepair,
        reworkStartedAt: active.auditCycle?.reworkStartedAt ?? now,
        reworkCycle,
        reworkAssignmentVersion: nextVersion
      },
      provenance: {
        ...provenance,
        parentVersion: active.version,
        createdAt: now
      },
      approvedAt: undefined,
      completedAt: undefined,
      updatedAt: now
    }
    await this.persist(draft)
    return draft
  }

  async completeAuditCycle(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    return this.auditCycle.complete(projectId, coordinatorThreadId)
  }

  async makeAuditAvailable(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    return this.auditCycle.makeAvailable(projectId, coordinatorThreadId)
  }

  async reopenCompletedTask(
    projectId: string,
    coordinatorThreadId: string,
    taskId: string
  ): Promise<AssignmentPlan> {
    const active = await this.requireAuditRework(this.requireActive(projectId, coordinatorThreadId))
    const task = this.requireTask(active, taskId)
    if (task.status !== 'completed') {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${taskId} is ${task.status}, not completed`
      )
    }
    const updatedTask = buildReopenedTask(task, active.auditCycle?.reworkCycle ?? 1, active.version)
    const updated: AssignmentPlan = {
      ...active,
      status: 'running',
      completedAt: undefined,
      content: {
        ...active.content,
        tasks: active.content.tasks.map((candidate) =>
          candidate.id === task.id ? updatedTask : candidate
        )
      },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  async appendFollowUpTask(
    projectId: string,
    coordinatorThreadId: string,
    input: AssignmentFollowUpTaskInput
  ): Promise<AssignmentPlan> {
    const active = await this.requireAuditRework(this.requireActive(projectId, coordinatorThreadId))
    const reworkCycle = active.auditCycle?.reworkCycle ?? 1
    const task = buildFollowUpTask(input, reworkCycle, active.version)
    const validation = validateAssignment({
      ...active.content,
      tasks: [...active.content.tasks, task]
    })
    if (!validation.valid) {
      throw new AssignmentEngineError(
        'validation_failed',
        validation.issues.map((issue) => issue.message).join('; ')
      )
    }
    const status = dependencyStatus(task.dependsOn, completedTaskIds(active.content.tasks))
    const updated: AssignmentPlan = {
      ...active,
      status: 'running',
      completedAt: undefined,
      content: { ...active.content, tasks: [...active.content.tasks, { ...task, status }] },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  async assignTask(
    assignmentId: string,
    taskId: string,
    operationId: string
  ): Promise<AssignmentToolResult> {
    const existingOperation = this.repo.getOperation(operationId, assignmentId, 'assign_task')
    if (existingOperation) return { ...existingOperation, idempotent: true }

    const active = this.requireById(assignmentId)
    const task = this.requireTask(active, taskId)
    const retryingStoppedTask = task.status === 'attention' && task.report === undefined
    if (!['ready', 'rework', 'failed'].includes(task.status) && !retryingStoppedTask) {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${taskId} is ${task.status}, not ready or retryable for assignment`
      )
    }

    const coordinator = await this.threads.getThread(active.projectId, active.coordinatorThreadId)
    if (!coordinator?.settings) {
      throw new AssignmentEngineError('invalid_transition', 'Coordinator settings are missing')
    }
    if (!this.repo.claimOperation(operationId, assignmentId, 'assign_task')) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment operation is in progress')
    }

    // A failed task (worker crash / rejected deliverable) is re-dispatchable:
    // clear its stale report, review, worker name, and thread so a fresh worker
    // thread is created for the retry   never reuse the crashed worker's thread.
    // The abandoned thread is unlinked from the Assignment so a late harness
    // session error on it cannot report as this task's current worker.
    const replacingWorker = task.status === 'failed' || retryingStoppedTask
    const staleThreadId = replacingWorker ? task.threadId : undefined
    const dispatchBase = replacingWorker
      ? {
          ...task,
          report: undefined,
          review: undefined,
          workerName: undefined,
          threadId: undefined
        }
      : task.status === 'rework'
        ? { ...task, report: undefined, review: undefined }
        : task
    if (staleThreadId && staleThreadId !== active.coordinatorThreadId) {
      this.removeApiCapabilitiesForThread(active.id, staleThreadId)
      await this.threads.unlinkAssignmentThread(active.projectId, staleThreadId)
    }

    let assignedTask: AssignmentTask
    let thread: Thread | null = coordinator
    if (dispatchBase.owner === 'senior') {
      assignedTask = {
        ...dispatchBase,
        threadId: active.coordinatorThreadId,
        status: 'running',
        startedAt: this.now()
      }
    } else if (dispatchBase.threadId) {
      assignedTask = { ...dispatchBase, status: 'running', startedAt: this.now() }
      thread = await this.threads.getThread(active.projectId, dispatchBase.threadId)
    } else {
      const workerName = await this.workers.workerName(active)
      const settings = await this.workers.workerSettings(active, task, coordinator.settings)
      thread = await this.threads.createThread({
        projectId: active.projectId,
        providerId: settings.providerId,
        title: `${workerName}: ${task.title}`,
        titleSource: 'manual',
        settings,
        featureSlug: coordinator.featureSlug,
        scopeBucketId: active.scopeBucketId,
        workingDirectory: coordinator.workingDirectory,
        assignmentId: active.id,
        assignmentRole: 'worker',
        assignmentTaskId: task.id,
        coordinatorThreadId: active.coordinatorThreadId
      })
      assignedTask = {
        ...dispatchBase,
        workerName,
        threadId: thread.id,
        status: 'running',
        startedAt: this.now()
      }
      await this.artifacts.writeAuditChecklist(active, assignedTask)
    }

    const updated = await this.replaceTask(active, assignedTask, 'running')
    const result: AssignmentToolResult = {
      assignment: updated,
      task: assignedTask,
      thread: thread ?? undefined,
      idempotent: false
    }
    this.repo.completeOperation(operationId, assignmentId, 'assign_task', result)
    return result
  }

  async reportTask(
    assignmentId: string,
    taskId: string,
    workerThreadId: string,
    report: AssignmentTaskReport,
    operationId: string
  ): Promise<AssignmentToolResult> {
    const existingOperation = this.repo.getOperation(operationId, assignmentId, 'report_task')
    if (existingOperation) return { ...existingOperation, idempotent: true }
    const active = this.requireById(assignmentId)
    const task = this.requireTask(active, taskId)
    if (task.threadId !== workerThreadId) {
      throw new AssignmentEngineError('unauthorized', 'Worker thread does not own this task')
    }
    if (task.status !== 'running') {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${taskId} is ${task.status}, not running`
      )
    }
    const worker = await this.threads.getThread(active.projectId, workerThreadId)
    const validOwner =
      task.owner === 'senior'
        ? workerThreadId === active.coordinatorThreadId && worker?.assignmentRole === 'coordinator'
        : worker?.assignmentId === assignmentId &&
          worker.assignmentTaskId === taskId &&
          worker.coordinatorThreadId === active.coordinatorThreadId
    if (!validOwner) {
      throw new AssignmentEngineError('unauthorized', 'Task thread metadata does not match')
    }
    // Reporting is the only path that advances a worker task to `reported` and
    // prompts the coordinator's audit. A worker thread whose reporting the user
    // switched off is a private iteration loop, so its report is refused here
    // rather than silently ignored   the task must not move and the coordinator
    // must never be woken.
    if (task.owner === 'worker' && !workerReportsToCoordinator(worker?.settings)) {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Reporting to the Sr. Engineer is switched off for worker thread ${workerThreadId}. Do not call report-task; finish the work in the conversation and explain the outcome and your verification in your reply.`
      )
    }
    if (report.status === 'ready_for_audit') {
      await this.artifacts.requireWorkerTestEvidence(active, task)
    }
    if (!this.repo.claimOperation(operationId, assignmentId, 'report_task')) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment operation is in progress')
    }
    const status = report.status === 'ready_for_audit' ? 'reported' : 'attention'
    const reportedTask: AssignmentTask = { ...task, report, status }
    const updated = await this.replaceTask(
      active,
      reportedTask,
      report.status === 'ready_for_audit' ? 'running' : 'attention'
    )
    const result: AssignmentToolResult = {
      assignment: updated,
      task: reportedTask,
      idempotent: false
    }
    this.repo.completeOperation(operationId, assignmentId, 'report_task', result)
    return result
  }

  async submitTaskTestEvidence(
    assignmentId: string,
    taskId: string,
    workerThreadId: string,
    kind: 'baseline' | 'check',
    content: string,
    operationId: string
  ): Promise<AssignmentToolResult> {
    const existingOperation = this.repo.getOperation(
      operationId,
      assignmentId,
      'submit_test_evidence'
    )
    if (existingOperation) return { ...existingOperation, idempotent: true }

    const active = this.requireById(assignmentId)
    const task = this.requireTask(active, taskId)
    if (task.threadId !== workerThreadId) {
      throw new AssignmentEngineError('unauthorized', 'Worker thread does not own this task')
    }
    if (task.status !== 'running') {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${taskId} is ${task.status}, not running`
      )
    }
    const worker = await this.threads.getThread(active.projectId, workerThreadId)
    const validOwner =
      task.owner === 'senior'
        ? workerThreadId === active.coordinatorThreadId && worker?.assignmentRole === 'coordinator'
        : worker?.assignmentId === assignmentId &&
          worker.assignmentTaskId === taskId &&
          worker.coordinatorThreadId === active.coordinatorThreadId
    if (!validOwner) {
      throw new AssignmentEngineError('unauthorized', 'Task thread metadata does not match')
    }
    if (!content.trim() || content.length > 750_000) {
      throw new AssignmentEngineError(
        'validation_failed',
        'Test evidence must contain between 1 and 750000 characters'
      )
    }
    if (!this.repo.claimOperation(operationId, assignmentId, 'submit_test_evidence')) {
      throw new AssignmentEngineError('invalid_transition', 'Evidence submission is in progress')
    }

    try {
      await this.artifacts.writeTaskEvidence(active, workerThreadId, kind, content)
      const result: AssignmentToolResult = {
        assignment: active,
        task,
        idempotent: false
      }
      this.repo.completeOperation(operationId, assignmentId, 'submit_test_evidence', result)
      return result
    } catch (error) {
      this.repo.releaseOperation(operationId, assignmentId, 'submit_test_evidence')
      throw error
    }
  }

  async reviewTask(
    assignmentId: string,
    taskId: string,
    coordinatorThreadId: string,
    review: AssignmentTaskReview,
    operationId: string
  ): Promise<AssignmentToolResult> {
    const existingOperation = this.repo.getOperation(operationId, assignmentId, 'review_task')
    if (existingOperation) return { ...existingOperation, idempotent: true }
    const active = this.requireById(assignmentId)
    if (active.coordinatorThreadId !== coordinatorThreadId) {
      throw new AssignmentEngineError('unauthorized', 'Only the Sr. Engineer can review tasks')
    }
    const task = this.requireTask(active, taskId)
    if (!['reported', 'attention', 'failed'].includes(task.status)) {
      throw new AssignmentEngineError('invalid_transition', `Task ${taskId} has not reported`)
    }
    if (!this.repo.claimOperation(operationId, assignmentId, 'review_task')) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment operation is in progress')
    }
    const activeReworkCycle =
      active.auditCycle?.status === 'reworking' ? (active.auditCycle.reworkCycle ?? 1) : undefined
    const reviewedTask = buildReviewedTask(
      task,
      review,
      activeReworkCycle,
      active.version,
      this.now()
    )
    const tasks = active.content.tasks.map((candidate) =>
      candidate.id === taskId ? reviewedTask : candidate
    )
    const unblocked = unblockDependentTasks(tasks)
    const allComplete = allTasksCompleted(unblocked)
    const hasFailed = anyTaskFailed(unblocked)
    const now = this.now()
    const updated: AssignmentPlan = {
      ...active,
      status: allComplete ? 'completed' : hasFailed ? 'attention' : 'running',
      content: { ...active.content, tasks: unblocked },
      ...(allComplete
        ? {
            auditCycle: {
              ...active.auditCycle,
              ...(activeReworkCycle ? { reworkCycle: activeReworkCycle } : {}),
              status: 'available',
              availableAt: now,
              startedAt: undefined,
              reportedAt: undefined,
              completedAt: undefined
            }
          }
        : {}),
      updatedAt: now,
      completedAt: allComplete ? now : undefined
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    if (allComplete) {
      this.removeWorkerApiCapabilitiesForAssignment(active.id)
    }
    const result: AssignmentToolResult = {
      assignment: updated,
      task: reviewedTask,
      idempotent: false
    }
    this.repo.completeOperation(operationId, assignmentId, 'review_task', result)
    return result
  }

  async stopWorker(assignmentId: string, workerThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireById(assignmentId)
    const task = active.content.tasks.find(
      (candidate) => candidate.owner === 'worker' && candidate.threadId === workerThreadId
    )
    if (!task) throw new AssignmentEngineError('not_found', 'Assignment worker task not found')
    if (!['running', 'reported', 'auditing', 'rework'].includes(task.status)) {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${task.id} is ${task.status}, not active`
      )
    }
    const updated: AssignmentPlan = {
      ...active,
      status: 'attention',
      content: {
        ...active.content,
        tasks: active.content.tasks.map((candidate) =>
          candidate.id === task.id ? { ...candidate, status: 'attention' } : candidate
        )
      },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  async markWorkerSteered(assignmentId: string, workerThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireById(assignmentId)
    const task = active.content.tasks.find(
      (candidate) => candidate.owner === 'worker' && candidate.threadId === workerThreadId
    )
    if (!task) throw new AssignmentEngineError('not_found', 'Assignment worker task not found')
    if (
      task.status === 'running' &&
      active.status === 'running' &&
      task.report === undefined &&
      task.review === undefined
    ) {
      return active
    }
    const tasks = buildSteeredTasks(active.content.tasks, task.id, this.now())
    const status = planStatusAfterSteer(tasks)
    const updated: AssignmentPlan = {
      ...active,
      status,
      completedAt: undefined,
      content: { ...active.content, tasks },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  workerPrompt(plan: AssignmentPlan, task: AssignmentTask, featureSlug: string): string {
    return buildWorkerPrompt(plan, task, featureSlug)
  }

  private requireActive(projectId: string, coordinatorThreadId: string): AssignmentPlan {
    return requireActivePlan(this.repo, projectId, coordinatorThreadId)
  }

  private requireById(assignmentId: string): AssignmentPlan {
    return requirePlanById(this.repo, assignmentId)
  }

  private requireTask(plan: AssignmentPlan, taskId: string): AssignmentTask {
    return requireTaskInPlan(plan, taskId)
  }

  private async requireAuditRework(plan: AssignmentPlan): Promise<AssignmentPlan> {
    return this.auditCycle.requireRework(plan)
  }

  private async replaceTask(
    active: AssignmentPlan,
    task: AssignmentTask,
    status: AssignmentPlan['status']
  ): Promise<AssignmentPlan> {
    const updated: AssignmentPlan = {
      ...active,
      status,
      content: {
        ...active.content,
        tasks: active.content.tasks.map((candidate) =>
          candidate.id === task.id ? task : candidate
        )
      },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  private async persist(plan: AssignmentPlan): Promise<void> {
    this.repo.save(plan)
    await this.artifacts.writeMarkdown(plan)
  }
}
