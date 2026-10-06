<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import type { Component, Snippet } from 'svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { Thread } from '$shared/types'
  import { pinnedFold, type PinnedSectionKey } from '$lib/stores/pinned-fold.svelte'

  interface Props {
    /** Which persisted fold-state section this block belongs to. */
    sectionKey: PinnedSectionKey
    /** Explicit label, e.g. "Pinned Threads"   distinguishes pinned rows of
     *  different kinds when several pinned blocks are visible at once. */
    label: string
    /** All pinned visible tasks, already in global pin order. */
    threads: Thread[]
    activeThreadId: string | null
    /** Resolves the row icon for a thread (project icon, type icon, …). */
    getRowIcon?: (t: Thread) => string | null
    /** Render the pinned rows in the detailed (project line, adaptive lines)
     *  layout, so they match the regular rows of the view that hosts them. */
    detailed?: boolean
    /** Hide the project name on the detailed rows, matching a project's own
     *  thread list, which is already named by the folder above it. */
    hideProjectName?: boolean
    onOpen: (t: Thread) => void
    onRename: (t: Thread, newName: string) => Promise<void>
    onTogglePin: (t: Thread) => void
    onDelete: (t: Thread) => Promise<void>
    onFork: (t: Thread) => void
    onMovePinnedThread?: (id: string, targetId: string, position: 'before' | 'after') => void
    /**
     * Row renderer for a pinned thread. Defaults to the standard compact
     * `ThreadRow`, so the project sidebar keeps its rows while a sidebar with
     * its own row component (Assistant tasks) supplies it here and still gets
     * the same pinned section: one header, one fold state, one row list.
     */
    row?: Snippet<[Thread]>
    /** Controlled folding for other thread groups that reuse this section. */
    folded?: boolean
    onToggleFold?: () => void
    /** Optional icon before the label. Only the threads-view status groups
     *  pass one; every other view keeps the plain label. */
    icon?: Component
    /** Optional status colour applied to the icon and the label text. Without
     *  it the header keeps the dimmed look shared by all views. */
    accent?: string
    /** Render only the reusable header when rows belong to a shared keyed list. */
    headerOnly?: boolean
  }

  let {
    sectionKey,
    label,
    threads,
    activeThreadId,
    getRowIcon = () => null,
    detailed = false,
    hideProjectName = false,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMovePinnedThread,
    row,
    folded: controlledFolded,
    onToggleFold,
    icon,
    accent,
    headerOnly = false
  }: Props = $props()

  const folded = $derived(controlledFolded ?? pinnedFold.isFolded(sectionKey))
</script>

{#if threads.length > 0}
  <div class={headerOnly ? 'mt-3 pt-1' : 'mb-3 pb-3'}>
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-overlay"
      aria-expanded={!folded}
      aria-label="{folded ? 'Expand' : 'Fold'} {label}"
      title="{folded ? 'Expand' : 'Fold'} {label}"
      onclick={() => (onToggleFold ? onToggleFold() : pinnedFold.toggle(sectionKey))}
    >
      <ChevronDown
        size={12}
        class="shrink-0 text-dimmed transition-transform {folded ? '-rotate-90' : ''}"
      />
      {#if icon}
        {@const Icon = icon}
        <Icon
          size={12}
          class="shrink-0"
          style={accent ? `color:${accent}` : undefined}
          aria-hidden="true"
        />
      {/if}
      <span
        class="text-[0.625rem] font-semibold uppercase tracking-wide {accent ? '' : 'text-dimmed'}"
        style={accent ? `color:${accent}` : undefined}
      >
        {label}
      </span>
      <span class="text-[0.625rem] text-dimmed/70">{threads.length}</span>
    </button>

    {#if !headerOnly && !folded}
      <div class="space-y-px" role="list">
        {#each threads as thread (thread.id)}
          {#if row}
            {@render row(thread)}
          {:else}
            <ThreadRow
              {thread}
              {detailed}
              {hideProjectName}
              projectIconUrl={getRowIcon(thread)}
              selected={activeThreadId === thread.id}
              {onOpen}
              {onRename}
              {onTogglePin}
              {onDelete}
              {onFork}
              onMoveThread={onMovePinnedThread}
            />
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}
