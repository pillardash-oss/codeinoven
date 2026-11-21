<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import WorkspaceSidebar from '$lib/components/workspace/WorkspaceSidebar.svelte'

  type SidebarMode = 'projects' | 'chats' | 'threads'
  type SidebarProps = Omit<ComponentProps<typeof WorkspaceSidebar>, 'mode' | 'activeThreadId'>

  /**
   * Owns the two props the fold-order test moves: the view the sidebar draws and
   * the thread being worked in, which is what returns a group from the foot of
   * the list to its own slot.
   */
  let {
    sidebarProps,
    initialMode,
    initialActiveThreadId
  }: {
    sidebarProps: SidebarProps
    initialMode: SidebarMode
    initialActiveThreadId: string | null
  } = $props()

  // Intentional initial-value capture: the harness owns both from mount on.
  // svelte-ignore state_referenced_locally
  let mode = $state<SidebarMode>(initialMode)
  // svelte-ignore state_referenced_locally
  let activeThreadId = $state<string | null>(initialActiveThreadId)

  export function setMode(next: SidebarMode): void {
    mode = next
  }

  export function setActiveThreadId(next: string | null): void {
    activeThreadId = next
  }
</script>

<WorkspaceSidebar {...sidebarProps} {mode} {activeThreadId} />
