<script lang="ts">
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
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
   * every workspace thread docks its panels into. Two tools belong to a browser
   * tab, and neither re-implements a feature that already exists:
   *
   * - its note, which is the same note a thread has (only the subject differs),
   * - its agent conversation, which is the app's own temporary side chat bound to
   *   the tab instead of to a workspace thread.
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

  const tabs = $derived(
    [noteTab, agentTab].filter((tab): tab is NonNullable<typeof tab> => tab !== null)
  )
  const activeTabId = $derived(
    globalBrowser.agentSidebarShown ? (agentTab?.id ?? null) : (noteTab?.id ?? null)
  )

  /** Switching tools from the strip keeps the rail on the chosen panel; closing
   *  a panel is the tab's close button, so a browser tab's agent chat closes the
   *  rail rather than dropping the conversation (closing the browser tab does). */
  function selectTool(tabId: string): void {
    if (agentTab && tabId === agentTab.id) globalBrowser.showAgentSidebar()
    else globalBrowser.showNoteSidebar()
  }

  function closeTab(tabId: string): void {
    if (agentTab && tabId === agentTab.id) globalBrowser.closeAgentSidebar()
    else onClose()
  }
</script>

{#snippet railContent()}
  {#if globalBrowser.agentSidebarShown && agentTab}
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
