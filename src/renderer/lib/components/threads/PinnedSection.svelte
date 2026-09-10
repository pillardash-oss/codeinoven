<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { Thread } from '$shared/types'
  import { pinnedFold, type PinnedSectionKey } from '$lib/stores/pinned-fold.svelte'

  interface Props {
    /** Which persisted fold-state section this block belongs to. */
    sectionKey: PinnedSectionKey
    /** Explicit label, e.g. "Pinned Threads" — distinguishes pinned rows of
     *  different kinds when several pinned blocks are visible at once. */
    label: string
    /** All pinned visible tasks, already in global pin order. */
    threads: Thread[]
    selectedThreadId: string | null
    /** Resolves the row icon for a thread (project icon, type icon, …). */
    getRowIcon: (t: Thread) => string | null
    onOpen: (t: Thread) => void
    onRename: (t: Thread, newName: string) => Promise<void>
    onTogglePin: (t: Thread) => void
    onDelete: (t: Thread) => Promise<void>
    onFork: (t: Thread) => void
    onMovePinnedThread?: (id: string, targetId: string, position: 'before' | 'after') => void
  }

  let {
    sectionKey,
    label,
    threads,
    selectedThreadId,
    getRowIcon,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMovePinnedThread
  }: Props = $props()

  const folded = $derived(pinnedFold.isFolded(sectionKey))
</script>

{#if threads.length > 0}
  <div class="mb-3 pb-3 border-b">
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-overlay"
      aria-expanded={!folded}
      aria-label="{folded ? 'Expand' : 'Fold'} {label}"
      title="{folded ? 'Expand' : 'Fold'} {label}"
      onclick={() => pinnedFold.toggle(sectionKey)}
    >
      <ChevronDown
        size={12}
        class="shrink-0 text-dimmed transition-transform {folded ? '-rotate-90' : ''}"
      />
      <span class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">{label}</span>
      <span class="text-[0.625rem] text-dimmed/70">{threads.length}</span>
    </button>

    {#if !folded}
      <div class="space-y-px" role="list">
        {#each threads as thread (thread.id)}
          <ThreadRow
            {thread}
            compact
            projectIconUrl={getRowIcon(thread)}
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
    {/if}
  </div>
{/if}
