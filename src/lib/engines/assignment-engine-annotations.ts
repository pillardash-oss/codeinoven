import type { AssignmentRepo } from '../../main/database/repositories/assignment-repo'
import type { AssignmentAnnotation, AssignmentPlan } from '../types'
import { AssignmentEngineError } from './assignment-engine-error'
import { requireActivePlan } from './assignment-engine-plan-lookup'
import type { AssignmentArtifactWriter } from './assignment-engine-artifacts'

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

/**
 * Annotation bookkeeping for the active draft Assignment version: open an
 * annotation, edit it while open, and resolve it. Only the latest draft
 * version is mutable; signed-off versions are immutable.
 */
export class AssignmentAnnotations {
  constructor(
    private readonly repo: AssignmentRepo,
    private readonly artifacts: AssignmentArtifactWriter,
    private readonly now: () => number,
    private readonly idFactory: () => string
  ) {}

  private requireMutableVersion(
    projectId: string,
    coordinatorThreadId: string,
    assignmentId: string,
    version: number
  ): AssignmentPlan {
    const active = requireActivePlan(this.repo, projectId, coordinatorThreadId)
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

  async add(
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
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  async update(
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
    await this.artifacts.writeMarkdown(updated)
    return updated
  }

  async resolve(
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
    await this.artifacts.writeMarkdown(updated)
    return updated
  }
}
