<script lang="ts">
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { loadCachedPanelModule, PANEL_KEYS } from '$lib/lazy-panel'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    terminalFullscreenTabId: string | null
  }

  let { terminalFullscreenTabId }: Props = $props()

  let activeDockTab = $derived(contextSidebarState.terminalActiveTab)
</script>

{#if activeDockTab}
  {#if terminalFullscreenTabId === activeDockTab.id}
    <div class="flex h-full items-center justify-center text-xs text-muted">
      Terminal is open in fullscreen
    </div>
  {:else}
    <!-- The terminal is the dock's heaviest resident, so its chunk loads when a
         terminal tab is actually shown instead of on the first screen. -->
    {#await loadCachedPanelModule(PANEL_KEYS.terminal, () => import('$lib/components/terminal/TerminalPanel.svelte')) then { default: TerminalPanel }}
      {#key activeDockTab.id}
        <TerminalPanel
          terminalId={activeDockTab.terminalId}
          projectId={activeDockTab.projectId}
          threadId={activeDockTab.threadId}
          scopeBucketId={workspaceState.activeScopeBucketIdFor(activeDockTab.projectId)}
          directory={activeDockTab.startingDirectory}
        />
      {/key}
    {/await}
  {/if}
{/if}
