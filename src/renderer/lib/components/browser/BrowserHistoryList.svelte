<script lang="ts">
  import { Clock, Search, X } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    browserHistoryMatches,
    browserLibraryHost,
    type BrowserHistoryEntry
  } from '$shared/browser/browser-library'
  import { relativeTime } from '$lib/format/relative-time'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import BrowserLibraryRow from './BrowserLibraryRow.svelte'

  /**
   * The browsing-history list body, shared by the browser rail panel and the
   * full-screen history manager.
   *
   * Both show the same thing, the pages the user has been to, newest first, with a
   * search over them, and differ only in where the rows come from and what each
   * row's controls do. So the search, the pagination and the rows live here once,
   * and the caller supplies the entries and the per-row actions.
   *
   * The whole list is held in memory (the store caps it), but only a batch of it is
   * drawn at a time: a history of ten thousand pages must not put ten thousand rows
   * in the DOM. A sentinel below the last drawn row loads the next batch as it
   * scrolls into view.
   */

  interface Props {
    /** The visits to list, newest first. */
    entries: BrowserHistoryEntry[]
    /** Open one row's page. */
    onOpen: (url: string) => void
    /** The controls beside each row, which differ per surface. */
    rowActions: Snippet<[BrowserHistoryEntry]>
    /** The empty-state copy, which promises what the caller's scope guarantees. */
    emptyDescription: string
  }

  /**
   * How many rows one batch holds.
   *
   * A history can hold up to the configured ten thousand pages, and drawing all
   * of them at once is a wall of DOM. So the list draws this many and grows by
   * this many each time the end is reached, which keeps the rendered window
   * bounded while still reaching every page.
   */
  const BATCH_SIZE = 1_000

  let { entries, onOpen, rowActions, emptyDescription }: Props = $props()

  let query = $state('')
  /** How many matching rows are currently drawn, grown as the sentinel is reached. */
  let visibleCount = $state(BATCH_SIZE)

  const matching = $derived(entries.filter((entry) => browserHistoryMatches(entry, query)))
  const visible = $derived(matching.slice(0, visibleCount))
  const hasMore = $derived(visibleCount < matching.length)

  /**
   * The whole pagination mechanism: while rows are left to draw, an observer
   * watches the spacer below the last one and grows the window when it scrolls
   * into view. The list element is the observer's root, found from the spacer's
   * own parent, so the panel's scroll container is used rather than the window.
   * The attachment is detached with the spacer the moment the last batch is
   * drawn.
   */
  const autoLoadNextBatch: Attachment<HTMLLIElement> = (node) => {
    const root = node.parentElement
    if (!(root instanceof HTMLUListElement)) return
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) visibleCount += BATCH_SIZE
      },
      { root, rootMargin: '400px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }

  /**
   * A new search starts from the first batch, so its first matches are on screen
   * rather than behind however far the previous search had been scrolled.
   */
  function onSearch(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    query = input.value
    visibleCount = BATCH_SIZE
  }

  function clearSearch(): void {
    query = ''
    visibleCount = BATCH_SIZE
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center gap-1.5 rounded-lg bg-elevated px-2.5">
      <Search size={13} class="shrink-0 text-dimmed" />
      <input
        type="text"
        class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search history"
        aria-label="Search browsing history"
        spellcheck="false"
        autocomplete="off"
        value={query}
        oninput={onSearch}
      />
      {#if query !== ''}
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Clear the history search"
          title="Clear search"
          onclick={clearSearch}
        >
          <X size={13} />
        </button>
      {/if}
    </div>
  </div>

  {#if entries.length === 0}
    <EmptyState icon={Clock} title="No history yet" description={emptyDescription} />
  {:else if matching.length === 0}
    <EmptyState
      icon={Search}
      title="No matching pages"
      description="Nothing in your history matches that search."
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each visible as entry (entry.url)}
        <li>
          <BrowserLibraryRow
            title={entry.title}
            meta="{browserLibraryHost(entry.url)} · {relativeTime(entry.visitedAt)}"
            url={entry.url}
            onOpen={() => onOpen(entry.url)}
          >
            {#snippet actions()}
              {@render rowActions(entry)}
            {/snippet}
          </BrowserLibraryRow>
        </li>
      {/each}
      {#if hasMore}
        <li {@attach autoLoadNextBatch} class="h-px" aria-hidden="true"></li>
      {/if}
    </ul>
    <p class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] text-dimmed">
      {#if hasMore}
        Showing {visible.length} of {matching.length} pages
      {:else}
        {matching.length}
        {matching.length === 1 ? 'page' : 'pages'}
      {/if}
    </p>
  {/if}
</div>
