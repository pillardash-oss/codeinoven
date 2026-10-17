<script lang="ts">
  import type { Assistant } from '$shared/types'

  let { assistant }: { assistant: Assistant } = $props()
</script>

<div data-assistant-row={assistant.id}></div>
