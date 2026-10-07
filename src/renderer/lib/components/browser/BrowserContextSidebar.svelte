<script lang="ts">
  import { MessagesCircle } from '@lucide/svelte'
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    contextSidebarState,
    type BrowserAgentContextTab,
    type BrowserBookmarksContextTab,
    type BrowserBoxesContextTab,
    type BrowserDownloadsContextTab,
    type BrowserExtensionsContextTab,
    type BrowserHistoryContextTab,
    type ContextSidebarTab,
    STICKY_NOTES_TAB
  } from '$lib/stores/context-sidebar.svelte'
  import { browserAssistant } from '$lib/stores/browser-assistant.svelte'
  import { browserExtensionSidePanels } from '$lib/stores/browser-extension-side-panels.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { browserHistory, BROWSER_HISTORY_GLOBAL_SCOPE } from '$lib/stores/browser-history.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'

  interface Props {
    onClose: () => void
    /** Receives the rail's width for every pointer move. The view that owns the
     *  rail's track passes its own handler, because it also owns the track's
     *  transition: a drag has to track the pointer exactly, and a hosted native
     *  page must not chase an easing frame. */
    onWidthChange?: (width: number) => void
  }

  let { onClose, onWidthChange = (width: number) => contextSidebarState.setWidth(width) }: Props =
    $props()

  /**
   * The browser view's right rail.
   *
   * It is the application's own right sidebar, the same `ContextSidebar` shell
   * every workspace thread docks its panels into, and it hosts the same tools
   * the rest of the app uses, so none is re-implemented here:
   *
   * - every visible popup window in the browser, one tab per window,
   * - the profile's downloads, which need no tab and keep the rail present,
   * - the active tab's note, the same note a thread has (only the subject
   *   differs),
   * - the active tab's agent conversation, the app's own temporary side chat
   *   bound to the tab instead of to a workspace thread,
   * - notifications, the app's own panel the header bell opens.
   *
   * Exactly one is on screen at a time, chosen by the context dock rail, exactly
   * as the workspace picks one tool from its own dock.
   */

  const activeTab = $derived(globalBrowser.activeTab)

  // The note is docked by the store the moment a tab becomes active and while
  // this rail is shown, so nothing here creates it; this only reads the one the
  // store owns.
  const noteTab = $derived(
    activeTab ? contextSidebarState.noteTabFor(GLOBAL_BROWSER_PROJECT_ID, activeTab.id) : null
  )
  const agentChat = $derived(activeTab ? globalBrowser.agentChatFor(activeTab.id) : null)
  /**
   * The active tab's assistant conversation as a rail tab.
   *
   * It exists once the tab has asked the agent something, which is what the rail
   * draws and what the strip names. The conversation is a real thread, so the tab
   * is a view of it: its title is the thread's, and closing the tab deletes the
   * thread.
   */
  const agentTab: BrowserAgentContextTab | null = $derived(
    activeTab && agentChat
      ? {
          id: `browser-agent:${activeTab.id}`,
          kind: 'browser-agent',
          title: agentChat.thread.title,
          projectId: agentChat.thread.projectId,
          threadId: agentChat.thread.id,
          browserTabId: activeTab.id
        }
      : null
  )
  /**
   * The downloads panel. It belongs to the shared browser profile, not to a tab,
   * so it is a constant here and is the rail tool that survives with no tab.
   */
  const downloadsTab: BrowserDownloadsContextTab = {
    id: 'browser-downloads',
    kind: 'downloads',
    title: 'Downloads'
  }
  /** The browsing history panel. It lists the global browser's own visits, so like
   *  the downloads it survives with no tab on screen. */
  const historyTab: BrowserHistoryContextTab = {
    id: 'browser-history',
    kind: 'history',
    title: 'History'
  }
  /** The bookmarks panel, owned by the person for the same reason. */
  const bookmarksTab: BrowserBookmarksContextTab = {
    id: 'browser-bookmarks',
    kind: 'bookmarks',
    title: 'Bookmarks'
  }
  /** The boxes panel. A box belongs to the profile rather than to a page, so like
   *  the downloads and history it survives with no tab, which is exactly when a
   *  user makes their first box. */
  const boxesTab: BrowserBoxesContextTab = {
    id: 'browser-boxes',
    kind: 'boxes',
    title: 'Boxes'
  }
  /** The extensions panel. An extension belongs to the profile rather than to a
   *  page, so like the boxes it survives with no tab, which is exactly when a user
   *  installs their first one. */
  const extensionsTab: BrowserExtensionsContextTab = {
    id: 'browser-extensions',
    kind: 'extensions',
    title: 'Extensions'
  }
  /**
   * The shell tab for an extension's own side panel.
   *
   * The rail's shell renders no content without a tab, and the side panel is one
   * headerless frame that draws its own header, so it takes the same `extensions`
   * kind the other single-frame browser tools use. The tab is never listed in a
   * strip: the shell draws no strip for a headerless kind, and the panel's tool is
   * opened by the extension itself rather than from a strip row.
   */
  const extensionSidePanelTab: BrowserExtensionsContextTab = {
    id: 'browser-extension-side-panel',
    kind: 'extensions',
    title: 'Extension panel'
  }
  /**
   * Every visible popup window in the browser, one tab per window.
   *
   * A popup keeps the tab and box session that opened it, while its rail tab stays
   * available as the user moves between pages and boxes.
   */
  const popupTabs = $derived(browserPopupWindows.tabs())
  /** The browser-wide popup the rail is showing, or null while none are open. */
  const activePopup = $derived(
    globalBrowser.popupsSidebarShown ? browserPopupWindows.active() : null
  )
  /**
   * The extension side panel of the tab on screen, or null while that tool is not
   * up. The rail draws one panel at a time, so the tool and the panel are the same
   * choice, and the frame below names the extension from this record.
   */
  const activeExtensionPanel = $derived(
    activeTab && globalBrowser.extensionSidePanelSidebarShown
      ? browserExtensionSidePanels.panelForTab(activeTab.id)
      : null
  )
  /**
   * The notifications panel is the app's own panel, opened by the header bell,
   * so the rail reads the shared flag instead of keeping a second one. Reading
   * it is what makes notification, note and agent the one right sidebar.
   */
  const notificationsTab = $derived(
    contextSidebarState.sidebarActiveTab?.kind === 'notifications'
      ? contextSidebarState.sidebarActiveTab
      : null
  )
  const stickyNotesTab = $derived(
    contextSidebarState.sidebarActiveTab?.kind === 'sticky-notes' ? STICKY_NOTES_TAB : null
  )

  const tabs = $derived([
    ...popupTabs,
    historyTab,
    bookmarksTab,
    boxesTab,
    extensionsTab,
    ...(globalBrowser.extensionSidePanelSidebarShown ? [extensionSidePanelTab] : []),
    downloadsTab,
    ...(noteTab ? [noteTab] : []),
    ...(agentTab ? [agentTab] : []),
    ...(notificationsTab ? [notificationsTab] : []),
    ...(stickyNotesTab ? [stickyNotesTab] : [])
  ] satisfies ContextSidebarTab[])
  const activeTabId = $derived(
    notificationsTab?.id ??
      stickyNotesTab?.id ??
      (globalBrowser.agentSidebarShown
        ? (agentTab?.id ?? null)
        : globalBrowser.popupsSidebarShown
          ? (activePopup?.id ?? null)
          : globalBrowser.downloadsSidebarShown
            ? downloadsTab.id
            : globalBrowser.boxesSidebarShown
              ? boxesTab.id
              : globalBrowser.extensionsSidebarShown
                ? extensionsTab.id
                : globalBrowser.historySidebarShown
                  ? historyTab.id
                  : globalBrowser.bookmarksSidebarShown
                    ? bookmarksTab.id
                    : globalBrowser.extensionSidePanelSidebarShown
                      ? extensionSidePanelTab.id
                      : (noteTab?.id ?? null))
  )

  /** Whether the tool on screen is a popup window, for the two callbacks that
   *  have to answer differently for it. */
  function isPopupTab(tabId: string): boolean {
    return popupTabs.some((tab) => tab.id === tabId)
  }

  /** Switching tools keeps the rail on the chosen panel; closing a panel hides
   *  it, so a browser tab's agent chat closes the rail rather than dropping the
   *  conversation (closing the browser tab does). */
  function selectTool(tabId: string): void {
    if (notificationsTab && tabId === notificationsTab.id) return
    if (stickyNotesTab && tabId === stickyNotesTab.id) {
      contextSidebarState.showStickyNotes()
      return
    }
    if (isPopupTab(tabId)) {
      browserPopupWindows.select(tabId)
      globalBrowser.showPopupsSidebar()
      return
    }
    if (tabId === downloadsTab.id) {
      globalBrowser.showDownloadsSidebar()
      return
    }
    if (tabId === historyTab.id) {
      globalBrowser.showHistorySidebar()
      return
    }
    if (tabId === bookmarksTab.id) {
      globalBrowser.showBookmarksSidebar()
      return
    }
    if (tabId === boxesTab.id) {
      globalBrowser.showBoxesSidebar()
      return
    }
    if (tabId === extensionsTab.id) {
      globalBrowser.showExtensionsSidebar()
      return
    }
    if (agentTab && tabId === agentTab.id) globalBrowser.showAgentSidebar()
    else globalBrowser.showNoteSidebar()
  }

  function closeTab(tabId: string): void {
    if (notificationsTab && tabId === notificationsTab.id) {
      contextSidebarState.toggleNotifications()
      return
    }
    if (isPopupTab(tabId)) {
      browserPopupWindows.close(tabId)
      return
    }
    if (tabId === extensionSidePanelTab.id) {
      if (activeExtensionPanel) {
        browserExtensionSidePanels.close(activeExtensionPanel.extensionId)
      }
      return
    }
    if (tabId === downloadsTab.id) {
      globalBrowser.closeDownloadsSidebar()
      return
    }
    if (tabId === historyTab.id) {
      globalBrowser.closeHistorySidebar()
      return
    }
    if (tabId === bookmarksTab.id) {
      globalBrowser.closeBookmarksSidebar()
      return
    }
    if (tabId === boxesTab.id) {
      globalBrowser.closeBoxesSidebar()
      return
    }
    if (tabId === extensionsTab.id) {
      globalBrowser.closeExtensionsSidebar()
      return
    }
    if (agentTab && tabId === agentTab.id) closing = agentTab
    else onClose()
  }

  /**
   * The assistant conversation's own actions.
   *
   * A conversation is deleted by closing it, which is what the tab's close
   * button and its native context menu offer. Deleting a transcript is
   * destructive, so the close is confirmed before the thread behind it is
   * deleted; hiding the rail keeps the conversation, and that stays the dock's
   * toggle. Renaming edits the strip title inline: Enter or blur saves,
   * Escape cancels.
   */
  let renamingTabId = $state<string | null>(null)
  let renameValue = $state('')
  let renameBusy = $state(false)
  let closing = $state<BrowserAgentContextTab | null>(null)
  let closeBusy = $state(false)

  function startRename(tab: BrowserAgentContextTab): void {
    renamingTabId = tab.id
    renameValue = tab.title
  }

  async function commitRename(): Promise<void> {
    const tabId = renamingTabId
    const tab = tabId !== null && agentTab?.id === tabId ? agentTab : null
    const title = renameValue.trim()
    if (renameBusy) return
    if (!tab || title === '' || title === tab.title) {
      renamingTabId = null
      return
    }
    renameBusy = true
    try {
      await browserAssistant.renameChat(tab.threadId, title)
      renamingTabId = null
    } catch (error) {
      reportError(error, 'The conversation could not be renamed.')
    } finally {
      renameBusy = false
    }
  }

  function cancelRename(): void {
    if (renameBusy) return
    renamingTabId = null
  }

  /** The agent tab's right-click menu, as an OS-native popup above the page. */
  async function handleAgentTabContextMenu(tabId: string, event: MouseEvent): Promise<void> {
    const tab = agentTab?.id === tabId ? agentTab : null
    if (!tab) return
    event.preventDefault()
    event.stopPropagation()
    const choice = await invoke(
      'browser:agentTabMenu',
      { title: tab.title, threadId: tab.threadId },
      Math.max(0, Math.round(event.clientX)),
      Math.max(0, Math.round(event.clientY))
    ).catch(() => null)
    if (!choice) return
    const current = agentTab?.id === tabId ? agentTab : null
    if (!current) return
    switch (choice.action) {
      case 'rename':
        startRename(current)
        return
      case 'copyThreadId':
        try {
          await invoke('clipboard:writeText', current.threadId)
        } catch (error) {
          reportError(error, 'The thread ID could not be copied.')
        }
        return
      case 'close':
        closing = current
        return
    }
  }

  async function confirmClose(): Promise<void> {
    const tab = closing
    if (!tab) return
    closeBusy = true
    try {
      const chat = browserAssistant.chatForThread(tab.threadId)
      if (chat) await browserAssistant.closeChat(chat)
      closing = null
      globalBrowser.closeAgentSidebar()
    } catch (error) {
      reportError(error, 'The conversation could not be closed.')
    } finally {
      closeBusy = false
    }
  }

  /** Close every visible popup, ending extension action pages too. */
  function closePopups(): void {
    browserPopupWindows.closeAll()
  }
