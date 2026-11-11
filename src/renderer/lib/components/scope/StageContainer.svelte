<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioTabGit from '@pdslng/cio-icon/CioTabGit.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import { STAGE_COLORS, STAGE_LABELS, type ThreadStage } from '$lib/stores/scope.svelte'
  import type { Thread } from '$shared/types'
  import { belongsOnProjectBoard } from '$lib/components/threads/thread-dispatch-badge'

  interface Props {
    bucketId: string
    stage: ThreadStage
    threads: Thread[]
    collapsed: boolean
    activeThreadId: string | null
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
    activeThreadId,
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

  /**
   * Bound assistant tasks keep their single home on the Assistant view, so they
   * are never listed on a project's board even though they work in its checkout.
   * Filtering here is what makes "one transcript, one board" hold structurally
   * rather than by convention.
   */
  let boardThreads = $derived(
    threads.filter((thread) => belongsOnProjectBoard(thread, thread.projectId))
  )

  /** The branch every card in this lane shares, which then reads once from the
   *  lane instead of on each card. Null when the lane mixes branches. */
  const sharedBranch = $derived.by(() => {
    if (boardThreads.length < 2) return null
    const first = boardThreads[0]?.branch?.trim() || null
    return first !== null && boardThreads.every((thread) => thread.branch?.trim() === first)
      ? first
      : null
  })

  /** An empty slice folds to a strip: it keeps its count and stays a drop
   *  target, but no longer takes the width a slice with threads needs. */
  const folded = $derived(collapsed || boardThreads.length === 0)

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
  class="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border border-border {folded
    ? 'w-9'
    : 'min-w-0 flex-1'} {dropActive ? 'bg-primary/5' : 'bg-surface'}"
  aria-label="{STAGE_LABELS[stage]} threads"
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  {#if folded}
    <button
      class="flex h-full w-full flex-col items-center gap-2 py-2 transition-colors hover:bg-elevated disabled:cursor-default disabled:hover:bg-transparent"
      style="border-top: 2px solid {STAGE_COLORS[stage]}"
      aria-expanded="false"
      aria-label="Expand {STAGE_LABELS[stage]} slice, {boardThreads.length} threads"
      title={boardThreads.length === 0
        ? `${STAGE_LABELS[stage]}: no threads`
        : `Expand ${STAGE_LABELS[stage]}`}
      disabled={boardThreads.length === 0}
      onclick={onToggle}
    >
      <span class="text-[0.625rem] tabular-nums text-dimmed">{boardThreads.length}</span>
      <span
        class="rotate-180 text-[0.625rem] font-semibold uppercase tracking-wide text-muted [writing-mode:vertical-rl]"
      >
        {STAGE_LABELS[stage]}
      </span>
    </button>
  {:else}
    <div
      class="sticky top-0 z-20 flex h-9 shrink-0 items-center border-b border-border bg-surface"
      style="border-top: 2px solid {STAGE_COLORS[stage]}"
    >
      <button
        class="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-elevated"
        aria-expanded="true"
        aria-label="Collapse {STAGE_LABELS[stage]} slice"
        title="Collapse {STAGE_LABELS[stage]}"
        onclick={onToggle}
      >
        <CioChevronDown size={13} class="shrink-0 text-dimmed" />
        <span class="text-[0.6875rem] font-semibold uppercase tracking-wide text-foreground">
          {STAGE_LABELS[stage]}
        </span>
        {#if sharedBranch}
          <span
            class="ml-auto flex min-w-0 items-center gap-1 text-[0.625rem] text-dimmed"
            title={`Every thread here is on ${sharedBranch}`}
          >
            <CioTabGit size={10} class="shrink-0" aria-hidden="true" />
            <span class="truncate">{sharedBranch}</span>
          </span>
        {/if}
        <span class="{sharedBranch ? '' : 'ml-auto '}text-[0.625rem] tabular-nums text-dimmed"
          >{boardThreads.length}</span
        >
      </button>
    </div>

    <div class="min-h-0 flex-1 space-y-px overflow-y-auto py-1" role="list">
      {#each boardThreads as thread (thread.id)}
        <div data-scope-thread-row="true">
          <ThreadRow
            {thread}
            selected={activeThreadId === thread.id}
            hideScope
            hideBranch={sharedBranch}
            {onOpen}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            onMoveThread={onReorderThread}
          />
        </div>
      {/each}
    </div>
  {/if}
</section>
