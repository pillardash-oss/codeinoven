import type { ScopeChoice } from '../types'
import { AssignmentEngineError } from './assignment-engine-error'

/**
 * Everything the app needs to place one worker in a scope. The engine resolves
 * the worker's name first, because a dedicated scope is named after it.
 */
export interface WorkerScopeRequest {
  projectId: string
  assignmentId: string
  taskId: string
  /** Task title, used to name a scope created for this worker. */
  taskTitle: string
  /** The worker's name inside the Assignment, such as `wrk-delta`. */
  workerName: string
  /** The Assignment's own scope, which the `inherit` choice resolves to. */
  assignmentScopeBucketId: string
  /** The scope chosen for this worker, or the other two choices. */
  choice: ScopeChoice
  /**
   * The scope a previous dispatch of this same task recorded. A retry passes it
   * so the replacement worker lands on the checkout that already holds the
   * failed attempt's commits instead of leaking a second worktree.
   */
  existingBucketId?: string
}

/**
 * Places a worker thread in the Git scope its task asked for.
 *
 * The engine owns Assignment state, not Git: creating a managed worktree needs
 * the app's scope services, which do not exist when the engine is constructed.
 * The app installs its implementation later through
 * `AssignmentEngine.setWorkerScopeProvisioner`, exactly as it installs the scope
 * tool service on the chat engine.
 */
export interface AssignmentWorkerScopeProvisioner {
  /** Resolve the scope bucket a worker's thread must be created in. */
  provisionWorkerScope(request: WorkerScopeRequest): Promise<string>
}

/**
 * The provisioner an engine falls back to when the app has not installed one,
 * which is the case for a bare engine in a test and for the remote RPC engine.
 *
 * It keeps the behaviour every Assignment had before per-worker scopes existed:
 * inherit the Assignment's own scope, or a named scope already chosen for the
 * task. A dedicated worktree cannot be created here, so that request fails
 * loudly instead of quietly running the worker in the wrong checkout.
 */
export const inheritOnlyWorkerScopes: AssignmentWorkerScopeProvisioner = {
  async provisionWorkerScope(request: WorkerScopeRequest): Promise<string> {
    if (request.choice.mode === 'scope') return request.choice.bucketId
    throw new AssignmentEngineError(
      'scope_unavailable',
      'A dedicated worker worktree needs the app scope services, which are not installed'
    )
  }
}
