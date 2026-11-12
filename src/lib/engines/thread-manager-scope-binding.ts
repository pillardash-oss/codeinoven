import type { BoundScopeRebind, Thread } from '../types'
import { usesThreadWorkspaceMount } from '../types'
import type { ProjectRepo } from '../../main/database/repositories/project-repo'
import type { ScopeManager } from './scope-manager'

/**
 * Main-process injection point that resolves a scope target into its
 * authoritative filesystem root. The persisted `Thread.workingDirectory` is
 * compatibility data; this provider is the authority at creation time.
 */
export interface ThreadScopeRootProvider {
  /**
   * Resolve the compatibility working directory for a thread in the given
   * scope. Returns null when the scope is unknown/project-rooted without a
   * local project. Throws when a managed scope root is unhealthy.
   */
  resolveCompatibilityRoot(projectId: string, scopeBucketId?: string): Promise<string | null>
}

/**
 * Owns the two questions a thread's scope binding asks of the filesystem: does
 * the scope a binding names still exist, and which authoritative root does a
 * scope resolve to?
 *
 * A thread's `workingDirectory` is compatibility data that has to agree with its
 * scope, so every path that sets it (creating a thread, rebinding a task, moving
 * a thread between scopes) resolves through here instead of trusting a renderer
 * supplied directory.
 */
export class ThreadScopeBindingService {
  constructor(
    private readonly projectRepo: ProjectRepo,
    private readonly scopeManager: ScopeManager,
    private readonly scopeRoots: ThreadScopeRootProvider | undefined
  ) {}

  /** Whether a main-process root provider is wired at all. */
  get hasScopeRoots(): boolean {
    return this.scopeRoots !== undefined
  }

  /**
   * The authoritative root of a scope, or null when this process was never
   * given a provider to resolve one with.
   */
  async resolveRoot(projectId: string, scopeBucketId?: string): Promise<string | null> {
    if (!this.scopeRoots) return null
    return this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
  }

  /**
   * Assert that a bound scope names a project that exists and a bucket that is
   * still on that project's board.
   *
   * Shape validation happens at the IPC boundary; existence is a database
   * question and belongs where both repos are already in hand. A removed scope
   * is rejected rather than accepted and followed to the Default scope, because
   * a binding is a user's explicit choice of checkout.
   */
  async assertBoundScopeTarget(boundScope: BoundScopeRebind): Promise<void> {
    const project = await this.projectRepo.getViaWorker(boundScope.projectId)
    if (!project) {
      throw new Error(`Project not found: ${boundScope.projectId}`)
    }
    const board = await this.scopeManager.getBoardSnapshot(boundScope.projectId)
    if (!board.buckets.some((bucket) => bucket.id === boundScope.scopeBucketId)) {
      throw new Error(`Scope ${boundScope.scopeBucketId} is not on project ${boundScope.projectId}`)
    }
  }

  /**
   * Synchronize a thread's compatibility working directory with its scope's
   * authoritative root. Renderer-supplied directories never win when the
   * scope resolves; unhealthy managed scopes fail closed.
   */
  async resolveCompatibilityRoot(
    projectId: string,
    scopeBucketId: string | undefined,
    thread: Thread
  ): Promise<void> {
    if (!this.scopeRoots || !scopeBucketId) return
    // A conversation container mounts its own app-storage workspace
    // (`chats-cwd/`, `assistant-cwd/`, `browser-cwd/`) and owns no repository
    // scope, so no bucket on it can ever name a checkout. Resolving one made a
    // create in the assistant space fail closed after the row was already
    // announced, and the thread was deleted seconds after it appeared.
    if (usesThreadWorkspaceMount(projectId)) return
    const resolved = await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
    if (resolved) thread.workingDirectory = resolved
  }

  /**
   * A bound task's compatibility directory comes from its bound scope.
   *
   * Fail-closed on purpose: an unhealthy managed scope throws out of the
   * provider, and the caller parks the run with that reason instead of letting
   * the thread keep whatever directory it had.
   */
  async resolveBoundCompatibilityRoot(boundScope: BoundScopeRebind, thread: Thread): Promise<void> {
    if (!this.scopeRoots) return
    const resolved = await this.scopeRoots.resolveCompatibilityRoot(
      boundScope.projectId,
      boundScope.scopeBucketId
    )
    if (resolved) thread.workingDirectory = resolved
  }
}
