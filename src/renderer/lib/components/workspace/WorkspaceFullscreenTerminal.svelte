<script lang="ts">
  import { SquareTerminal } from '@lucide/svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    tabId: string | null
    onTabIdChange: (id: string | null) => void
    /** Opens a fresh terminal and returns its tab id, or null when unavailable. */
    onNewTerminal: () => string | null
    onCloseTab: (id: string) => void
  }

  let { tabId, onTabIdChange, onNewTerminal, onCloseTab }: Props = $props()

  let fullscreenTabs = $derived(contextSidebarState.tabs.filter((tab) => tab.kind === 'terminal'))
</script>

{#if tabId && fullscreenTabs.length > 0}
  {@const terminalTab = contextSidebarState.tabs.find((t) => t.id === tabId)}
  <FullscreenPanelDialog
    tabs={fullscreenTabs}
    activeTabId={tabId}
    newLabel="New terminal"
    minimizeLabel="Minimize terminal"
    onSelect={(id) => onTabIdChange(id)}
    onCloseTab={(id) => onCloseTab(id)}
    onNew={() => {
      const id = onNewTerminal()
      if (id) onTabIdChange(id)
    }}
    onMinimize={() => onTabIdChange(null)}
  >
    {#snippet icon()}
      <SquareTerminal size={11} class="shrink-0" />
    {/snippet}
    {#if terminalTab?.kind === 'terminal'}
      {#key tabId}
        <TerminalPanel
          terminalId={terminalTab.terminalId}
          projectId={terminalTab.projectId}
          threadId={terminalTab.threadId}
          scopeBucketId={workspaceState.activeScopeBucketIdFor(terminalTab.projectId)}
        />
      {/key}
    {/if}
  </FullscreenPanelDialog>
{/if}
