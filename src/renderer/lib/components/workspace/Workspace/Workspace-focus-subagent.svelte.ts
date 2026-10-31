import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceFocusSubagent extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  subagentTabs = $derived(contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'subagent'))

  focusSubagent(): void {
    const tab = this.subagentTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }
}
