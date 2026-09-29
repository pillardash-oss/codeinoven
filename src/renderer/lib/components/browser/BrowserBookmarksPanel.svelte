<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Bookmark,
    ChevronDown,
    ChevronUp,
    Ellipsis,
    Globe,
    Pencil,
    Search,
    Trash2,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { browserLibraryHost, type BrowserBookmark } from '$shared/browser/browser-library'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import BrowserLibraryRow from './BrowserLibraryRow.svelte'
  import BrowserBookmarkModal from './BrowserBookmarkModal.svelte'
  import { browserBookmarkIconUrl } from './browser-bookmark-appearance'

  /**
   * The saved pages, docked in the browser's right rail.
   *
   * A saved page is quick access the user keeps, so this panel is where it is
   * shaped: a row opens the page in the tab on screen, and its menu renames,
   * re-addresses, re-icons, reorders and removes it. The row carries the same
   * affordances in both directions: right-clicking anywhere on it opens the menu,
   * and the ellipsis does that same thing in one click.
   *
   * It belongs to the person rather than to a tab, so the panel works with the
   * strip empty as well as with a page on screen.
   *
   * Nothing evicts here, which is why this panel has no cap and no footer control
   * for one: the list only shrinks because the user said so.
   */

  let query = $state('')
  /** The bookmark the user asked to remove, held while the confirmation is up. */
  let removingId = $state<string | null>(null)
  /** The bookmark whose editor is open, or null while it is closed. */
  let editingId = $state<string | null>(null)
  /** The row whose menu is open. One menu serves the whole list, so the open row is
   *  identified rather than held, which is also what lets the row's own context
   *  menu open it. */
  let menuOpenId = $state<string | null>(null)
  /** The row being dragged, and where the row under the pointer would take it. */
  let draggingId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)
  let dropPosition = $state<'before' | 'after' | null>(null)

  const matching = $derived(browserBookmarks.search(query))

  // Ask for the stored list on mount: the panel can be the first browser surface a
  // session opens, and the store only reads the file once the runtime comes up.
  onMount(() => browserBookmarks.start())

  // A saved page's chosen image icon is a file on disk, so its bytes are read once
  // and cached; this keeps the rows' icons current without each row reading one.
  $effect(() => {
    for (const bookmark of browserBookmarks.bookmarks) {
      if (bookmark.imagePath && !browserBookmarks.iconUrls.has(bookmark.id)) {
        void browserBookmarks.ensureIconLoaded(bookmark.id)
      }
    }
  })

  function remove(): void {
    const id = removingId
    removingId = null
    if (id) browserBookmarks.remove(id)
  }

  /** Open a row's menu, whichever gesture asked for it. */
  function openMenu(event: MouseEvent, id: string): void {
    event.preventDefault()
    menuOpenId = id
  }

  function onDragStart(event: DragEvent, bookmark: BrowserBookmark): void {
    draggingId = bookmark.id
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', bookmark.id)
  }

  function onDragOver(event: DragEvent, bookmark: BrowserBookmark): void {
    if (draggingId === null || draggingId === bookmark.id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropTargetId = bookmark.id
    dropPosition = event.clientY < box.top + box.height / 2 ? 'before' : 'after'
  }

  function onDrop(event: DragEvent, bookmark: BrowserBookmark): void {
    event.preventDefault()
    const dragged = draggingId ?? event.dataTransfer?.getData('text/plain') ?? ''
    const position = dropPosition
    endDrag()
    if (dragged === '' || dragged === bookmark.id || position === null) return
    // The neighbour the dragged row lands in front of: the row it was dropped on,
    // or the one after it when it was dropped on that row's lower half. Resolved
    // against the list on screen, so a drag in a filtered list still lands where
    // the user dropped it.
    const index = matching.findIndex((candidate) => candidate.id === bookmark.id)
    const before = position === 'before' ? bookmark.id : (matching[index + 1]?.id ?? null)
    browserBookmarks.moveBefore(dragged, before)
  }

  function endDrag(): void {
    draggingId = null
    dropTargetId = null
    dropPosition = null
  }

  /** Move a row one place up, as the list on screen shows it. */
  function moveUp(bookmark: BrowserBookmark): void {
    const index = matching.findIndex((candidate) => candidate.id === bookmark.id)
    const previous = matching[index - 1]
    if (!previous) return
    browserBookmarks.moveBefore(bookmark.id, previous.id)
  }

  /** Move a row one place down: in front of whatever follows the next row, or to
   *  the end when this is the second to last. */
  function moveDown(bookmark: BrowserBookmark): void {
    const index = matching.findIndex((candidate) => candidate.id === bookmark.id)
    browserBookmarks.moveBefore(bookmark.id, matching[index + 2]?.id ?? null)
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center gap-1.5 rounded-lg bg-elevated px-2.5">
      <Search size={13} class="shrink-0 text-dimmed" />
      <input
        type="text"
        class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search bookmarks"
        aria-label="Search bookmarks"
        spellcheck="false"
        autocomplete="off"
        bind:value={query}
      />
      {#if query !== ''}
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Clear the bookmark search"
          title="Clear search"
          onclick={() => (query = '')}
        >
          <X size={13} />
        </button>
      {/if}
    </div>
  </div>

  {#if browserBookmarks.bookmarks.length === 0}
    <EmptyState
      icon={Bookmark}
      title="No bookmarks yet"
      description="Save a page from the star beside its address, and it appears here to return to at any time."
    />
  {:else if matching.length === 0}
    <EmptyState
      icon={Search}
      title="No matching bookmarks"
      description="Nothing you saved matches that search."
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each matching as bookmark (bookmark.id)}
        {@const rowIndex = matching.indexOf(bookmark)}
        <li
          class="relative"
          draggable="true"
          ondragstart={(event: DragEvent) => onDragStart(event, bookmark)}
          ondragover={(event: DragEvent) => onDragOver(event, bookmark)}
          ondragleave={() => {
            if (dropTargetId === bookmark.id) {
              dropTargetId = null
              dropPosition = null
            }
          }}
          ondrop={(event: DragEvent) => onDrop(event, bookmark)}
          ondragend={endDrag}
          oncontextmenu={(event: MouseEvent) => openMenu(event, bookmark.id)}
        >
          {#if dropTargetId === bookmark.id && dropPosition === 'before'}
            <span class="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-primary"
            ></span>
          {/if}
          <BrowserLibraryRow
            title={bookmark.title}
            meta={browserLibraryHost(bookmark.url)}
            url={bookmark.url}
            onOpen={() => globalBrowser.openInActiveTab(bookmark.url)}
          >
            {#snippet icon()}
              {@render BookmarkIcon({ bookmark })}
            {/snippet}
            {#snippet actions()}
              <DropdownMenu.Root
                open={menuOpenId === bookmark.id}
                onOpenChange={(open) => (menuOpenId = open ? bookmark.id : null)}
              >
                <DropdownMenu.Trigger
                  class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-elevated data-[state=open]:text-foreground data-[state=open]:opacity-100"
                  aria-label={`Options for ${bookmark.title}`}
                  title="Bookmark options"
                  oncontextmenu={(event: MouseEvent) => event.preventDefault()}
                >
                  <Ellipsis size={13} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="bottom"
                    align="end"
                    sideOffset={4}
                    collisionPadding={8}
                    class="z-50 w-52 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                  >
                    <p
                      class="truncate px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
                    >
                      {bookmark.title}
                    </p>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                      onSelect={() => (editingId = bookmark.id)}
                    >
                      <Pencil size={13} class="shrink-0 text-muted" />
                      Edit bookmark
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                      disabled={rowIndex === 0}
                      onSelect={() => moveUp(bookmark)}
                    >
                      <ChevronUp size={13} class="shrink-0 text-muted" />
                      Move up
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                      disabled={rowIndex === matching.length - 1}
                      onSelect={() => moveDown(bookmark)}
                    >
                      <ChevronDown size={13} class="shrink-0 text-muted" />
                      Move down
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                      onSelect={() => (removingId = bookmark.id)}
                    >
                      <Trash2 size={13} />
                      Remove bookmark
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            {/snippet}
          </BrowserLibraryRow>
          {#if dropTargetId === bookmark.id && dropPosition === 'after'}
            <span class="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-primary"
            ></span>
          {/if}
        </li>
      {/each}
    </ul>
    <p class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] text-dimmed">
      {matching.length}
      {matching.length === 1 ? 'saved page' : 'saved pages'}
    </p>
  {/if}
</div>

{#snippet BookmarkIcon({ bookmark }: { bookmark: BrowserBookmark })}
  {@const iconUrl = browserBookmarkIconUrl(bookmark, browserBookmarks.iconUrl(bookmark.id))}
  {#if iconUrl}
    <img src={iconUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
  {:else if bookmark.favicon}
    <img src={bookmark.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
  {:else}
    <Globe size={12} class="text-dimmed" />
  {/if}
{/snippet}

{#if editingId !== null}
  <BrowserBookmarkModal bookmarkId={editingId} onClose={() => (editingId = null)} />
{/if}

<ConfirmDialog
  open={removingId !== null}
  title="Remove this bookmark?"
  confirmLabel="Remove bookmark"
  variant="danger"
  onConfirm={remove}
  onCancel={() => (removingId = null)}
>
  <p>The page leaves your bookmarks. You can still find it in your browsing history.</p>
</ConfirmDialog>
