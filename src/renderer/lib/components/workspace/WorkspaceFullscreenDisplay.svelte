<script lang="ts">
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import DisplayPanel from '$lib/components/display/DisplayPanel.svelte'
  import DisplaySourceIcon from '$lib/components/display/DisplaySourceIcon.svelte'
  import { contextSidebarState, type DisplayContextTab } from '$lib/stores/context-sidebar.svelte'

  /**
   * A display tab, full window.
   *
   * A phone in a 340 px dock is a thumbnail; the same frame filling the window is
   * how a person actually reads what an agent is doing on it. The surface is the
   * same one the terminal and the browser use, so its strip, its way out and its
   * Cmd+W behaviour are not a second set of rules.
   */

  interface Props {
    tabId: string | null
    onTabIdChange: (id: string | null) => void
    /** Opens a fresh chooser tab and returns its id, or null when unavailable. */
    onNewTarget: () => string | null
    onCloseTab: (id: string) => void
  }

  let { tabId, onTabIdChange, onNewTarget, onCloseTab }: Props = $props()

  const displayTabs = $derived(
    contextSidebarState.tabs.filter((tab): tab is DisplayContextTab => tab.kind === 'display')
  )
  const activeTab = $derived(displayTabs.find((tab) => tab.id === tabId) ?? null)
</script>

{#if tabId && displayTabs.length > 0}
  <FullscreenPanelDialog
    tabs={displayTabs.map((tab) => ({ id: tab.id, title: tab.title }))}
    activeTabId={tabId}
    newLabel="Mirror another target"
    minimizeLabel="Minimize display"
    scrim={false}
    onSelect={(id) => onTabIdChange(id)}
    onCloseTab={(id) => onCloseTab(id)}
    onNew={() => {
      const id = onNewTarget()
      if (id) onTabIdChange(id)
    }}
    onMinimize={() => onTabIdChange(null)}
  >
    {#snippet tabIcon({ id }: { id: string })}
      {@const tab = displayTabs.find((candidate) => candidate.id === id)}
      <DisplaySourceIcon kind={tab?.sourceKind ?? null} size={12} class="shrink-0" />
    {/snippet}
    {#if activeTab}
      <!-- The dock's own body, so a tab that is still choosing a target shows the
           chooser here too instead of waiting for a frame it has no source for. -->
      {#key activeTab.id}
        <DisplayPanel tab={activeTab} />
      {/key}
    {/if}
  </FullscreenPanelDialog>
{/if}
