import type { ProjectManager } from '../../lib/engines/project-manager'
import type { ScopeManager } from '../../lib/engines/scope-manager'
import type {
  AssignmentWorkerScopeProvisioner,
  WorkerScopeRequest
} from '../../lib/engines/assignment-worker-scope'
import { uniqueScopeName } from '../../lib/scope-naming'
import { AssignmentEngineError } from '../../lib/engines/assignment-engine-error'
import {
  isManagedScopeRoot,
  type ScopeBoardChangedEvent,
  type ScopeBucket,
  type ScopeTarget,
  type ScopeWorktreeProgress,
  type ScopeWorktreeProgressEvent
} from '../../lib/types'
import type { ScopeWorktreeService } from '../git/scope-worktree-service'

export interface AssignmentWorkerScopeServiceOptions {
  /** Broadcast a live board invalidation after a scope is created for a worker. */
  onBoardChanged?: (event: ScopeBoardChangedEvent) => void
  /** Stream the worktree job so it appears in the scope work dock. */
  onProgress?: (event: ScopeWorktreeProgressEvent) => void
}

/**
 * A task title is free text and can be arbitrarily long, but it becomes a scope
 * name a human has to read on the board and may type into the scope tool. The
 * name is cut well before the longest useful scope label rather than allowed to
 * dominate the board.
 */
const WORKER_SCOPE_NAME_LIMIT = 72

/**
 * Places an Assignment worker in the Git scope its task asked for.
 *
 * The Assignment engine cannot create a worktree on its own: that needs the app's
 * scope services, so it delegates here through
 * {@link AssignmentWorkerScopeProvisioner}. A dedicated worker scope is created
 * exactly like an agent-made scope (`createBucket` and then
 * `createManagedWorktree`), with the same rollback, so a worktree that never
 * landed cannot leave an empty project-rooted bucket behind pretending to be a
 * scope.
 */
export class AssignmentWorkerScopeService implements AssignmentWorkerScopeProvisioner {
  constructor(
    private readonly worktrees: ScopeWorktreeService,
    private readonly scopes: ScopeManager,
    private readonly projects: ProjectManager,
    private readonly options: AssignmentWorkerScopeServiceOptions = {}
  ) {}

  async provisionWorkerScope(request: WorkerScopeRequest): Promise<string> {
    switch (request.choice.mode) {
      case 'inherit':
        return request.assignmentScopeBucketId
      case 'scope':
        return this.requireBoardScope(request.projectId, request.choice.bucketId)
      case 'dedicated':
        return await this.ensureDedicatedScope(request)
    }
  }

  /**
   * A scope the user picked off the board. It is checked here rather than trusted
   * because the choice is made before sign-off and the board can change while a
   * long Assignment runs.
   */
  private requireBoardScope(projectId: string, bucketId: string): string {
    const bucket = this.scopes
      .getBoard(projectId)
      .buckets.find((candidate) => candidate.id === bucketId)
    if (!bucket) {
      throw new AssignmentEngineError(
        'scope_unavailable',
        `The scope chosen for this worker no longer exists on the board (${bucketId}). Choose another scope for the task and dispatch it again.`
      )
    }
    return bucket.id
  }

  /**
   * The worker's own worktree. Re-dispatching a task that already owns one reuses
   * the existing checkout, so a replacement worker inherits the branch the failed
   * attempt committed to instead of a second worktree appearing for one task.
   */
  private async ensureDedicatedScope(request: WorkerScopeRequest): Promise<string> {
    if (request.existingBucketId !== undefined) {
      const existing = this.scopes
        .getBoard(request.projectId)
        .buckets.find((candidate) => candidate.id === request.existingBucketId)
      // Only a worktree counts as reuse. A project-rooted bucket means the
      // checkout is gone, so the worker needs a real one rather than the
      // project's own directory, which would defeat the isolation it asked for.
      if (existing && isManagedScopeRoot(existing.root)) return existing.id
    }

    const project = await this.projects.getProject(request.projectId)
    if (!project) {
      throw new AssignmentEngineError(
        'scope_unavailable',
        'The project no longer exists, so a worker worktree cannot be created'
      )
    }
    if (project.source !== 'local' || !project.path) {
      throw new AssignmentEngineError(
        'scope_unavailable',
        'A worker worktree needs a local project repository; this project is remote. Choose another scope for the task.'
      )
    }

    const board = this.scopes.getBoard(request.projectId)
    const name = uniqueScopeName(
      board.buckets.map((candidate) => candidate.name),
      `${request.workerName}: ${request.taskTitle}`.slice(0, WORKER_SCOPE_NAME_LIMIT)
    )
    const bucket = this.scopes.createBucket(request.projectId, { name }).bucket
    const target: ScopeTarget = {
      projectId: request.projectId,
      scopeBucketId: bucket.id
    }
    try {
      const descriptor = await this.worktrees.createManagedWorktree(
        target,
        {
          title: name,
          runSetup: board.worktreeDefaults.runSetupByDefault,
          environmentMode: board.worktreeDefaults.environmentMode
        },
        this.progressFor(target, name)
      )
      this.options.onBoardChanged?.({
        projectId: request.projectId,
        scopeBucketId: bucket.id,
        summary: `created the worker worktree ${bucket.name} on ${descriptor.branch}`
      })
      return bucket.id
    } catch (cause) {
      this.rollbackEmptyBucket(request.projectId, bucket)
      throw cause
    }
  }

  /** Drop a bucket whose worktree never landed, never a bucket already in use. */
  private rollbackEmptyBucket(projectId: string, bucket: ScopeBucket): void {
    const current = this.scopes
      .getBoard(projectId)
      .buckets.find((candidate) => candidate.id === bucket.id)
    if (current && current.root.kind === 'project') {
      this.scopes.deleteBucket(projectId, bucket.id)
    }
  }

  private progressFor(target: ScopeTarget, title: string): (event: ScopeWorktreeProgress) => void {
    return (event) => {
      this.options.onProgress?.({
        projectId: target.projectId,
        scopeBucketId: target.scopeBucketId,
        origin: 'agent',
        title,
        ...event
      })
    }
  }
}
