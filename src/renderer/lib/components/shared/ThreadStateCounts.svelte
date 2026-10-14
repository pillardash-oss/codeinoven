<script lang="ts">
  import StatusBadge from './StatusBadge.svelte'
  import { hasThreadStateCounts, type ThreadStateCounts } from '$lib/thread-state-counts'

  interface Props {
    /** The working / attention / error breakdown for the row's threads. */
    counts: ThreadStateCounts
    class?: string
  }

  let { counts, class: className = '' }: Props = $props()

  const visible = $derived(hasThreadStateCounts(counts))

  /**
   * One label for the whole cluster. The individual badges are rendered
   * decoratively, so this is the single accessible name and the single tooltip
   * for the group instead of one per dot.
   */
  const label = $derived.by(() => {
    const parts: string[] = []
    if (counts.working > 0) {
      parts.push(`${counts.working} ${counts.working === 1 ? 'thread' : 'threads'} working`)
    }
    if (counts.attention > 0) {
      parts.push(
        `${counts.attention} ${counts.attention === 1 ? 'thread needs' : 'threads need'} attention`
      )
    }
    if (counts.error > 0) {
      parts.push(`${counts.error} ${counts.error === 1 ? 'thread' : 'threads'} failed`)
    }
    return parts.join(', ')
  })
</script>

{#if visible}
  <span class="flex items-center gap-1.5 {className}" role="img" aria-label={label} title={label}>
    {#if counts.working > 0}
      <span class="flex items-center gap-1">
        <StatusBadge stage="working" animated decorative />
        <span class="text-[0.5625rem] font-semibold tabular-nums text-thread-working">
          {counts.working}
        </span>
      </span>
    {/if}
    {#if counts.attention > 0}
      <span class="flex items-center gap-1">
        <StatusBadge tone="attention" decorative />
        <span class="text-[0.5625rem] font-semibold tabular-nums text-warning">
          {counts.attention}
        </span>
      </span>
    {/if}
    {#if counts.error > 0}
      <span class="flex items-center gap-1">
        <StatusBadge tone="error" decorative />
        <span class="text-[0.5625rem] font-semibold tabular-nums text-danger">{counts.error}</span>
      </span>
    {/if}
  </span>
{/if}
