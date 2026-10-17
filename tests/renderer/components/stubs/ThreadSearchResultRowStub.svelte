<script lang="ts">
  import type { ThreadSearchResult } from '$shared/types'

  let { result, selected = false }: { result: ThreadSearchResult; selected?: boolean } = $props()
</script>

<!-- The real row's test hook: one stable element per search hit, so the panel's
     search mode can be told apart from the timeline it replaced. -->
<div data-search-result={result.thread.id} data-selected={selected ? '' : undefined}></div>
