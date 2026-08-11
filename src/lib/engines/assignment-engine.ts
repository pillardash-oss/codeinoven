import { join } from 'path'
import { stat } from 'fs/promises'
import { createHash, randomInt } from 'crypto'
import type { Database } from '../../main/database/database'
import { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { AssignmentApiCapabilityRow } from '../../main/database/repositories/assignment-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import type { StorageEngine } from '../../main/storage-engine'
import type {
  AssignmentPlan,
  AssignmentAnnotation,
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
import { generateId } from '../utils'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import { exportAssignmentMarkdown, exportAuditChecklist } from '../assignment/assignment-markdown'
import { validateAssignment } from '../assignment/assignment-validation'
import { ThreadManager } from './thread-manager'
import { ScopeManager } from './scope-manager'
import type { SpecEngine } from './spec-engine'

export const ASSIGNMENT_WORKER_INSTRUCTION =
  "You are not working alone on this project so you might come across changes you did not make. Do not remove them, it might be another worker or our master who made those changes. Ensure you work surgically and efficiently, not being overly verbose, but terse and precise. Always check your work. If a focused test exists, run it before making changes and immediately submit its complete output as baseline evidence through the Assignment API. Run the focused check again after your changes, submit its complete output as check evidence through the Assignment API, then compare both results and make corrections if necessary. Do not write Assignment evidence directly into .cio; CodeInOven owns and atomically persists those artifacts. Never assume an error was pre-existing if it truly wasn't and never attribute an error to another agent just to cut corners! When you finish commit your work as instructed by the master."

type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>

export interface CreateAssignmentInput {
  projectId: string
  coordinatorThreadId: string
  specId: string
  specVersion: number
  content: AssignmentPlanContent
  provenance: NewAssignmentProvenance
}

export interface AddAssignmentAnnotationInput {
  section: string
  body: string
  author: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
}

export class AssignmentEngineError extends Error {
  constructor(
    readonly code:
      'not_found' | 'immutable' | 'validation_failed' | 'invalid_transition' | 'unauthorized',
    message: string
  ) {
    super(message)
    this.name = 'AssignmentEngineError'
  }
}

export class AssignmentEngine {
  private readonly repo: AssignmentRepo
  private readonly threads: ThreadManager
  private readonly scopes: ScopeManager

  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly idFactory: () => string = generateId,
    private readonly randomIndex: (upperBound: number) => number = randomInt
  ) {
    this.repo = new AssignmentRepo(db)
    this.threads = new ThreadManager(db)
    this.scopes = new ScopeManager(db)
  }

  async createDraft(input: CreateAssignmentInput): Promise<AssignmentPlan> {
    const coordinator = await this.threads.getThread(input.projectId, input.coordinatorThreadId)
    if (!coordinator || coordinator.projectId !== input.projectId) {
      throw new AssignmentEngineError(
        'unauthorized',
        'Coordinator thread does not belong to the project'
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
      specId: input.specId,
      specVersion: input.specVersion,
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
    const active = this.requireMutableVersion(projectId, coordinatorThreadId, assignmentId, version)
    const annotation: AssignmentAnnotation = {
      id: this.idFactory(),
      ...input,
      status: 'open',
      createdAt: this.now()
    }
    const updated = {
      ...active,
      annotations: [...(active.annotations ?? []), annotation],
      updatedAt: this.now()
    }
    this.repo.save(updated)
    await this.writeMarkdown(updated)
    return updated
  }

  async updateAnnotation(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number,
    annotationId: string,
    body: string
  ): Promise<AssignmentPlan> {
    const active = this.requireMutableVersion(projectId, coordinatorThreadId, assignmentId, version)
    if (!body.trim()) throw new AssignmentEngineError('validation_failed', 'Annotation is required')
    const existing = (active.annotations ?? []).find((annotation) => annotation.id === annotationId)
    if (!existing) {
      throw new AssignmentEngineError('not_found', `Annotation not found: ${annotationId}`)
    }
    if (existing.status !== 'open') {
      throw new AssignmentEngineError('immutable', 'Resolved annotations cannot be edited')
    }
    const updated = {
      ...active,
      annotations: (active.annotations ?? []).map((annotation) =>
        annotation.id === annotationId ? { ...annotation, body: body.trim() } : annotation
      ),
      updatedAt: this.now()
    }
    this.repo.save(updated)
    await this.writeMarkdown(updated)
    return updated
  }

  async resolveAnnotation(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number,
    annotationId: string
  ): Promise<AssignmentPlan> {
    const active = this.requireMutableVersion(projectId, coordinatorThreadId, assignmentId, version)
    const existing = (active.annotations ?? []).find((annotation) => annotation.id === annotationId)
    if (!existing) {
      throw new AssignmentEngineError('not_found', `Annotation not found: ${annotationId}`)
    }
    if (existing.status === 'resolved') return active
    const now = this.now()
    const updated = {
      ...active,
      annotations: (active.annotations ?? []).map((annotation) =>
        annotation.id === annotationId
          ? { ...annotation, status: 'resolved' as const, resolvedAt: now }
          : annotation
      ),
      updatedAt: now
    }
    this.repo.save(updated)
    await this.writeMarkdown(updated)
    return updated
  }

  /** Atomically claim the current durable coordinator state for one automatic prompt. */
  async claimCoordinatorSnapshot(assignmentId: string): Promise<string | null> {
    const plan = this.requireById(assignmentId)
    if (plan.status === 'stopped') return null
    const snapshotJson = await this.coordinatorSnapshotJson(plan)
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

  /** Drop capability tokens once an Assignment reaches a terminal state. */
  removeApiCapabilitiesForAssignment(assignmentId: string): void {
    this.repo.removeApiCapabilitiesForAssignment(assignmentId)
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
    const featureSlug = await ensureFeatureSlug(this.db, projectId, coordinatorThreadId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      'assignment.md',
      requireLocalProject(this.db, projectId)
    )
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
    const scopeBucketId = `assignment-${active.id}`
    const reworkActivation = active.auditCycle?.status === 'awaiting_rework_approval'
    const scopeRepairActivation = reworkActivation && active.auditCycle?.scopeRepair === true
    const completedTaskIds = new Set(
      active.content.tasks
        .filter((task) => scopeRepairActivation && task.status === 'completed')
        .map((task) => task.id)
    )
    const tasks = active.content.tasks.map((task) => {
      if (scopeRepairActivation && task.status === 'completed') return task
      const {
        statusBeforeStop: _statusBeforeStop,
        workerName: _workerName,
        threadId: _threadId,
        report: _report,
        review: _review,
        startedAt: _startedAt,
        completedAt: _completedAt,
        ...taskDefinition
      } = task
      return {
        ...taskDefinition,
        workKind: task.workKind ?? (reworkActivation ? ('rework' as const) : ('initial' as const)),
        workAssignmentVersion: reworkActivation
          ? active.version
          : (task.workAssignmentVersion ?? active.version),
        ...(reworkActivation
          ? { reworkCycle: task.reworkCycle ?? active.auditCycle?.reworkCycle ?? 1 }
          : {}),
        status:
          task.dependsOn.length === 0 ||
          (scopeRepairActivation &&
            task.dependsOn.every((dependency) => completedTaskIds.has(dependency)))
            ? ('ready' as const)
            : ('blocked' as const)
      }
    })
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

    await this.writeMarkdown(approved)
    const coordinator = await this.threads.getThread(projectId, coordinatorThreadId)
    if (!coordinator) throw new AssignmentEngineError('not_found', 'Coordinator not found')
    this.db.transaction(() => {
      const board = this.scopes.getBoard(projectId)
      this.scopes.saveBoard(projectId, {
        ...board,
        buckets: board.buckets.some((bucket) => bucket.id === scopeBucketId)
          ? board.buckets
          : [
              ...board.buckets,
              {
                id: scopeBucketId,
                name: active.content.title,
                sortOrder: board.buckets.length,
                collapsed: false,
                collapsedSlices: []
              }
            ]
      })
      this.repo.save(approved, approved.version)
      new ThreadRepo(this.db).upsert({
        ...coordinator,
        assignmentId: active.id,
        assignmentRole: 'coordinator',
        scopeBucketId,
        userInputLocked: false,
        pinned: true,
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
        tasks: active.content.tasks.map((task) => {
          if (task.status === 'completed') return task
          const statusBeforeStop =
            task.status === 'stopped' ? (task.statusBeforeStop ?? 'attention') : task.status
          return { ...task, status: 'stopped' as const, statusBeforeStop }
        })
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
    await this.writeMarkdown(stopped)
    return stopped
  }

  /** Restore a stopped Assignment to a safe, explicitly user-requested continuation state. */
  async resume(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'stopped') {
      throw new AssignmentEngineError('invalid_transition', 'The Assignment is not stopped')
    }

    const tasks = active.content.tasks.map((task): AssignmentTask => {
      if (task.status !== 'stopped') return task
      const restoredStatus = task.statusBeforeStop ?? 'attention'
      const { statusBeforeStop: _statusBeforeStop, ...rest } = task
      return {
        ...rest,
        status: restoredStatus === 'running' ? 'attention' : restoredStatus
      }
    })
    const previousStatus =
      active.statusBeforeStop ??
      (tasks.every((task) => task.status === 'completed') ? 'completed' : 'attention')
    const resumedStatus =
      previousStatus === 'failed' || tasks.some((task) => task.status === 'attention')
        ? 'attention'
        : previousStatus
    const auditCycle = active.auditCycle
      ? (() => {
          if (active.auditCycle.status !== 'stopped') return active.auditCycle
          const restoredStatus = active.auditCycle.statusBeforeStop ?? 'available'
          const { statusBeforeStop: _statusBeforeStop, ...rest } = active.auditCycle
          return {
            ...rest,
            status: restoredStatus === 'running' ? ('available' as const) : restoredStatus
          }
        })()
      : undefined
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
    await this.writeMarkdown(resumed)
    return resumed
  }

  async approveWithSpec(
    projectId: string,
    coordinatorThreadId: string,
    specEngine: SpecEngine
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
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
    const auditorName = await this.auditorName(active)
    const auditorSettings: ThreadSettings = {
      ...settings,
      permissionLevel: 'auto_review',
      engineeringMode: false,
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
    await this.writeMarkdown(updated)
    return auditor
  }

  async beginAuditCycle(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'An Assignment audit can start only after implementation completes'
      )
    }
    if (active.auditCycle && !['available', 'failed'].includes(active.auditCycle.status)) {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Assignment audit is ${active.auditCycle.status}`
      )
    }
    const now = this.now()
    return this.saveAuditCycle(active, {
      status: 'running',
      availableAt: active.auditCycle?.availableAt ?? now,
      startedAt: now,
      failedAt: undefined,
      failure: undefined
    })
  }

  async failAuditCycle(
    projectId: string,
    coordinatorThreadId: string,
    failure: string
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'running') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not running')
    }
    const normalizedFailure = failure.trim()
    if (!normalizedFailure) {
      throw new AssignmentEngineError('validation_failed', 'Assignment audit failure is required')
    }
    return this.saveAuditCycle(active, {
      ...active.auditCycle,
      status: 'failed',
      failedAt: this.now(),
      failure: normalizedFailure.slice(0, 20_000)
    })
  }

  async reportAuditCycle(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'running') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not running')
    }
    if (!reportId.trim() || !Number.isSafeInteger(reportVersion) || reportVersion < 1) {
      throw new AssignmentEngineError(
        'validation_failed',
        'Assignment audit report linkage is invalid'
      )
    }
    const now = this.now()
    return this.saveAuditCycle(active, {
      ...active.auditCycle,
      status: 'report_ready',
      reportId,
      reportVersion,
      reportedAt: now
    })
  }

  async beginAuditRework(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed' || !active.auditCycle) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit report is not ready')
    }
    if (active.auditCycle.status === 'planning_rework') return active
    if (active.auditCycle.status !== 'report_ready') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit report is not ready')
    }
    const now = this.now()
    return this.saveAuditCycle(active, {
      ...active.auditCycle,
      status: 'planning_rework',
      reworkStartedAt: now,
      reworkCycle: (active.auditCycle.reworkCycle ?? 0) + 1
    })
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
    const reworkCycle = auditRework
      ? (active.auditCycle?.reworkCycle ?? 1)
      : (active.auditCycle?.reworkCycle ?? 0) + 1
    const currentTasks = new Map(active.content.tasks.map((task) => [task.id, task]))
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
    const amendedContent: AssignmentPlanContent = {
      ...structuredClone(content),
      tasks: content.tasks.map((task) => {
        const currentTask = currentTasks.get(task.id)
        if (!scopeRepair || !currentTask) return structuredClone(task)
        if (currentTask.status === 'completed') return structuredClone(currentTask)
        return {
          ...structuredClone(task),
          status: currentTask.status,
          ...(currentTask.workKind ? { workKind: currentTask.workKind } : {}),
          ...(currentTask.reworkCycle ? { reworkCycle: currentTask.reworkCycle } : {}),
          ...(currentTask.workAssignmentVersion
            ? { workAssignmentVersion: currentTask.workAssignmentVersion }
            : {}),
          ...(currentTask.workerName ? { workerName: currentTask.workerName } : {}),
          ...(currentTask.threadId ? { threadId: currentTask.threadId } : {}),
          ...(currentTask.report ? { report: structuredClone(currentTask.report) } : {}),
          ...(currentTask.review ? { review: structuredClone(currentTask.review) } : {}),
          ...(currentTask.startedAt ? { startedAt: currentTask.startedAt } : {}),
          ...(currentTask.completedAt ? { completedAt: currentTask.completedAt } : {})
        }
      })
    }
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
        tasks: amendedContent.tasks.map((task) =>
          scopeRepair && task.status === 'completed'
            ? structuredClone(task)
            : {
                ...structuredClone(task),
                workKind: 'rework' as const,
                reworkCycle,
                workAssignmentVersion: nextVersion
              }
        )
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
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'report_ready') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit report is not ready')
    }
    return this.saveAuditCycle(active, {
      ...active.auditCycle,
      status: 'completed',
      completedAt: this.now()
    })
  }

  async makeAuditAvailable(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (
      active.status !== 'completed' ||
      !active.auditCycle ||
      !['running', 'report_ready', 'planning_rework', 'reworking'].includes(
        active.auditCycle.status
      )
    ) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Assignment audit cannot be made available yet'
      )
    }
    return this.saveAuditCycle(active, {
      ...active.auditCycle,
      status: 'available',
      availableAt: this.now(),
      startedAt: undefined,
      failedAt: undefined,
      failure: undefined,
      reportedAt: undefined,
      completedAt: undefined
    })
  }

  async reopenCompletedTask(
    projectId: string,
    coordinatorThreadId: string,
    taskId: string
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    const task = this.requireTask(active, taskId)
    this.requireAuditRework(active)
    if (task.status !== 'completed') {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${taskId} is ${task.status}, not completed`
      )
    }
    const updatedTask: AssignmentTask = {
      ...task,
      workKind: 'rework',
      reworkCycle: active.auditCycle?.reworkCycle ?? 1,
      workAssignmentVersion: active.version,
      status: 'rework',
      completedAt: undefined
    }
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
    await this.writeMarkdown(updated)
    return updated
  }

  async appendFollowUpTask(
    projectId: string,
    coordinatorThreadId: string,
    input: AssignmentFollowUpTaskInput
  ): Promise<AssignmentPlan> {
    const active = this.requireActive(projectId, coordinatorThreadId)
    this.requireAuditRework(active)
    const task: AssignmentTask = {
      ...structuredClone(input),
      workKind: 'rework',
      reworkCycle: active.auditCycle?.reworkCycle ?? 1,
      workAssignmentVersion: active.version,
      status: 'planned'
    }
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
    const completedIds = new Set(
      active.content.tasks
        .filter((candidate) => candidate.status === 'completed')
        .map((candidate) => candidate.id)
    )
    const status = task.dependsOn.every((dependency) => completedIds.has(dependency))
      ? 'ready'
      : 'blocked'
    const updated: AssignmentPlan = {
      ...active,
      status: 'running',
      completedAt: undefined,
      content: { ...active.content, tasks: [...active.content.tasks, { ...task, status }] },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.writeMarkdown(updated)
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
    // thread is created for the retry — never reuse the crashed worker's thread.
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
      const workerName = await this.workerName(active)
      const settings = await this.workerSettings(active, task, coordinator.settings)
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
      await this.writeAuditChecklist(active, assignedTask)
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
    if (report.status === 'ready_for_audit') {
      await this.requireWorkerTestEvidence(active, task)
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
      const featureSlug = await ensureFeatureSlug(
        this.db,
        active.projectId,
        active.coordinatorThreadId
      )
      await this.storage.writeProjectSpecRaw(
        active.projectId,
        featureSlug,
        join('tasks', workerThreadId, 'test', `${kind}.txt`),
        content,
        requireLocalProject(this.db, active.projectId)
      )
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
    const reviewedTask: AssignmentTask = {
      ...task,
      ...(activeReworkCycle
        ? {
            workKind: 'rework' as const,
            reworkCycle: activeReworkCycle,
            workAssignmentVersion: active.version
          }
        : {}),
      review,
      status:
        review.decision === 'pass'
          ? 'completed'
          : review.decision === 'rework'
            ? 'rework'
            : 'failed',
      completedAt: review.decision === 'pass' ? this.now() : undefined
    }
    const tasks = active.content.tasks.map((candidate) =>
      candidate.id === taskId ? reviewedTask : candidate
    )
    const completedIds = new Set(
      tasks.filter((candidate) => candidate.status === 'completed').map((candidate) => candidate.id)
    )
    const unblocked = tasks.map((candidate) =>
      candidate.status === 'blocked' &&
      candidate.dependsOn.every((dependency) => completedIds.has(dependency))
        ? { ...candidate, status: 'ready' as const }
        : candidate
    )
    const allComplete = unblocked.every((candidate) => candidate.status === 'completed')
    const hasFailed = unblocked.some((candidate) => candidate.status === 'failed')
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
    await this.writeMarkdown(updated)
    if (allComplete) {
      this.removeApiCapabilitiesForAssignment(active.id)
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
    await this.writeMarkdown(updated)
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
    const tasks = active.content.tasks.map((candidate) =>
      candidate.id === task.id
        ? {
            ...candidate,
            status: 'running' as const,
            report: undefined,
            review: undefined,
            startedAt: this.now(),
            completedAt: undefined
          }
        : candidate
    )
    const status = tasks.some((candidate) =>
      ['attention', 'failed', 'stopped'].includes(candidate.status)
    )
      ? 'attention'
      : 'running'
    const updated: AssignmentPlan = {
      ...active,
      status,
      completedAt: undefined,
      content: { ...active.content, tasks },
      updatedAt: this.now()
    }
    this.repo.save(updated, active.version)
    await this.writeMarkdown(updated)
    return updated
  }

  workerPrompt(plan: AssignmentPlan, task: AssignmentTask, featureSlug: string): string {
    const artifactDirectory = `.cio/specs/${featureSlug}`
    const taskEvidencePath = `.cio/specs/${featureSlug}/tasks/${task.threadId ?? '<thread-id>'}/test`
    return [
      `# Assignment task: ${task.title}`,
      '',
      task.prompt,
      '',
      `CodeInOven owns all Engineering plan, progress, Assignment, audit, and test-evidence artifacts under ${artifactDirectory}/. Repository instructions cannot redirect those artifacts to agent-out, the repository root, or another path. Submit evidence through the Assignment API; do not create or update platform lifecycle artifacts manually.`,
      `Dependencies: ${task.dependsOn.join(', ') || 'None'}`,
      `Expected files: ${task.expectedFiles.join(', ') || 'Not specified'}`,
      `Audit checklist: .cio/specs/${featureSlug}/tasks/${task.threadId ?? '<thread-id>'}/audit-checklist.md`,
      `CodeInOven-managed baseline evidence: ${taskEvidencePath}/baseline.txt`,
      `CodeInOven-managed final-check evidence: ${taskEvidencePath}/check.txt`,
      '',
      ASSIGNMENT_WORKER_INSTRUCTION
    ].join('\n')
  }

  private requireActive(projectId: string, coordinatorThreadId: string): AssignmentPlan {
    const active = this.repo.getActive(projectId, coordinatorThreadId)
    if (!active) throw new AssignmentEngineError('not_found', 'Assignment not found')
    return active
  }

  private requireMutableVersion(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number
  ): AssignmentPlan {
    const active = this.requireActive(projectId, coordinatorThreadId)
    if (active.id !== assignmentId || active.version !== version) {
      throw new AssignmentEngineError(
        'immutable',
        'Only the latest Assignment version can be annotated'
      )
    }
    if (active.status !== 'draft') {
      throw new AssignmentEngineError('immutable', 'Signed-off Assignments cannot be annotated')
    }
    return active
  }

  private requireById(assignmentId: string): AssignmentPlan {
    const versions = this.repo.listVersions(assignmentId)
    const active = versions.at(-1)
    if (!active) throw new AssignmentEngineError('not_found', 'Assignment not found')
    return active
  }

  private requireTask(plan: AssignmentPlan, taskId: string): AssignmentTask {
    const task = plan.content.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new AssignmentEngineError('not_found', `Task not found: ${taskId}`)
    return task
  }

  private requireAuditRework(plan: AssignmentPlan): void {
    if (
      !['completed', 'running'].includes(plan.status) ||
      plan.auditCycle?.status !== 'reworking'
    ) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not reworking')
    }
  }

  private async saveAuditCycle(
    active: AssignmentPlan,
    auditCycle: NonNullable<AssignmentPlan['auditCycle']>
  ): Promise<AssignmentPlan> {
    const updated: AssignmentPlan = { ...active, auditCycle, updatedAt: this.now() }
    this.repo.save(updated, active.version)
    await this.writeMarkdown(updated)
    return updated
  }

  private async workerName(plan: AssignmentPlan): Promise<string> {
    const latest = this.repo.listVersions(plan.id).at(-1) ?? plan
    const used = new Set(
      latest.content.tasks
        .map((task) => task.workerName)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
    )
    const names = await this.storage.getWorkerNames()
    const available = names.filter((name) => !used.has(`wrk-${name}`))
    const pool = available.length > 0 ? available : names
    const base = pool[this.randomIndex(pool.length)]
    let candidate = `wrk-${base}`
    let suffix = 2
    while (used.has(candidate)) {
      candidate = `wrk-${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  private async auditorName(plan: AssignmentPlan): Promise<string> {
    const names = await this.storage.getWorkerNames()
    const used = new Set(
      (await this.threads.listThreads(plan.projectId))
        .map((thread) => thread.title.match(/^audit-([^:]+):/u)?.[1])
        .filter((name): name is string => name !== undefined)
    )
    const available = names.filter((name) => !used.has(name))
    const pool = available.length > 0 ? available : names
    const base = pool[this.randomIndex(pool.length)]
    let candidate = `audit-${base}`
    let suffix = 2
    while (used.has(candidate.slice('audit-'.length))) {
      candidate = `audit-${base}-${suffix}`
      suffix += 1
    }
    return candidate
  }

  private async coordinatorSnapshotJson(plan: AssignmentPlan): Promise<string> {
    const threads = (await this.threads.listThreads(plan.projectId))
      .filter((thread) => thread.assignmentId === plan.id)
      .map((thread) => ({
        id: thread.id,
        assignmentRole: thread.assignmentRole,
        assignmentTaskId: thread.assignmentTaskId,
        model: thread.settings
          ? {
              harnessId: thread.settings.harnessId,
              providerId: thread.settings.providerId,
              modelId: thread.settings.modelId,
              thinkingLevel: thread.settings.thinkingLevel
            }
          : null
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    const tasks = plan.content.tasks.map((task) => ({
      id: task.id,
      phaseId: task.phaseId,
      title: task.title,
      owner: task.owner,
      dependsOn: task.dependsOn,
      model: task.model,
      status: task.status,
      workerName: task.workerName,
      threadId: task.threadId,
      report: task.report
        ? {
            status: task.report.status,
            summary: task.report.summary,
            evidence: task.report.evidence,
            commitHash: task.report.commitHash
          }
        : null,
      review: task.review
        ? {
            decision: task.review.decision,
            checklistResults: task.review.checklistResults,
            notes: task.review.notes
          }
        : null
    }))
    return JSON.stringify({
      assignmentId: plan.id,
      version: plan.version,
      specId: plan.specId,
      specVersion: plan.specVersion,
      status: plan.status,
      phases: plan.content.phases,
      tasks,
      threads
    })
  }

  private async workerSettings(
    plan: AssignmentPlan,
    task: AssignmentTask,
    coordinator: ThreadSettings
  ): Promise<ThreadSettings> {
    const phase = plan.content.phases.find((candidate) => candidate.id === task.phaseId)
    const configuredWorker = (await this.storage.getConfig()).agentDefaults.worker
    const selected = task.model ?? phase?.defaultModel ?? configuredWorker
    return {
      ...coordinator,
      ...(selected ?? {}),
      engineeringMode: false,
      assignmentMode: false,
      loopMode: false,
      loopAuditor: undefined
    }
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
    await this.writeMarkdown(updated)
    return updated
  }

  private async persist(plan: AssignmentPlan): Promise<void> {
    this.repo.save(plan)
    await this.writeMarkdown(plan)
  }

  private async writeMarkdown(plan: AssignmentPlan): Promise<void> {
    const featureSlug = await ensureFeatureSlug(this.db, plan.projectId, plan.coordinatorThreadId)
    await this.storage.writeProjectSpecRaw(
      plan.projectId,
      featureSlug,
      'assignment.md',
      exportAssignmentMarkdown(plan),
      requireLocalProject(this.db, plan.projectId)
    )
  }

  private async writeAuditChecklist(plan: AssignmentPlan, task: AssignmentTask): Promise<void> {
    if (!task.threadId) return
    const featureSlug = await ensureFeatureSlug(this.db, plan.projectId, plan.coordinatorThreadId)
    await this.storage.writeProjectSpecRaw(
      plan.projectId,
      featureSlug,
      join('tasks', task.threadId, 'audit-checklist.md'),
      exportAuditChecklist(task),
      requireLocalProject(this.db, plan.projectId)
    )
  }

  private async requireWorkerTestEvidence(
    plan: AssignmentPlan,
    task: AssignmentTask
  ): Promise<void> {
    if (!task.threadId) {
      throw new AssignmentEngineError('invalid_transition', 'Task thread is missing')
    }
    const featureSlug = await ensureFeatureSlug(this.db, plan.projectId, plan.coordinatorThreadId)
    const evidenceRoot = join(
      requireLocalProject(this.db, plan.projectId).path,
      '.cio',
      'specs',
      featureSlug,
      'tasks',
      task.threadId,
      'test'
    )
    try {
      const [baseline, check] = await Promise.all([
        stat(join(evidenceRoot, 'baseline.txt')),
        stat(join(evidenceRoot, 'check.txt'))
      ])
      if (baseline.size === 0 || check.size === 0) throw new Error('Evidence file is empty')
      if (
        task.startedAt !== undefined &&
        (baseline.mtimeMs < task.startedAt || check.mtimeMs < task.startedAt)
      ) {
        throw new Error('Evidence belongs to an earlier task run')
      }
    } catch {
      throw new AssignmentEngineError(
        'invalid_transition',
        `Task ${task.id} must submit fresh baseline and check evidence through the Assignment API`
      )
    }
  }
}
