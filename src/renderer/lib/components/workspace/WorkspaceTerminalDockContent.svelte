<script lang="ts">
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
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
    {#key activeDockTab.id}
      <TerminalPanel
        terminalId={activeDockTab.terminalId}
        projectId={activeDockTab.projectId}
        threadId={activeDockTab.threadId}
        scopeBucketId={workspaceState.activeScopeBucketIdFor(activeDockTab.projectId)}
      />
    {/key}
  {/if}
{/if}