</script>

{#snippet railContent()}
  {#if notificationsTab}
    {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
      <NotificationPanel />
    {/await}
  {:else if stickyNotesTab}
    {#await import('$lib/components/notes/StickyNotesPanel.svelte') then { default: StickyNotesPanel }}
      <StickyNotesPanel />
    {/await}
  {:else if globalBrowser.popupsSidebarShown}
    {#await import('./BrowserPopupWindowPanel.svelte') then { default: BrowserPopupWindowPanel }}
      <BrowserPopupWindowPanel popupId={activePopup?.id ?? ''} />
    {/await}
  {:else if globalBrowser.downloadsSidebarShown}
    {#await import('./BrowserDownloadsPanel.svelte') then { default: BrowserDownloadsPanel }}
      <BrowserDownloadsPanel />
    {/await}
  {:else if globalBrowser.historySidebarShown}
    {#await import('./BrowserHistoryPanel.svelte') then { default: BrowserHistoryPanel }}
      <BrowserHistoryPanel
        scopeKey={browserHistory.scopeFor(
          BROWSER_HISTORY_GLOBAL_SCOPE,
          '',
          activeTab?.boxId ?? null
        )}
      />
    {/await}
  {:else if globalBrowser.bookmarksSidebarShown}
    {#await import('./BrowserBookmarksPanel.svelte') then { default: BrowserBookmarksPanel }}
      <BrowserBookmarksPanel />
    {/await}
  {:else if globalBrowser.boxesSidebarShown}
    {#await import('./BrowserBoxesPanel.svelte') then { default: BrowserBoxesPanel }}
      <BrowserBoxesPanel />
    {/await}
  {:else if globalBrowser.extensionsSidebarShown}
    {#await import('./BrowserExtensionsPanel.svelte') then { default: BrowserExtensionsPanel }}
      <BrowserExtensionsPanel />
    {/await}
  {:else if globalBrowser.extensionSidePanelSidebarShown}
    {#if activeExtensionPanel}
      <!-- Keyed by extension so one panel's frame and native document are torn
           down and parked before the next extension's are placed. -->
      {#key activeExtensionPanel.extensionId}
        {#await import('./BrowserExtensionSidePanel.svelte') then { default: BrowserExtensionSidePanel }}
          <BrowserExtensionSidePanel extensionId={activeExtensionPanel.extensionId} />
        {/await}
      {/key}
    {/if}
  {:else if globalBrowser.agentSidebarShown}
    {#if agentChat}
      <!-- Keyed by thread id so switching browser tabs swaps the whole
           conversation, including the controller, which binds once at mount. -->
      {#key agentChat.threadId}
        {#await import('./BrowserAssistantChatView.svelte') then { default: BrowserAssistantChatView }}
          <BrowserAssistantChatView
            threadId={agentChat.threadId}
            onShowFiles={() => {
              contextSidebarState.openFiles(agentChat.thread.projectId, agentChat.thread.id)
              globalBrowser.showAgentSidebar()
            }}
          />
        {/await}
      {/key}
    {:else}
      <!-- A browser tab nobody has asked the agent about yet. The conversation
           is created by asking for it, so a tab the user only visited is never
           given a transcript they did not want. -->
      <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <MessagesCircle size={20} class="text-dimmed" />
        <p class="text-xs text-muted">Ask the agent about the page on this tab.</p>
        <button
          type="button"
          class="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
          title="Start a conversation about this page"
          onclick={() => globalBrowser.showAgentSidebar()}
        >
          Start a conversation
        </button>
      </div>
    {/if}
  {:else if noteTab}
    {#await import('$lib/components/threads/ThreadNotePanel.svelte') then { default: ThreadNotePanel }}
      <ThreadNotePanel tab={noteTab} />
    {/await}
  {/if}
{/snippet}

<div class="min-h-0 min-w-0 shrink-0" style:width="{contextSidebarState.width}px">
  <ContextSidebar
    {tabs}
    {activeTabId}
    width={contextSidebarState.width}
    height={contextSidebarState.terminalHeight}
    placement="right"
    content={railContent}
    onSelect={selectTool}
    onClose={closeTab}
    onTabContextMenu={(id, event) => void handleAgentTabContextMenu(id, event)}
    renamingTabId={renamingTabId}
    renameValue={renameValue}
    onRenameValueChange={(value) => (renameValue = value)}
    onRenameCommit={() => void commitRename()}
    onRenameCancel={cancelRename}
    onClosePopups={closePopups}
    {onWidthChange}
    onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
    onTerminalPlacementChange={() => {}}
  />
</div>

<ConfirmDialog
  open={closing !== null}
  title="Close Conversation"
  confirmLabel="Close and delete"
  busy={closeBusy}
  onCancel={() => (closing = null)}
  onConfirm={confirmClose}
  note="The conversation is deleted with its transcript. This cannot be undone."
>
  <p>
    Closing this conversation deletes it, together with everything the agent said in it. The page it
    was answering about is not affected.
  </p>
</ConfirmDialog>
