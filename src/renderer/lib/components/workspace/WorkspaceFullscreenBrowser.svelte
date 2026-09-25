<script lang="ts">
  import { Globe2 } from '@lucide/svelte'
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte'
  import BrowserTabIndicator from '$lib/components/browser/BrowserTabIndicator.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserTabIndicators } from '$lib/stores/browser-tab-status'

  interface Props {
    tabId: string | null
    onTabIdChange: (id: string | null) => void
    /** Opens a fresh browser tab and returns its tab id, or null when unavailable. */
    onNewBrowser: () => string | null
    onCloseTab: (id: string) => void
  }

  let { tabId, onTabIdChange, onNewBrowser, onCloseTab }: Props = $props()

  let fullscreenTabs = $derived(
    contextSidebarState.tabs
      .filter((tab) => tab.kind === 'browser')
      .map((tab) => ({
        id: tab.id,
        title: tab.title,
        // The strip hides the globe for a tab that is playing audio or
        // recording, and the dialog sizes that tab's icon slot from this count.
        indicatorCount: browserTabIndicators(contextSidebarState.browserRuntime(tab.id)).length
      }))
  )

  // While this overlay is up the browser is the surface the user is in, so its
  // keys are the browser's, wherever the focus sits inside the dialog: the
  // strip, the transport, the toolbar or the page. Released with the overlay.
  $effect(() => {
    const active = tabId
    if (!active) return
    browserKeyboardFocus.setClaim('fullscreen', active)
    return () => browserKeyboardFocus.setClaim('fullscreen', null)
  })
</script>

{#if tabId}
  {@const browserTab = contextSidebarState.tabs.find((tab) => tab.id === tabId)}
  {#if browserTab?.kind === 'browser'}
    <FullscreenPanelDialog
      tabs={fullscreenTabs}
      activeTabId={tabId}
      newLabel="New browser tab"
      minimizeLabel="Minimize browser"
      hostsBrowserView
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
      {#snippet tabIndicator(entry)}
        <BrowserTabIndicator tabId={entry.id} />
      {/snippet}
      {#key tabId}
        <BrowserPanel tab={browserTab} fullscreen />
      {/key}
    </FullscreenPanelDialog>
  {/if}
{/if}
