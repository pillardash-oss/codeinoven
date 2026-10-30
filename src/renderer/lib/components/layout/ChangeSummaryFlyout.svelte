<script lang="ts">
  import { threadChangesState } from '$lib/stores/thread-changes.svelte'

  const current = $derived(threadChangesState.current)
  const fileCount = $derived(threadChangesState.fileCount)
  const totals = $derived(threadChangesState.totals)
  const areas = $derived(threadChangesState.breakdown?.areas ?? [])
  const heading = $derived(threadChangesState.working ? 'This turn' : 'Last turn')
</script>

{#if current && fileCount > 0}
  <!-- The rail's hover flyout is this card, so the rail carries no summary of
       its own; this is the one place the line changes are read. -->
  <div class="min-w-44 border border-border bg-surface px-2.5 py-2 shadow-lg" aria-hidden="true">
    <p class="mb-1.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
      {heading}
    </p>
    <div class="flex items-center justify-between gap-3 text-[0.6875rem] font-medium tabular-nums">
      {#if totals}
        <span class="text-muted">Lines</span>
        <span class="flex items-center gap-1.5">
          <span class="text-success">+{totals.additions}</span>
          <span class="text-danger">−{totals.deletions}</span>
          {#if totals.partial}
            <span class="font-normal text-dimmed">partial</span>
          {/if}
        </span>
      {:else}
        <span class="text-dimmed">Counting…</span>
      {/if}
    </div>
    <div
      class="mt-1 flex items-center justify-between gap-4 text-[0.6875rem] tabular-nums text-muted"
    >
      <span>Total files</span><span class="text-foreground">{fileCount}</span>
    </div>
    <!-- One row per area the files share, so the card answers "where is this turn
         happening" as well as "how much". A running turn has no stored line
         counts, so its rows lead with the share of files instead. -->
    {#each areas as area (area.path || area.label)}
      <div
        class="mt-1 flex items-center justify-between gap-3 text-[0.6875rem] tabular-nums text-muted"
        title={area.path || 'Project root'}
      >
        <span class="truncate">{area.label}</span>
        <span class="flex shrink-0 items-center gap-1.5">
          {#if area.additions + area.deletions > 0}
            <span class="text-success">+{area.additions}</span>
            <span class="text-danger">−{area.deletions}</span>
          {:else}
            <span class="text-foreground">{area.percentage}%</span>
          {/if}
          <span class="text-dimmed">
            {area.files}
            {area.files === 1 ? 'file' : 'files'}
          </span>
        </span>
      </div>
    {/each}
  </div>
{/if}
