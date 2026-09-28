<script lang="ts">
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import {
    contextSidebarState,
    type BrowserDownloadsContextTab,
    type BrowserPopupWindowsContextTab,
    type ContextSidebarTab
  } from '$lib/stores/context-sidebar.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
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
   * - notifications, the app's own panel the header bell opens,
   * - the active tab's note, the same note a thread has (only the subject
   *   differs),
   * - the active tab's agent conversation, the app's own temporary side chat
   *   bound to the tab instead of to a workspace thread,
   * - the active tab's popup windows, one tab per window the page opened,
   * - the profile's downloads, which need no tab and keep the rail present.
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
  /**
   * The popup windows panel. A popup belongs to the tab whose page opened it,
   * like the note and the agent chat do, so the panel is only listed while a tab
   * is on screen.
   */
  const popupsTab: BrowserPopupWindowsContextTab = {
    id: 'browser-popup-windows',
    kind: 'popup-windows',
    title: 'Popup windows'
  }
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
    ...(noteTab ? [noteTab] : []),
    ...(agentTab ? [agentTab] : []),
    popupsTab,
    downloadsTab,
    ...(notificationsTab ? [notificationsTab] : [])
  ] satisfies ContextSidebarTab[])
  const activeTabId = $derived(
    notificationsTab?.id ??
      (globalBrowser.agentSidebarShown
        ? (agentTab?.id ?? null)
        : globalBrowser.popupsSidebarShown
          ? popupsTab.id
          : globalBrowser.downloadsSidebarShown
            ? downloadsTab.id
            : (noteTab?.id ?? null))
  )

  /** Switching tools keeps the rail on the chosen panel; closing a panel hides
   *  it, so a browser tab's agent chat closes the rail rather than dropping the
   *  conversation (closing the browser tab does). */
  function selectTool(tabId: string): void {
    if (notificationsTab && tabId === notificationsTab.id) return
    if (tabId === popupsTab.id) {
      globalBrowser.showPopupsSidebar()
      return
    }
    if (tabId === downloadsTab.id) {
      globalBrowser.showDownloadsSidebar()
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
    if (tabId === popupsTab.id) {
      globalBrowser.closePopupsSidebar()
      return
    }
    if (tabId === downloadsTab.id) {
      globalBrowser.closeDownloadsSidebar()
      return
    }
    if (agentTab && tabId === agentTab.id) globalBrowser.closeAgentSidebar()
    else onClose()
  }
</script>

{#snippet railContent()}
  {#if notificationsTab}
    {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
      <NotificationPanel />
    {/await}
  {:else if globalBrowser.popupsSidebarShown}
    {#await import('./BrowserPopupWindowsPanel.svelte') then { default: BrowserPopupWindowsPanel }}
      <BrowserPopupWindowsPanel />
    {/await}
  {:else if globalBrowser.downloadsSidebarShown}
    {#await import('./BrowserDownloadsPanel.svelte') then { default: BrowserDownloadsPanel }}
      <BrowserDownloadsPanel />
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
    onWidthChange={(width) => contextSidebarState.setWidth(width)}
    onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
    onTerminalPlacementChange={() => {}}
  />
</div>
