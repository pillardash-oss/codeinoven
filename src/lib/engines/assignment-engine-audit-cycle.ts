import type { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { AssignmentPlan } from '../types'
import { AssignmentEngineError } from './assignment-engine-error'
import { requireActivePlan } from './assignment-engine-plan-lookup'
import type { AssignmentArtifactWriter } from './assignment-engine-artifacts'

/**
 * State machine for the post-implementation Assignment audit cycle. Every
 * transition guards its current status, persists the updated plan, and
 * rewrites the reviewable markdown.
 */
export class AssignmentAuditCycleBook {
  constructor(
    private readonly repo: AssignmentRepo,
    private readonly artifacts: AssignmentArtifactWriter,
    private readonly now: () => number
  ) {}

  async begin(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
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
    return this.save(active, {
      status: 'running',
      availableAt: active.auditCycle?.availableAt ?? now,
      offerDismissedAt: undefined,
      startedAt: now,
      failedAt: undefined,
      failure: undefined
    })
  }

  async fail(
    projectId: string,
    coordinatorThreadId: string,
    failure: string
  ): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'running') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not running')
    }
    const normalizedFailure = failure.trim()
    if (!normalizedFailure) {
      throw new AssignmentEngineError('validation_failed', 'Assignment audit failure is required')
    }
    return this.save(active, {
      ...active.auditCycle,
      status: 'failed',
      failedAt: this.now(),
      failure: normalizedFailure.slice(0, 20_000)
    })
  }

  async report(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number
  ): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
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
    return this.save(active, {
      ...active.auditCycle,
      status: 'report_ready',
      reportId,
      reportVersion,
      reportedAt: now
    })
  }

  async beginRework(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
    if (active.status !== 'completed' || !active.auditCycle) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit report is not ready')
    }
    if (active.auditCycle.status === 'reworking') return active
    if (!['report_ready', 'planning_rework'].includes(active.auditCycle.status)) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit report is not ready')
    }
    const now = this.now()
    return this.save(active, {
      ...active.auditCycle,
      status: 'reworking',
      reworkStartedAt: active.auditCycle.reworkStartedAt ?? now,
      reworkCycle:
        active.auditCycle.status === 'planning_rework'
          ? (active.auditCycle.reworkCycle ?? 1)
          : (active.auditCycle.reworkCycle ?? 0) + 1
    })
  }

  async complete(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
    if (
      active.status !== 'completed' ||
      !active.auditCycle ||
      !['report_ready', 'available'].includes(active.auditCycle.status)
    ) {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Assignment audit cannot be completed from its current state'
      )
    }
    return this.save(active, {
      ...active.auditCycle,
      status: 'completed',
      completedAt: this.now()
    })
  }

  /** Hide the offered audit from the composer without giving it up: the cycle
   *  stays `available` so the coordinator panel and studios can still start it. */
  async dismissOffer(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'available') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Assignment audit offer cannot be dismissed right now'
      )
    }
    if (active.auditCycle.offerDismissedAt !== undefined) return active
    return this.save(active, { ...active.auditCycle, offerDismissedAt: this.now() })
  }

  /** Bring a dismissed offer back, so the composer prompt can start the audit. */
  async restoreOffer(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
    if (active.status !== 'completed' || active.auditCycle?.status !== 'available') {
      throw new AssignmentEngineError(
        'invalid_transition',
        'Assignment audit offer cannot be restored right now'
      )
    }
    if (active.auditCycle.offerDismissedAt === undefined) return active
    return this.save(active, { ...active.auditCycle, offerDismissedAt: undefined })
  }

  async makeAvailable(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
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
    return this.save(active, {
      ...active.auditCycle,
      status: 'available',
      availableAt: this.now(),
      offerDismissedAt: undefined,
      startedAt: undefined,
      failedAt: undefined,
      failure: undefined,
      reportedAt: undefined,
      completedAt: undefined
    })
  }

  async requireRework(plan: AssignmentPlan): Promise<AssignmentPlan> {
    if (!['completed', 'running'].includes(plan.status) || !plan.auditCycle) {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not reworking')
    }
    if (plan.auditCycle.status === 'reworking') return plan
    if (plan.auditCycle.status !== 'planning_rework') {
      throw new AssignmentEngineError('invalid_transition', 'Assignment audit is not reworking')
    }
    return this.save(plan, {
      ...plan.auditCycle,
      status: 'reworking',
      reworkStartedAt: plan.auditCycle.reworkStartedAt ?? this.now(),
      reworkCycle: plan.auditCycle.reworkCycle ?? 1
    })
  }

  private async save(
    active: AssignmentPlan,
    auditCycle: NonNullable<AssignmentPlan['auditCycle']>
  ): Promise<AssignmentPlan> {
    const updated: AssignmentPlan = { ...active, auditCycle, updatedAt: this.now() }
    this.repo.save(updated, active.version)
    await this.artifacts.writeMarkdown(updated)
    return updated
  }
}
