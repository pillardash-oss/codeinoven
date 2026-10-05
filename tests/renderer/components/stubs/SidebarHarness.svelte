<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import WorkspaceSidebar from '$lib/components/workspace/WorkspaceSidebar.svelte'

  type SidebarMode = 'projects' | 'chats' | 'threads'
  type SidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'mode'>

  /**
   * Owns the sidebar's `mode` as reactive state, because a mounted component
   * cannot rewrite its own props: the sidebar test switches views through this
   * wrapper, which is exactly what the shell does when the reader picks a view.
   */
  let { sidebarProps, initialMode }: { sidebarProps: SidebarProps; initialMode: SidebarMode } =
    $props()

  // Intentional initial-value capture: the harness owns `mode` from mount on.
  // svelte-ignore state_referenced_locally
  let mode = $state<SidebarMode>(initialMode)

  export function setMode(next: SidebarMode): void {
    mode = next
  }
</script>

<WorkspaceSidebar {...sidebarProps} {mode} />
