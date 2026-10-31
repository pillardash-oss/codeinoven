import { workspaceState } from '$lib/stores/workspace.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceJumpToHistoryMessage extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  /** Whether the message-history jump menu (first item on the context dock) is open. */
  showHistoryMenu = $state(false)

  jumpToHistoryMessage(id: string): void {
    this.showHistoryMenu = false
    workspaceState.jumpToMessage?.(id)
  }
}
