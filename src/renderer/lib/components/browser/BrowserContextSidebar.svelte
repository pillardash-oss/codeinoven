<script lang="ts">
  import { MessagesCircle, Pencil, X } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import {
    contextSidebarState,
    type BrowserAgentContextTab,
    type BrowserBookmarksContextTab,
    type BrowserBoxesContextTab,
    type BrowserDownloadsContextTab,
    type BrowserExtensionsContextTab,
    type BrowserHistoryContextTab,
    type ContextSidebarTab
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
   * A conversation is deleted by closing it, which is what the tab's close button
   * and its context menu offer. Deleting a transcript is destructive, so the close
   * is confirmed before the thread behind it is deleted; hiding the rail keeps the
   * conversation, and that stays the dock's toggle.
   */
  let renaming = $state<BrowserAgentContextTab | null>(null)
  let renameValue = $state('')
  let renameBusy = $state(false)
  let closing = $state<BrowserAgentContextTab | null>(null)
  let closeBusy = $state(false)

  function startRename(tab: BrowserAgentContextTab): void {
    renaming = tab
    renameValue = tab.title
  }

  async function confirmRename(): Promise<void> {
    const tab = renaming
    const title = renameValue.trim()
    if (!tab || title === '' || title === tab.title) {
      renaming = null
      return
    }
    renameBusy = true
    try {
      await browserAssistant.renameChat(tab.threadId, title)
      renaming = null
    } catch (error) {
      reportError(error, 'The conversation could not be renamed.')
    } finally {
      renameBusy = false
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

  /** The menu item shell, matching the shell every other context menu in the app
   *  uses for a row of the same size. */
  const assistantMenuItemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

  /** Dismiss every popup from the rail: page popups close, extension popups park. */
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
          <BrowserAssistantChatView threadId={agentChat.threadId} />
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

<!--
  The strip tab's right-click menu, for the assistant conversation.

  Renaming is the reason it exists: a conversation is a real chat, so its title is
  the user's to set, and the title the model derives from the first question is
  only a starting point. Closing is offered here too because a conversation is
  deleted by closing it, and the menu is where the user expects to find that.
-->
{#snippet tabMenu(tab: ContextSidebarTab)}
  {#if tab.kind === 'browser-agent'}
    <ContextMenu.Portal>
      <ContextMenu.Content
        avoidCollisions
        collisionPadding={12}
        updatePositionStrategy="always"
        class="z-50 min-w-56 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <p
          class="truncate px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          {tab.title}
        </p>
        <ContextMenu.Item class={assistantMenuItemClass} onSelect={() => startRename(tab)}>
          <Pencil size={13} class="shrink-0 text-muted" />
          Rename
        </ContextMenu.Item>
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item
          class={assistantMenuItemClass}
          onSelect={() => {
            closing = tab
          }}
        >
          <X size={13} class="shrink-0 text-muted" />
          Close conversation
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
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
    {tabMenu}
    onSelect={selectTool}
    onClose={closeTab}
    onCloseAllPopupWindows={closeAllPopups}
    {onWidthChange}
    onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
    onTerminalPlacementChange={() => {}}
  />
</div>

<Modal open={renaming !== null} title="Rename Conversation" onClose={() => (renaming = null)}>
  <form
    id="browser-assistant-rename-form"
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="browser-assistant-rename-input">
        Title
      </label>
      <input
        id="browser-assistant-rename-input"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={renameValue}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={() => (renaming = null)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="browser-assistant-rename-form"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={renameBusy || renameValue.trim() === ''}
      title="Save the new title"
    >
      Save
    </button>
  {/snippet}
</Modal>

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
