<script lang="ts">
  import { threadChangesState } from '$lib/stores/thread-changes.svelte'

  const current = $derived(threadChangesState.current)
  const fileCount = $derived(threadChangesState.fileCount)
  const totals = $derived(threadChangesState.totals)
  const heading = $derived(threadChangesState.working ? 'This turn' : 'Last turn')
</script>

{#if current && fileCount > 0}
  <!-- The rail's own tooltip already carries the plain-text summary; this card
       is the richer, labelled read, so it is presentational for narration. -->
  <div class="min-w-36 border border-border bg-surface px-2.5 py-2 shadow-lg" aria-hidden="true">
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
    {#each current.breakdown?.categories ?? [] as category (category.label)}
      <div
        class="mt-1 flex items-center justify-between gap-4 text-[0.6875rem] tabular-nums text-muted"
      >
        <span>{category.label}</span>
        <span class="text-foreground"
          >{category.percentage}% ({category.files} {category.files === 1 ? 'file' : 'files'})</span
        >
      </div>
    {/each}
  </div>
{/if}
