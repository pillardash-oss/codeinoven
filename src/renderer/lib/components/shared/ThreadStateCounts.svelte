<script lang="ts">
  import StatusBadge from './StatusBadge.svelte'
  import { hasThreadStateCounts, type ThreadStateCounts } from '$lib/thread-state-counts'

  interface Props {
    /** The unread / attention / error / working breakdown for the row's threads. */
    counts: ThreadStateCounts
    class?: string
  }

  let { counts, class: className = '' }: Props = $props()

  const visible = $derived(hasThreadStateCounts(counts))

  /** A count over nine is capped, so a cluster never grows past two glyphs. */
  function formatCount(count: number): string {
    return count > 9 ? '9+' : String(count)
  }

  /**
   * One label for the whole cluster. The individual dots are rendered
   * decoratively, so this is the single accessible name and the single tooltip
   * for the group instead of one per dot.
   */
  const label = $derived.by(() => {
    const parts: string[] = []
    if (counts.unread > 0) parts.push(`${counts.unread} unread`)
    if (counts.attention > 0) {
      parts.push(
        `${counts.attention} ${counts.attention === 1 ? 'thread needs' : 'threads need'} attention`
      )
    }
    if (counts.error > 0) parts.push(`${counts.error} ${counts.error === 1 ? 'thread' : 'threads'} failed`)
    if (counts.working > 0) {
      parts.push(`${counts.working} ${counts.working === 1 ? 'thread' : 'threads'} working`)
    }
    return parts.join(', ')
  })
</script>

{#snippet stateItem(color: string, count: number, animated: boolean)}
  <span class="flex items-center gap-1">
    <StatusBadge {color} {animated} decorative />
    <span class="text-[0.5625rem] font-semibold tabular-nums" style="color: {color}">
      {formatCount(count)}
    </span>
  </span>
{/snippet}

{#if visible}
  <span
    class="flex items-center gap-1.5 {className}"
    role="img"
    aria-label={label}
    title={label}
  >
    {#if counts.unread > 0}
      {@render stateItem('var(--color-thread-unread)', counts.unread, false)}
    {/if}
    {#if counts.attention > 0}
      {@render stateItem('var(--color-warning)', counts.attention, true)}
    {/if}
    {#if counts.error > 0}
      {@render stateItem('var(--color-thread-error)', counts.error, false)}
    {/if}
    {#if counts.working > 0}
      {@render stateItem('var(--color-thread-working)', counts.working, true)}
    {/if}
  </span>
{/if}
