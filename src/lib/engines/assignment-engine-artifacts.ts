import { join } from 'path'
import { stat } from 'fs/promises'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage/storage-engine'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import { exportAssignmentMarkdown, exportAuditChecklist } from '../assignment/assignment-markdown'
import type { AssignmentPlan, AssignmentTask } from '../types'
import { AssignmentEngineError } from './assignment-engine-error'

/**
 * Owns every durable artifact the Assignment writes: the reviewable
 * `assignment.md`, each task's `audit-checklist.md`, the resolved markdown
 * path, and the fresh-evidence gate a worker must pass before reporting done.
 */
export class AssignmentArtifactWriter {
  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database
  ) {}

  async markdownPath(projectId: string, coordinatorThreadId: string): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.db, projectId, coordinatorThreadId)
    return this.storage.resolveProjectSpecArtifact(
      projectId,
      featureSlug,
      'assignment.md',
      requireLocalProject(this.db, projectId)
    )
  }

  async writeMarkdown(plan: AssignmentPlan): Promise<void> {
    const featureSlug = await ensureFeatureSlug(this.db, plan.projectId, plan.coordinatorThreadId)
    await this.storage.writeProjectSpecRaw(
      plan.projectId,
      featureSlug,
      'assignment.md',
      exportAssignmentMarkdown(plan),
      requireLocalProject(this.db, plan.projectId)
    )
  }

  async writeAuditChecklist(plan: AssignmentPlan, task: AssignmentTask): Promise<void> {
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

  async writeTaskEvidence(
    plan: AssignmentPlan,
    workerThreadId: string,
    kind: 'baseline' | 'check',
    content: string
  ): Promise<void> {
    const featureSlug = await ensureFeatureSlug(this.db, plan.projectId, plan.coordinatorThreadId)
    await this.storage.writeProjectSpecRaw(
      plan.projectId,
      featureSlug,
      join('tasks', workerThreadId, 'test', `${kind}.txt`),
      content,
      requireLocalProject(this.db, plan.projectId)
    )
  }

  async requireWorkerTestEvidence(plan: AssignmentPlan, task: AssignmentTask): Promise<void> {
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
