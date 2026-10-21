<script lang="ts">
  import type { WorkflowRunFilter } from '$shared/types'

  interface Props {
    /** Which runs the listing keeps; the parent owns it so the pager can reset. */
    filter: WorkflowRunFilter
    onSelect: (next: WorkflowRunFilter) => void
  }

  let { filter, onSelect }: Props = $props()

  /**
   * The states a reader actually narrows to.
   *
   * Every one of them is a server-side qualifier, so filtering never means "the
   * failures on this page": the page that comes back is failures only. The live
   * runs sit at the top of the unfiltered listing anyway, which is why there is no
   * chip for them.
   */
  const filters: Array<{ id: WorkflowRunFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'failed', label: 'Failed' },
    { id: 'succeeded', label: 'Succeeded' }
  ]
</script>

<!--
  The same chips the pull request listing draws, for the same reason: one row of
  choices you can read at a glance, beside the views they narrow.
-->
{#each filters as option (option.id)}
  <button
    type="button"
    class="h-6 shrink-0 cursor-pointer px-2 text-[0.625rem] font-medium transition-colors {filter ===
    option.id
      ? 'bg-elevated text-foreground'
      : 'text-muted hover:text-foreground'}"
    aria-pressed={filter === option.id}
    onclick={() => onSelect(option.id)}
  >
    {option.label}
  </button>
{/each}
