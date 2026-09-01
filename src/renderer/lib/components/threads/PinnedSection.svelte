<script lang="ts">
  import ThreadRow from './ThreadRow.svelte'
  import type { Thread } from '$shared/types'

  interface Props {
    /** All pinned visible tasks, already in global pin order. */
    threads: Thread[]
    selectedThreadId: string | null
    /** Resolves the project icon URL for a thread's project. */
    getProjectIconUrl: (projectId: string) => string | null
    onOpen: (t: Thread) => void
    onRename: (t: Thread, newName: string) => Promise<void>
    onTogglePin: (t: Thread) => void
    onDelete: (t: Thread) => Promise<void>
    onFork: (t: Thread) => void
    onMovePinnedThread?: (id: string, targetId: string, position: 'before' | 'after') => void
  }

  let {
    threads,
    selectedThreadId,
    getProjectIconUrl,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMovePinnedThread
  }: Props = $props()
</script>

{#if threads.length > 0}
  <div class="mb-3 pb-3 border-b">
    <div class="flex items-center gap-1.5 px-2 py-1.5">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Pinned</span>
    </div>

    <div class="space-y-px" role="list">
      {#each threads as thread (thread.id)}
        <ThreadRow
          {thread}
          compact
          projectIconUrl={getProjectIconUrl(thread.projectId)}
          selected={selectedThreadId === thread.id}
          {onOpen}
          {onRename}
          {onTogglePin}
          {onDelete}
          {onFork}
          onMoveThread={onMovePinnedThread}
        />
      {/each}
    </div>
  </div>
{/if}
