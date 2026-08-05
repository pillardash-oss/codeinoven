<script lang="ts">
  import ThreadRow from './ThreadRow.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { hasProjectNameCollision } from '$lib/project-location'
  import type { Project, Thread } from '$shared/types'

  interface Props {
    /** All pinned, non-archived threads. */
    threads: Thread[]
    /** Project lookup for grouping. */
    projects: Project[]
    selectedThreadId: string | null
    onOpen: (t: Thread) => void
    onRename: (t: Thread, newName: string) => Promise<void>
    onTogglePin: (t: Thread) => void
    onDelete: (t: Thread) => Promise<void>
    onFork: (t: Thread) => void
    onMovePinnedThread?: (
      projectId: string,
      id: string,
      targetId: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    threads,
    projects,
    selectedThreadId,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMovePinnedThread
  }: Props = $props()

  function makeMoveHandler(projectId: string) {
    return (id: string, targetId: string, position: 'before' | 'after') =>
      onMovePinnedThread?.(projectId, id, targetId, position)
  }

  /** Pinned threads grouped by project, preserving project order. */
  let grouped = $derived(
    projects
      .map((project) => {
        const projectThreads = threads.filter((t) => t.projectId === project.id)
        return projectThreads.length > 0 ? { project, threads: projectThreads } : null
      })
      .filter((group): group is { project: Project; threads: Thread[] } => group !== null)
  )
</script>

{#if threads.length > 0}
  <div class="mb-3 pb-3 border-b">
    <div class="flex items-center gap-1.5 px-2 py-1.5">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Pinned</span>
    </div>

    {#each grouped as group (group.project.id)}
      <ProjectIdentity
        project={group.project}
        class="px-2 pt-1 pb-0.5"
        nameClass="text-[10px] font-medium text-muted"
        locationClass="text-[9px] text-dimmed"
        showLocation={hasProjectNameCollision(group.project, projects)}
      />
      <div class="space-y-px" role="list">
        {#each group.threads as thread (thread.id)}
          <ThreadRow
            {thread}
            compact
            selected={selectedThreadId === thread.id}
            {onOpen}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            onMoveThread={onMovePinnedThread ? makeMoveHandler(group.project.id) : undefined}
          />
        {/each}
      </div>
    {/each}
  </div>
{/if}
