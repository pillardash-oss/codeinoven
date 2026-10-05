<script lang="ts">
  import type { Thread } from '$shared/types'

  let { threads = [] }: { threads?: Thread[] } = $props()
</script>

{#each threads as thread (thread.id)}
  <div data-thread-row={thread.id} data-pinned=""></div>
{/each}
