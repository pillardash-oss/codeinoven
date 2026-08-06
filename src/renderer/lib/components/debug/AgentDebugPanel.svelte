<script lang="ts">
  import { agentDebug } from '$lib/stores/agent-debug.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ExchangeCard from './ExchangeCard.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Bug, BugOff, Eraser } from '@lucide/svelte'

  const expandedIds = new SvelteSet<string>()

  function toggleExpand(id: string): void {
    if (expandedIds.has(id)) {
      expandedIds.delete(id)
    } else {
      expandedIds.add(id)
    }
  }
</script>

{#if import.meta.env.DEV}
<aside
  class="flex h-full w-full flex-col bg-surface"
  aria-label="Agent debug inspector"
>
  <!-- Header -->
  <div class="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
    <div class="flex items-center gap-2">
      <Bug size={14} class="text-muted" />
      <h2 class="text-xs font-semibold text-foreground">Debug</h2>
      {#if agentDebug.exchangeCount > 0}
        <span class="rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted">
          {agentDebug.exchangeCount}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-0.5">
      <button
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label={agentDebug.enabled ? 'Pause capturing' : 'Start capturing'}
        title={agentDebug.enabled ? 'Pause capturing' : 'Start capturing'}
        onclick={() => agentDebug.toggle()}
      >
        {#if agentDebug.enabled}
          <BugOff size={13} class="text-info" />
        {:else}
          <Bug size={13} />
        {/if}
      </button>
      <button
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
        aria-label="Clear log"
        title="Clear log"
        disabled={agentDebug.exchangeCount === 0}
        onclick={() => {
          agentDebug.clear()
          expandedIds.clear()
        }}
      >
        <Eraser size={13} />
      </button>
    </div>
  </div>

  <!-- Filter -->
  <div class="shrink-0 border-b border-border px-3 py-2">
    <input
      type="text"
      class="w-full rounded-md border bg-elevated px-2.5 py-1.5 text-xs text-foreground placeholder:text-dimmed outline-none focus:border-primary"
      placeholder="Filter exchanges..."
      aria-label="Filter debug exchanges"
      bind:value={agentDebug.filterQuery}
    />
  </div>

  <!-- Status bar -->
  <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
    {#if agentDebug.enabled}
      <span class="flex items-center gap-1 text-[10px] text-success">
        <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
        Recording
      </span>
    {:else}
      <span class="flex items-center gap-1 text-[10px] text-dimmed">
        <span class="h-1.5 w-1.5 rounded-full bg-dimmed"></span>
        Paused
      </span>
    {/if}
    {#if agentDebug.exchangeCount > 0}
      <span class="text-[10px] text-dimmed">
        {agentDebug.exchanges.length} shown
        {#if agentDebug.exchanges.length < agentDebug.exchangeCount}
          of {agentDebug.exchangeCount}
        {/if}
      </span>
    {/if}
  </div>

  <!-- Current thread ID -->
  {#if workspaceState.selectedThread}
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <span class="shrink-0 text-[10px] font-medium text-muted">Thread ID:</span>
      <span
        class="min-w-0 flex-1 select-all break-all rounded bg-elevated px-1.5 py-0.5 font-mono text-[10px] leading-relaxed text-foreground"
        title={workspaceState.selectedThread.id}
      >
        {workspaceState.selectedThread.id}
      </span>
    </div>
  {/if}

  <!-- Exchange list -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if !agentDebug.enabled && agentDebug.exchangeCount === 0}
      <div class="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
        <Bug size={20} class="text-dimmed" />
        <p class="text-xs text-muted">Agent debug inspector</p>
        <p class="text-xs text-dimmed">Click the bug icon to start recording</p>
      </div>
    {:else if agentDebug.exchanges.length === 0 && !agentDebug.active}
      <div class="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
        <p class="text-xs text-dimmed">No matching exchanges</p>
      </div>
    {:else}
      <!-- Active exchange (in-progress) -->
      {#if agentDebug.active}
        <div class="border-b-2 border-info/30 bg-info/[0.03]">
          <ExchangeCard ex={agentDebug.active} open={true} />
        </div>
      {/if}

      <!-- Completed exchanges -->
      {#each agentDebug.exchanges as ex (ex.id)}
        {@const isExpanded = expandedIds.has(ex.id)}
        <div class="border-b border-border transition-colors hover:bg-elevated/30">
          <ExchangeCard {ex} open={isExpanded} onToggle={() => toggleExpand(ex.id)} />
        </div>
      {/each}
    {/if}
  </div>
</aside>
{/if}
