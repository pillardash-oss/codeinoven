<script lang="ts">
  import { FileDiff, Files } from '@lucide/svelte'
  import { threadChangesState } from '$lib/stores/thread-changes.svelte'

  const current = $derived(threadChangesState.current)
  const fileCount = $derived(threadChangesState.fileCount)
  const totals = $derived(threadChangesState.totals)
  const heading = $derived(threadChangesState.working ? 'This turn' : 'Last turn')
  /** Files past nine read as "9+" so the count never grows past two glyphs. */
  const fileLabel = $derived(fileCount > 9 ? '9+' : String(fileCount))

  // A live turn's line totals are counted on demand, so the bounded live-diff
  // pass runs only while this flyout is on screen. Reading the summary makes
  // the effect re-run (and recount) when the turn's change set moves under it;
  // the store's own shape key keeps an unchanged set from re-scanning.
  $effect(() => {
    const summary = threadChangesState.current
    if (summary?.status === 'active') void threadChangesState.ensureLiveTotals()
  })
</script>

{#if current && fileCount > 0}
  <!-- The rail's own tooltip already carries the plain-text summary; this card
       is the richer, icon-led read, so it is presentational for narration. -->
  <div class="min-w-36 border border-border bg-surface px-2.5 py-2 shadow-lg" aria-hidden="true">
    <p class="mb-1.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
      {heading}
    </p>
    <div class="flex items-center justify-between gap-3 text-[0.6875rem] font-medium tabular-nums">
      {#if totals}
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
      <FileDiff size={12} class="shrink-0 text-dimmed" />
    </div>
    <div
      class="mt-1 flex items-center gap-1.5 text-[0.6875rem] font-medium tabular-nums text-muted"
    >
      <Files size={12} class="shrink-0 text-dimmed" />
      {fileLabel}
    </div>
  </div>
{/if}
