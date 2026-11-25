<script lang="ts">
  import type { Thread } from '$shared/types'

  /**
   * The two shapes the threads timeline draws with the real section: the pinned
   * block's rows, and one status group's header with its fold toggle.
   *
   * The header is a real button so a test folds and unfolds a group exactly the
   * way a reader does, through the sidebar's own toggle handler.
   */
  let {
    label = '',
    threads = [],
    headerOnly = false,
    folded = false,
    onToggleFold
  }: {
    label?: string
    threads?: Thread[]
    headerOnly?: boolean
    folded?: boolean
    onToggleFold?: () => void
  } = $props()
</script>

{#if headerOnly}
  <button
    type="button"
    data-group-heading={label}
    data-folded={folded ? '' : undefined}
    onclick={() => onToggleFold?.()}
  >
    {label}
  </button>
{:else}
  {#each threads as thread (thread.id)}
    <div data-thread-row={thread.id} data-pinned=""></div>
  {/each}
{/if}
