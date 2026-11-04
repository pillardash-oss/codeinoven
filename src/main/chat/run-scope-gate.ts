import { isBoundAssistantTask } from '../../lib/bound-scope'
import type { ThreadScopeRootProvider } from '../../lib/engines/thread-manager'
import type { ScopeWorktreeHealthCategory, Thread } from '../../lib/types'
import { ScopeRootUnavailableError } from '../workspaces/scope-root-resolver'

/**
 * The gate a bound assistant run passes before it starts.
 *
 * A bound task's evidence lives in a real project checkout, and that checkout
 * can be missing, unregistered, locked, on the wrong branch or moved. The one
 * outcome that must never happen is silence: the run would then write its files
 * into the assistant's app-storage directory while the user believes it worked
 * in their project.
 *
 * So the gate inspects the bound scope first. A healthy or project-rooted scope
 * proceeds; an unhealthy one parks the run with the category the resolver
 * reported and the repair guidance the app already owns, and the caller refuses
 * to start the turn.
 *
 * It performs one resolve through the same authority every other surface uses,
 * so the gate can never disagree with the rail about whether a checkout is
 * usable. Nothing here spawns a process or touches the database.
 */

/** A healthy gate: the run may start. */
export interface RunScopeGateProceed {
  action: 'proceed'
  /** The checkout the run will work in, for a bound task. */
  root: string | null
}

/** An unhealthy gate: the run must not start. */
export interface RunScopeGatePark {
  action: 'park'
  category: ScopeWorktreeHealthCategory
  /** The app's own guidance, including the repair action that resolves it. */
  message: string
  projectId: string
  scopeBucketId: string
}

export type RunScopeGateResult = RunScopeGateProceed | RunScopeGatePark

/** Raised when a turn is refused because its bound scope is unusable. */
export class RunScopeParkedError extends Error {
  constructor(readonly parkReason: NonNullable<Thread['parkReason']>) {
    super(parkReason.message)
    this.name = 'RunScopeParkedError'
  }
}

export class RunScopeGate {
  constructor(private readonly scopeRoots: ThreadScopeRootProvider | undefined) {}

  /**
   * Refuse a turn whose bound scope is unusable, parking the run first.
   *
   * Parking is what makes the refusal visible: the run row keeps the category
   * and the app's own repair guidance, so the user's next step is a repair
   * action rather than a mystery. The throw is what stops the turn.
   */
  async guard(
    thread: Thread | null | undefined,
    park: (reason: NonNullable<Thread['parkReason']>) => Promise<unknown>
  ): Promise<void> {
    const result = await this.inspect(thread)
    if (result.action === 'proceed') return
    const parkReason = {
      category: result.category,
      message: result.message,
      projectId: result.projectId,
      scopeBucketId: result.scopeBucketId
    }
    await park(parkReason)
    throw new RunScopeParkedError(parkReason)
  }

  /** Inspect the thread's bound scope. Unbound threads always proceed. */
  async inspect(thread: Thread | null | undefined): Promise<RunScopeGateResult> {
    if (!isBoundAssistantTask(thread) || !thread || !thread.boundScope) {
      return { action: 'proceed', root: null }
    }
    const { projectId, scopeBucketId } = thread.boundScope
    if (!this.scopeRoots) {
      // Without a resolver the run cannot prove its checkout, and a run that
      // cannot prove where it writes is exactly the one that must not start.
      return {
        action: 'park',
        category: 'repository-unavailable',
        message: 'This task is bound to a project, but its scope could not be resolved.',
        projectId,
        scopeBucketId
      }
    }
    try {
      const root = await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
      if (!root) {
        return {
          action: 'park',
          category: 'repository-unavailable',
          message: 'This task is bound to a project that has no usable checkout.',
          projectId,
          scopeBucketId
        }
      }
      return { action: 'proceed', root }
    } catch (error) {
      if (error instanceof ScopeRootUnavailableError) {
        return {
          action: 'park',
          category: error.health.category,
          // The resolver's own guidance, so a parked run and the scope card tell
          // the user the same thing.
          message: error.message,
          projectId,
          scopeBucketId
        }
      }
      throw error
    }
  }
}
