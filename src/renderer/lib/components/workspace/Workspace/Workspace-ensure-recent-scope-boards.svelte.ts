import { scopeState } from '$lib/stores/scope.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceEnsureRecentScopeBoards extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  recentScopeLoadRequest = 0

  async ensureRecentScopeBoards(projectIds: string[]): Promise<void> {
    const request = ++this.recentScopeLoadRequest
    for (const projectId of projectIds) {
      if (request !== this.recentScopeLoadRequest) return
      await scopeState.ensureBoardLoaded(projectId)
    }
  }
}
