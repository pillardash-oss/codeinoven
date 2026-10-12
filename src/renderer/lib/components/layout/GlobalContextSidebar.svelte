<script lang="ts">
  import ContextSidebar from './ContextSidebar.svelte'
  import { appPanelSlot } from '$lib/app-panel-portal'
  import { contextSidebarState, type ContextSidebarTab } from '$lib/stores/context-sidebar.svelte'

  let activePanelTab = $derived.by(() => {
    const tab = contextSidebarState.sidebarActiveTab
    return tab && (tab.kind === 'notifications' || tab.kind === 'sticky-notes') ? tab : null
  })
  let tabs: ContextSidebarTab[] = $derived(activePanelTab ? [activePanelTab] : [])
</script>

<!-- The panel body is provided by the single `AppPanelHost` at the app shell;
     this rail only offers the slot it fills, so the panel survives a view
     switch instead of being rebuilt here. -->
{#snippet panelContent()}
  <div class="h-full" {@attach appPanelSlot}></div>
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
      onTerminalPlacementChange={(placement) => contextSidebarState.setTerminalPlacement(placement)}
    />
  </div>
{/if}
