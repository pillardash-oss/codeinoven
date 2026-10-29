import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceContextPanelRows {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root) throw new Error('WorkspaceContextPanelRows read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  terminalTrackReserved = $state(false)

  // A folded dock leaves no restore strip behind: the context dock's terminal
  // icon is always on screen and is the way back, so hiding the terminal really
  // does give the full height back to the thread.
  contextPanelRows = $derived(
    this.terminalTrackReserved
      ? `minmax(240px, 1fr) minmax(0, min(${contextSidebarState.terminalHeight}px, calc(100% - 240px)))`
      : 'minmax(0, 1fr)'
  )
}
