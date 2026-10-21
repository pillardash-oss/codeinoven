<script lang="ts">
  import type { ChangeArea } from '$shared/change-breakdown'

  interface Props {
    /** The areas a breakdown grouped, already ordered largest first. */
    areas: readonly ChangeArea[]
    /** Areas drawn before the rest fold into a count. */
    limit?: number
    class?: string
  }

  let { areas, limit = 4, class: className = '' }: Props = $props()
  const shown = $derived(areas.slice(0, limit))
  const folded = $derived(areas.length - shown.length)
  /** The whole grouping, for the hover that has no room to draw it. */
  const fullText = $derived(
    areas
      .map((area) =>
        area.additions + area.deletions > 0
          ? `${area.label} +${area.additions} −${area.deletions}`
          : `${area.label} ${area.percentage}%`
      )
      .join(' · ')
  )
</script>

<!-- Where a change set happened, in the space a header has for it: one clause per
     area, with the lines that area accounts for. A header already says how many
     files moved, so this never repeats a file count. -->
{#if areas.length > 0}
  <span
    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 tabular-nums {className}"
    title={fullText}
  >
    {#each shown as area (area.path || area.label)}
      <span class="flex min-w-0 items-center gap-1">
        <span class="truncate text-muted">{area.label}</span>
        {#if area.additions + area.deletions > 0}
          <span class="shrink-0 text-success">+{area.additions}</span>
          <span class="shrink-0 text-danger">−{area.deletions}</span>
        {/if}
      </span>
    {/each}
    {#if folded > 0}
      <span class="shrink-0 text-dimmed">+{folded} more</span>
    {/if}
  </span>
{/if}
