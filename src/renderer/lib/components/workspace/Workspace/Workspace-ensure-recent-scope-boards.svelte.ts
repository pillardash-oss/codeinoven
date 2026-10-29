import { scopeState } from '$lib/stores/scope.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceEnsureRecentScopeBoards {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceEnsureRecentScopeBoards read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  recentScopeLoadRequest = $state(0)

  async ensureRecentScopeBoards(projectIds: string[]): Promise<void> {
    const request = ++this.recentScopeLoadRequest
    for (const projectId of projectIds) {
      if (request !== this.recentScopeLoadRequest) return
      await scopeState.ensureBoardLoaded(projectId)
    }
  }
}
