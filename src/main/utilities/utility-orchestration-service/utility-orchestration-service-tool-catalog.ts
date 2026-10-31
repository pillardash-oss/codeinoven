import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import type { ScopeToolExecutor, TurnState } from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService tool-catalog: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceToolCatalog {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /**
   * Register the executor behind the app-owned `cio:scope` utility. Scope and
   * worktree management is an ordinary app-owned utility rather than a listed
   * tool: most turns never touch a worktree, and a turn that does not must not
   * carry the capability's contract in its context. The chat engine supplies the
   * executor because it owns the thread's scope, project root and permission
   * tier.
   */
  setScopeToolExecutor(executor: ScopeToolExecutor | null): void {
    this.host.scopeToolExecutor = executor
  }

  /**
   * App-owned scope and worktree management for the calling thread, reached
   * through the gateway's invoke route. The chat engine owns the thread's
   * scope, project root and permission tier, so the executor receives them
   * instead of re-deriving them here.
   */
  async runScopeTool(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const execute = this.host.scopeToolExecutor
    if (!execute) {
      throw new Error(
        'Scope management is unavailable in this session. Ask the user to manage scopes from the project board.'
      )
    }
    const request = state.request
    const action = typeof input['action'] === 'string' ? input['action'] : 'unknown'
    // Audited without paths or arguments: that a turn reached for scope
    // management is the durable fact, the scope contents are user data.
    await this.host.units['orchestration'].audit(state, 'scope.tool', {
      action,
      confirmation: input['confirm'] === true
    })
    return await execute(input, {
      projectId: request.projectId,
      scopeBucketId: request.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID,
      threadId: request.threadId,
      threadTitle: request.threadTitle ?? '',
      permissionLevel: request.permissionLevel
    })
  }
}
