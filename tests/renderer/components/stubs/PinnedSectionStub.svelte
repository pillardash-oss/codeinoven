<script lang="ts">
  import type { Thread } from '$shared/types'

  /**
   * The sidebar's section: a heading, and (unless it is drawn header-only) the
   * rows beneath it.
   *
   * `data-thread-group` carries the heading's label so a test can tell which
   * heading a row was drawn under - the grouping under test is invisible in a
   * bare row list.
   */
  let {
    label = '',
    threads = [],
    headerOnly = false
  }: { label?: string; threads?: Thread[]; headerOnly?: boolean } = $props()
</script>

{#if label}
  <div data-thread-group={label} data-header-only={headerOnly ? '' : undefined}></div>
{/if}
{#if !headerOnly}
  {#each threads as thread (thread.id)}
    <div data-thread-row={thread.id} data-pinned=""></div>
  {/each}
{/if}
