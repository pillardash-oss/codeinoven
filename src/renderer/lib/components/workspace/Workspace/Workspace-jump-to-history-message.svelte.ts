import { workspaceState } from '$lib/stores/workspace.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceJumpToHistoryMessage {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceJumpToHistoryMessage read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  /** Whether the message-history jump menu (first item on the context dock) is open. */
  showHistoryMenu = $state(false)

  jumpToHistoryMessage(id: string): void {
    this.showHistoryMenu = false
    workspaceState.jumpToMessage?.(id)
  }
}
