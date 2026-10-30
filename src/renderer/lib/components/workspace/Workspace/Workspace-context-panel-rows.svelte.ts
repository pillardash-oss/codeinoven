import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceContextPanelRows extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
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
