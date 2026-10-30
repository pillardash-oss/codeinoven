import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { temporaryChatUnread } from '$lib/stores/temporary-chat-unread.svelte'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceTemporaryChatTabs extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  /** Quick chats and explains open from inside a thread and live in the sidebar
   *  as tabs. The rail mirrors them so they can be toggled away and back without
   *  losing the conversation. Durable audits use the coordinator dock instead. */
  temporaryChatTabs = $derived(
    contextSidebarState.sidebarTabs.filter((tab) => tab.kind === 'temporary-chat')
  )

  /**
   * Side chats of the on-screen thread whose finished response the user has not
   * read yet.
   *
   * The rail icon is the one surface that speaks for every side chat at once
   * while the panel is closed or parked on another tab, so a response that
   * landed out of view would otherwise leave the user with no reason to reopen
   * it.
   */
  unreadTemporaryChats = $derived(
    this.temporaryChatTabs.filter((tab) =>
      temporaryChatUnread.hasUnreadChat(tab.projectId, tab.threadId, tab.temporaryChatId)
    )
  )

  focusTemporaryChat(): void {
    const tab = this.temporaryChatTabs.at(-1)
    if (tab) contextSidebarState.focus(tab.id)
  }
}
