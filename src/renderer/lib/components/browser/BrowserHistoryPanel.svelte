<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Clock, Search, Star, X } from '@lucide/svelte'
  import { browserHistoryMatches, browserLibraryHost } from '$shared/browser/browser-library'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { BROWSER_HISTORY_GLOBAL_SCOPE, browserHistory } from '$lib/stores/browser-history.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import BrowserLibraryRow from './BrowserLibraryRow.svelte'
  import { relativeTime } from '$lib/format/relative-time'

  /**
   * The browsing history, docked in the browser's right rail.
   *
   * History belongs to a browser rather than to a tab, so this panel works with the
   * strip empty as well as with a page on screen, and its rows open in the tab on
   * screen   the page moves under the user, exactly as clicking a bookmark does,
   * which is what makes a history row a navigation rather than a file.
   *
   * It lists visits from the active profile scope, named by `scopeKey`. The global
   * browser's rail is the only surface with a history panel today, so its selected
   * box determines the list; thread address bars resolve to that same list when
   * they use the box.
   *
   * The list is bounded on screen, not in the store: the history itself holds up to
   * the configured cap, and a panel that drew a thousand rows would cost more than
   * the memory is worth. The newest slice is what is drawn, and the footer says so.
   */

  interface Props {
    /** The browser whose visits this panel lists. */
    scopeKey?: string
  }

  let { scopeKey = BROWSER_HISTORY_GLOBAL_SCOPE }: Props = $props()

  /** How many rows the panel draws at once. */
  const VISIBLE_LIMIT = 200

  let query = $state('')
  /** The entry the user asked to forget, held while the confirmation is up. */
  let forgettingUrl = $state<string | null>(null)

  /** Whether this browser's list survives a restart, which is what the empty-state
   *  message promises. */
  const durable = $derived(browserHistory.isDurableScope(scopeKey))
  const entries = $derived(browserHistory.entriesFor(scopeKey))

  /** Which addresses are already saved, as one set: a row asking the bookmark list
   *  per render would be a linear scan per row over a list this panel does not own. */
  const bookmarkedUrls = $derived(new SvelteSet(browserBookmarks.bookmarks.map((b) => b.url)))

  const matching = $derived(entries.filter((entry) => browserHistoryMatches(entry, query)))
  const visible = $derived(matching.slice(0, VISIBLE_LIMIT))

  // The global list is durable app state in main, and the store only reads it once
  // the browser's runtime comes up. Asking here reconciles a panel that a session
  // opened before it ever reached the browser, the same way the downloads panel
  // does.
  onMount(() => browserHistory.start())

  function forget(): void {
    const url = forgettingUrl
    forgettingUrl = null
    if (url) browserHistory.forget(scopeKey, url)
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
        bind:value={query}
      />
      {#if query !== ''}
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
          aria-label="Clear the history search"
          title="Clear search"
          onclick={() => (query = '')}
        >
          <X size={13} />
        </button>
      {/if}
    </div>
  </div>

  {#if entries.length === 0}
    <EmptyState
      icon={Clock}
      title="No history yet"
      description={durable
        ? 'Pages you visit in this browser are kept here, so you can find your way back to them after a restart.'
        : 'Pages you visit in this browser are kept here while it is open.'}
    />
  {:else if matching.length === 0}
    <EmptyState
      icon={Search}
      title="No matching pages"
      description="Nothing in your history matches that search."
    />
  {:else}
    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each visible as entry (entry.url)}
        {@const bookmarked = bookmarkedUrls.has(entry.url)}
        <li>
          <BrowserLibraryRow
            title={entry.title}
            meta="{browserLibraryHost(entry.url)} · {relativeTime(entry.visitedAt)}"
            url={entry.url}
            onOpen={() => globalBrowser.openInActiveTab(entry.url)}
          >
            {#snippet actions()}
              <button
                type="button"
                class={[
                  'flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-overlay',
                  bookmarked ? 'text-warning' : 'text-dimmed hover:text-foreground'
                ]}
                aria-label={bookmarked
                  ? `Remove ${entry.title} from bookmarks`
                  : `Bookmark ${entry.title}`}
                aria-pressed={bookmarked}
                title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
                onclick={() => browserBookmarks.toggle(entry.url, entry.title)}
              >
                <Star size={12} class={bookmarked ? 'fill-current' : ''} />
              </button>
              <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-danger"
                aria-label={`Forget ${entry.title}`}
                title="Forget this page"
                onclick={() => (forgettingUrl = entry.url)}
              >
                <X size={12} />
              </button>
            {/snippet}
          </BrowserLibraryRow>
        </li>
      {/each}
    </ul>
    <p class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] text-dimmed">
      {#if visible.length < matching.length}
        Showing the {VISIBLE_LIMIT} most recent of {matching.length} pages
      {:else}
        {matching.length}
        {matching.length === 1 ? 'page' : 'pages'}
      {/if}
    </p>
  {/if}
</div>

<ConfirmDialog
  open={forgettingUrl !== null}
  title="Forget this page?"
  confirmLabel="Forget page"
  variant="danger"
  onConfirm={forget}
  onCancel={() => (forgettingUrl = null)}
>
  <p>The page leaves your browsing history. The rest of your history is kept.</p>
</ConfirmDialog>
