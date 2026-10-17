<script lang="ts">
  import CioChevronDown from '$lib/components/icons/cio/CioChevronDown.svelte'
  import { slide } from 'svelte/transition'
  import type { Component, Snippet } from 'svelte'
  import ThreadRow from './ThreadRow.svelte'
  import type { Thread } from '$shared/types'
  import { pinnedFold, type PinnedSectionKey } from '$lib/stores/pinned-fold.svelte'
  import { foldSlide } from '$lib/components/shared/card-motion'

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
    /**
     * Keep the header at the top of the sidebar's scroller while the block's own
     * rows pass underneath, so the block can be folded without scrolling back to
     * its top.
     *
     *  Only a block that owns its rows passes this. Its wrapper spans header and
     *  rows, so the button sticks for exactly as long as the block is on screen
     *  and the next header takes the top as this one leaves. A keyed-group header
     *  (`headerOnly`) has no wrapper of its own to stick inside, so the host that
     *  owns its section carries the sticking on the wrapper it renders around this
     *  header (see the grouped list in WorkspaceSidebar); passing this alongside
     *  `headerOnly` has no effect.
     */
    sticky?: boolean
    /** The class the block's own wrapper carries below its rows.
     *
     *  A host that has no header after this block lets the block own its break
     *  (the default). A host whose next block is a status group passes the same
     *  break a group carries, so the pinned rows sit exactly as far from the first
     *  group as two groups sit from each other. */
    trailingClass?: string
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
    headerOnly = false,
    sticky = false,
    trailingClass = 'mb-3 pb-3'
  }: Props = $props()

  const folded = $derived(controlledFolded ?? pinnedFold.isFolded(sectionKey))

  /** The header of a keyed group list (the threads view's status groups) sits in
   *  the same two columns a row does: the fold control takes the mark column, so
   *  the group's glyph and label land on the axis the row titles start at.
   *
   *  A pinned section keeps the plain header it has always had: it is a section
   *  of rows, not a parent of them, and it is titled by nothing but its label.
   *
   *  A keyed-group header carries no box of its own: any wrapper between it and
   *  the section it heads becomes its containing block, and a wrapper only as tall
   *  as the header leaves the header no room to stick at all, so it would scroll
   *  away exactly as before. `display: contents` hands the header straight to the
   *  section, which spans the header and its rows and is therefore the only shape
   *  in which the header can stay put and be pushed out by the next section. The
   *  host owns the break: it trails the group's rows, so neighbouring headings meet
   *  edge to edge and hand the top line over with nothing uncovered between them
   *  (see the grouped list in WorkspaceSidebar), so this renders none of its own
   *  when it is a plain header. A block that follows the groups emits the same
   *  break through `trailingClass`, so the pinned rows sit as far from the first
   *  group as two groups sit from each other. */
  const wrapperClass = $derived(headerOnly ? 'contents' : trailingClass)
  const buttonClass = $derived(
    [
      'flex w-full items-center text-left transition-colors hover:bg-overlay',
      headerOnly ? 'gap-2 py-1.5 pr-2 pl-0' : 'gap-1.5 px-2 py-1.5',
      !headerOnly && sticky ? 'sticky -top-2 z-10 bg-surface' : ''
    ].join(' ')
  )
</script>

{#if threads.length > 0}
  <div class={wrapperClass}>
    <button
      type="button"
      class={buttonClass}
      aria-expanded={!folded}
      aria-label="{folded ? 'Expand' : 'Fold'} {label}"
      title="{folded ? 'Expand' : 'Fold'} {label}"
      onclick={() => (onToggleFold ? onToggleFold() : pinnedFold.toggle(sectionKey))}
    >
      <!-- The fold control is one column wide only for a keyed group, so the
           glyph that follows it starts where a row's content starts. -->
      <span class="flex shrink-0 justify-center {headerOnly ? 'w-[1.125rem]' : ''}">
        <CioChevronDown
          size={12}
          class="text-dimmed transition-transform {folded ? '-rotate-90' : ''}"
        />
      </span>
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
      <!-- The fold plays the same motion as every other fold in the app
           (`foldSlide`), so a pinned section closing or opening moves rather
           than blinks. A status group's rows already get this: the sidebar drops
           them from its own keyed list, which the `animate:` on that list
           animates. This one owns its rows, so it carries the transition
           itself. -->
      <div transition:slide={foldSlide()} class="space-y-px" role="list">
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
