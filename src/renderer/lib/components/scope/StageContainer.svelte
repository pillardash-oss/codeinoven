<script lang="ts">
  import { ChevronDown, ChevronRight } from '@lucide/svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import { STAGE_COLORS, STAGE_LABELS, type ThreadStage } from '$lib/stores/scope.svelte'
  import type { Thread } from '$shared/types'

  interface Props {
    bucketId: string
    stage: ThreadStage
    threads: Thread[]
    collapsed: boolean
    selectedThreadId: string | null
    onToggle: () => void
    onOpen: (thread: Thread) => void
    onRename: (thread: Thread, newName: string) => Promise<void>
    onTogglePin: (thread: Thread) => void
    onDelete: (thread: Thread) => Promise<void>
    onFork: (thread: Thread) => void
    onMoveThread: (threadId: string, bucketId: string) => void
    onReorderThread: (draggedId: string, targetId: string, position: 'before' | 'after') => void
  }

  let {
    bucketId,
    stage,
    threads,
    collapsed,
    selectedThreadId,
    onToggle,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMoveThread,
    onReorderThread
  }: Props = $props()

  let dropActive = $state(false)

  function handleDragOver(event: DragEvent): void {
    event.preventDefault()
    dropActive = true
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }

  function handleDragLeave(event: DragEvent): void {
    const current = event.currentTarget as HTMLElement
    if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
    dropActive = false
  }

  function handleDrop(event: DragEvent): void {
    event.preventDefault()
    dropActive = false
    if (event.target instanceof Element && event.target.closest('[data-scope-thread-row="true"]')) {
      return
    }
    const threadId = event.dataTransfer?.getData('text/plain')
    if (threadId) onMoveThread(threadId, bucketId)
  }
</script>

<section
  class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden rounded-lg {collapsed
    ? 'w-16'
    : 'min-w-0 flex-1'} {dropActive ? 'bg-primary/5' : 'bg-app'}"
  aria-label="{STAGE_LABELS[stage]} threads"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <div
    class="sticky top-0 z-20 flex h-9 shrink-0 items-center rounded-t-lg border-b bg-surface"
    style="border-top: 2px solid {STAGE_COLORS[stage]}"
  >
    <button
      class="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-elevated"
      aria-expanded={!collapsed}
      aria-label="{collapsed ? 'Expand' : 'Collapse'} {STAGE_LABELS[stage]} slice"
      title="{collapsed ? 'Expand' : 'Collapse'} {STAGE_LABELS[stage]}"
      onclick={onToggle}
    >
      {#if collapsed}
        <ChevronRight size={13} class="shrink-0 text-dimmed" />
        <span class="text-[0.625rem] tabular-nums text-dimmed">{threads.length}</span>
        <span class="sr-only">{STAGE_LABELS[stage]}</span>
      {:else}
        <ChevronDown size={13} class="shrink-0 text-dimmed" />
        <span class="text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground">
          {STAGE_LABELS[stage]}
        </span>
        <span class="ml-auto text-[0.625rem] tabular-nums text-dimmed">{threads.length}</span>
      {/if}
    </button>
  </div>

  {#if !collapsed}
    <div class="min-h-0 flex-1 space-y-px overflow-y-auto py-1" role="list">
      {#each threads as thread (thread.id)}
        <div data-scope-thread-row="true">
          <ThreadRow
            {thread}
            selected={selectedThreadId === thread.id}
            hideScope
            {onOpen}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            onMoveThread={onReorderThread}
          />
        </div>
      {:else}
        <p class="px-3 py-4 text-center text-[0.6875rem] text-dimmed">No threads</p>
      {/each}
    </div>
  {/if}
</section>
