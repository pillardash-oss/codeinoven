<script lang="ts">
  import { Globe2 } from '@lucide/svelte'
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'

  interface Props {
    tabId: string | null
    onTabIdChange: (id: string | null) => void
    /** Opens a fresh browser tab and returns its tab id, or null when unavailable. */
    onNewBrowser: () => string | null
    onCloseTab: (id: string) => void
  }

  let { tabId, onTabIdChange, onNewBrowser, onCloseTab }: Props = $props()

  let fullscreenTabs = $derived(contextSidebarState.tabs.filter((tab) => tab.kind === 'browser'))
</script>

{#if tabId}
  {@const browserTab = contextSidebarState.tabs.find((tab) => tab.id === tabId)}
  {#if browserTab?.kind === 'browser'}
    <FullscreenPanelDialog
      tabs={fullscreenTabs}
      activeTabId={tabId}
      newLabel="New browser tab"
      minimizeLabel="Minimize browser"
      onSelect={(id) => onTabIdChange(id)}
      onCloseTab={(id) => onCloseTab(id)}
      onNew={() => {
        const id = onNewBrowser()
        if (id) onTabIdChange(id)
      }}
      onMinimize={() => onTabIdChange(null)}
    >
      {#snippet icon()}
        <Globe2 size={11} class="shrink-0" />
      {/snippet}
      {#key tabId}
        <BrowserPanel tab={browserTab} fullscreen />
      {/key}
    </FullscreenPanelDialog>
  {/if}
{/if}
