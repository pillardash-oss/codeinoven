import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceFocusSubagent {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root) throw new Error('WorkspaceFocusSubagent read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  subagentTabs = $derived(contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'subagent'))

  focusSubagent(): void {
    const tab = this.subagentTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }
}
