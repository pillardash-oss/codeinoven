<script lang="ts">
  import type { Thread } from '$shared/types'

  let { thread, selected = false }: { thread: Thread; selected?: boolean } = $props()
</script>

<!-- The real row's test hook: a stable element per thread, so a test can prove
     the same node survives a view switch. -->
<div data-thread-row={thread.id} data-selected={selected ? '' : undefined}></div>
