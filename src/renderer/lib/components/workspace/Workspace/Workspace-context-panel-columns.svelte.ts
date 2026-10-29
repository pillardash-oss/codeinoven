import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceContextPanelColumns extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  sidebarTrackReserved = $state(false)

  contextPanelColumns = $derived(
    this.sidebarTrackReserved
      ? 'minmax(360px, 1fr) max(0px, min(calc(100% - 360px), var(--context-rail-width)))'
      : 'minmax(0, 1fr)'
  )
}
