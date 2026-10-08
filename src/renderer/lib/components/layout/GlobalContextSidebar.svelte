<script lang="ts">
  import ContextSidebar from './ContextSidebar.svelte'
  import { contextSidebarState, type ContextSidebarTab } from '$lib/stores/context-sidebar.svelte'

  let activePanelTab = $derived.by(() => {
    const tab = contextSidebarState.sidebarActiveTab
    return tab && (tab.kind === 'notifications' || tab.kind === 'sticky-notes') ? tab : null
  })
  let tabs: ContextSidebarTab[] = $derived(activePanelTab ? [activePanelTab] : [])
</script>

{#snippet panelContent()}
  {#if activePanelTab?.kind === 'notifications'}
    {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
      <NotificationPanel />
    {/await}
  {:else if activePanelTab?.kind === 'sticky-notes'}
    {#await import('$lib/components/notes/StickyNotesPanel.svelte') then { default: StickyNotesPanel }}
      <StickyNotesPanel />
    {/await}
  {/if}
{/snippet}

{#if contextSidebarState.sidebarVisible && activePanelTab}
  <div
    class="absolute inset-y-0 right-0 z-30 border-l border-border"
    style:width="{contextSidebarState.width}px"
  >
    <ContextSidebar
      {tabs}
      activeTabId={activePanelTab.id}
      width={contextSidebarState.width}
      height={contextSidebarState.terminalHeight}
      content={panelContent}
      onSelect={(id) => contextSidebarState.focus(id)}
      onClose={(id) => contextSidebarState.close(id)}
      onWidthChange={(width) => contextSidebarState.setWidth(width)}
      onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
      onTerminalPlacementChange={(placement) =>
        contextSidebarState.setTerminalPlacement(placement)}
    />
  </div>
{/if}
