<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Project } from '$shared/types'

  let {
    project,
    children
  }: { project: Project; expanded?: boolean; actions?: Snippet; children?: Snippet } = $props()
</script>

<div data-project-row={project.id}>
  {@render children?.()}
</div>
