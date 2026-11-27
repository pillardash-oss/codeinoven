<script lang="ts">
  import type { ComponentProps } from 'svelte'
  import WorkspaceSidebar from '$lib/components/workspace/WorkspaceSidebar.svelte'
  import type { Thread } from '$shared/types'

  type SidebarProps = Omit<
    ComponentProps<typeof WorkspaceSidebar>,
    'mode' | 'unpinnedTimelineThreads'
  >

  /**
   * Owns the Threads pane's rows as reactive state, because a mounted component
   * cannot rewrite its own props: this harness is the workspace handing the
   * sidebar a new list, which is exactly what a read broadcast does.
   */
  let { sidebarProps, threads: initialThreads }: { sidebarProps: SidebarProps; threads: Thread[] } =
    $props()

  // Intentional initial-value capture: the harness owns the rows from mount on.
  // svelte-ignore state_referenced_locally
  let threads = $state<Thread[]>(initialThreads)

  export function setThreads(next: Thread[]): void {
    threads = next
  }
</script>

<WorkspaceSidebar {...sidebarProps} mode="threads" unpinnedTimelineThreads={threads} />
