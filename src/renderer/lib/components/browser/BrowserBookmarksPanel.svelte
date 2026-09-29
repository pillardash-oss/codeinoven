<script lang="ts">
  import { onMount } from 'svelte'
  import { Bookmark, Search, X } from '@lucide/svelte'
  import { browserLibraryHost } from '$shared/browser/browser-library'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import BrowserLibraryRow from './BrowserLibraryRow.svelte'

  /**
   * The saved pages, docked in the browser's right rail.
   *
   * Bookmarks belong to the person rather than to a tab, so the panel works with
   * the strip empty as well as with a page on screen, and a row opens in the tab on
   * screen: a bookmark is a place to go, so it moves the page the user is on.
   *
   * Nothing evicts here, which is why this panel has no cap and no footer: the list
   * only shrinks because the user said so.
   */

  let query = $state('')
  /** The bookmark the user asked to remove, held while the confirmation is up. */
  let removingId = $state<string | null>(null)

  const matching = $derived(browserBookmarks.search(query))

  // Ask for the stored list on mount: the panel can be the first browser surface a
  // session opens, and the store only reads the file once the runtime comes up.
  onMount(() => browserBookmarks.start())

  function remove(): void {
    const id = removingId
    removingId = null
    if (id) browserBookmarks.remove(id)
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
        <li>
          <BrowserLibraryRow
            title={bookmark.title}
            meta={browserLibraryHost(bookmark.url)}
            url={bookmark.url}
            onOpen={() => globalBrowser.openInActiveTab(bookmark.url)}
          >
            {#snippet actions()}
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-danger"
                aria-label={`Remove ${bookmark.title} from bookmarks`}
                title="Remove bookmark"
                onclick={() => (removingId = bookmark.id)}
              >
                <X size={12} />
              </button>
            {/snippet}
          </BrowserLibraryRow>
        </li>
      {/each}
    </ul>
    <p class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] text-dimmed">
      {matching.length}
      {matching.length === 1 ? 'saved page' : 'saved pages'}
    </p>
  {/if}
</div>

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
