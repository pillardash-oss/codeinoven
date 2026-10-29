import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import type { Workspace } from './Workspace-board.svelte'
/** One concern of the Workspace board. */
export class WorkspaceTemporaryChatTabs {
  #root: Workspace | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): Workspace {
    if (!this.#root)
      throw new Error('WorkspaceTemporaryChatTabs read its board before it was bound')
    return this.#root
  }
  constructor(root: Workspace) {
    this.#root = root
  }
  /** Quick chats and explains open from inside a thread and live in the sidebar
   *  as tabs. The rail mirrors them so they can be toggled away and back without
   *  losing the conversation. Durable audits use the coordinator dock instead. */
  temporaryChatTabs = $derived(
    contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'temporary-chat')
  )

  focusTemporaryChat(): void {
    const tab = this.temporaryChatTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }
}
