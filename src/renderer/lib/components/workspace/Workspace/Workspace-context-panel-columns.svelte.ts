import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceContextPanelColumns {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceContextPanelColumns read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  sidebarTrackReserved = $state(false)

  contextPanelColumns = $derived(
    this.sidebarTrackReserved
      ? 'minmax(360px, 1fr) max(0px, min(calc(100% - 360px), var(--context-rail-width)))'
      : 'minmax(0, 1fr)'
  )
}
