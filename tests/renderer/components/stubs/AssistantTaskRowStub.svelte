<script lang="ts">
  import type { Thread } from '$shared/types'

  let { task }: { task: Thread } = $props()
</script>

<div data-assistant-task-row={task.id}></div>
