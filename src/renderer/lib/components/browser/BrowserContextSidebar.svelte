<script lang="ts">
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import {
    contextSidebarState,
    type BrowserBookmarksContextTab,
    type BrowserDownloadsContextTab,
    type BrowserHistoryContextTab,
    type ContextSidebarTab
  } from '$lib/stores/context-sidebar.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  /**
   * The browser view's right rail.
   *
   * It is the application's own right sidebar, the same `ContextSidebar` shell
   * every workspace thread docks its panels into, and it hosts the same tools
   * the rest of the app uses, so none is re-implemented here:
   *
   * - the popup windows the active page opened, one tab per window,
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
  const agentTab = $derived(activeTab ? globalBrowser.agentChatTabFor(activeTab.id) : null)
  /**
   * The downloads panel. It belongs to the shared browser profile, not to a tab,
   * so it is a constant here and is the rail tool that survives with no tab.
   */
  const downloadsTab: BrowserDownloadsContextTab = {
    id: 'browser-downloads',
    kind: 'downloads',
    title: 'Downloads'
  }
  /** The browsing history panel. It belongs to the person, not to a tab, so like
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
  /**
   * The popup windows the active page opened, one tab per window.
   *
   * A popup belongs to the tab whose page opened it, like the note and the agent
   * chat do, and the list is main's: the tabs are derived from it, so a window that
   * ends leaves the strip with no surface having to prune anything.
   */
  const popupTabs = $derived(activeTab ? browserPopupWindows.tabsFor(activeTab.id) : [])
  /** The popup the rail is showing, or null while no popup tool is up. */
  const activePopup = $derived(
    activeTab && globalBrowser.popupsSidebarShown
      ? browserPopupWindows.activeFor(activeTab.id)
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

  const tabs = $derived([
    ...popupTabs,
    historyTab,
    bookmarksTab,
    downloadsTab,
    ...(noteTab ? [noteTab] : []),
    ...(agentTab ? [agentTab] : []),
    ...(notificationsTab ? [notificationsTab] : [])
  ] satisfies ContextSidebarTab[])
  const activeTabId = $derived(
    notificationsTab?.id ??
      (globalBrowser.agentSidebarShown
        ? (agentTab?.id ?? null)
        : globalBrowser.popupsSidebarShown
          ? (activePopup?.id ?? null)
          : globalBrowser.downloadsSidebarShown
            ? downloadsTab.id
            : globalBrowser.historySidebarShown
              ? historyTab.id
              : globalBrowser.bookmarksSidebarShown
                ? bookmarksTab.id
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
    if (agentTab && tabId === agentTab.id) globalBrowser.closeAgentSidebar()
    else onClose()
  }

  /** End every popup the page on screen opened, from the rail's own close button.
   *  Each window ends itself through the store, and the strip follows the list, so
   *  there is nothing else to tidy here. */
  function closeAllPopups(): void {
    if (activeTab) browserPopupWindows.closeForTab(activeTab.id)
  }
</script>

{#snippet railContent()}
  {#if notificationsTab}
    {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
      <NotificationPanel />
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
      <BrowserHistoryPanel />
    {/await}
  {:else if globalBrowser.bookmarksSidebarShown}
    {#await import('./BrowserBookmarksPanel.svelte') then { default: BrowserBookmarksPanel }}
      <BrowserBookmarksPanel />
    {/await}
  {:else if globalBrowser.agentSidebarShown && agentTab}
    <!-- Keyed by chat id so switching browser tabs swaps the whole conversation,
         including the controller, which resolves its tab once at mount. -->
    {#key agentTab.id}
      {#await import('$lib/components/chats/TemporaryChatView.svelte') then { default: TemporaryChatView }}
        <TemporaryChatView tabId={agentTab.id} />
      {/await}
    {/key}
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
    onCloseAllPopupWindows={closeAllPopups}
    onWidthChange={(width) => contextSidebarState.setWidth(width)}
    onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
    onTerminalPlacementChange={() => {}}
  />
</div>
