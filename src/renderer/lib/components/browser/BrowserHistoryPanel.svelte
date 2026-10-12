<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Star, X } from '@lucide/svelte'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { BROWSER_HISTORY_GLOBAL_SCOPE, browserHistory } from '$lib/stores/browser-history.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { DEFAULT_BOX_ID } from '$shared/browser/global-browser-tabs'
  import BrowserHistoryList from './BrowserHistoryList.svelte'

  /**
   * The browsing history, docked in the browser's right rail.
   *
   * History belongs to a browser rather than to a tab, so this panel works with the
   * strip empty as well as with a page on screen, and its rows open in the tab on
   * screen   the page moves under the user, exactly as clicking a bookmark does,
   * which is what makes a history row a navigation rather than a file.
   *
   * The list itself is {@link BrowserHistoryList}, shared with the full-screen
   * history manager: this panel only decides which surface's visits to show and what
   * each row's controls do. It lists visits from the active profile scope, named by
   * `scopeKey`. The global browser's rail is the only surface with a history panel
   * today, so its selected box determines the list; thread address bars resolve to
   * that same list when they use the box.
   */

  interface Props {
    /** The browser whose visits this panel lists. */
    scopeKey?: string
  }

  let { scopeKey = BROWSER_HISTORY_GLOBAL_SCOPE }: Props = $props()

  /** The entry the user asked to forget, held while the confirmation is up. */
  let forgettingUrl = $state<string | null>(null)

  /** Whether this browser's list survives a restart, which is what the empty-state
   *  message promises. */
  const durable = $derived(browserHistory.isDurableScope(scopeKey))
  const entries = $derived(browserHistory.entriesFor(scopeKey))

  /** Which addresses are already saved, as one set: a row asking the bookmark list
   *  per render would be a linear scan per row over a list this panel does not own. */
  const bookmarkBoxId = $derived(
    scopeKey === BROWSER_HISTORY_GLOBAL_SCOPE ? null : (globalBrowser.activeTab?.boxId ?? null)
  )
  const bookmarkedUrls = $derived(
    new SvelteSet(
      browserBookmarks.bookmarks
        .filter(
          (bookmark) =>
            (bookmark.boxId ?? null) === (bookmarkBoxId === DEFAULT_BOX_ID ? null : bookmarkBoxId)
        )
        .map((bookmark) => bookmark.url)
    )
  )

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

<BrowserHistoryList
  {entries}
  onOpen={(url) => globalBrowser.openInActiveTab(url)}
  emptyDescription={durable
    ? 'Pages you visit in this browser are kept here, so you can find your way back to them after a restart.'
    : 'Pages you visit in this browser are kept here while it is open.'}
>
  {#snippet rowActions(entry)}
    {@const bookmarked = bookmarkedUrls.has(entry.url)}
    <button
      type="button"
      class={[
        'flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-overlay',
        bookmarked ? 'text-warning' : 'text-dimmed hover:text-foreground'
      ]}
      aria-label={bookmarked ? `Remove ${entry.title} from bookmarks` : `Bookmark ${entry.title}`}
      aria-pressed={bookmarked}
      title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
      onclick={() => browserBookmarks.toggle(entry.url, entry.title, null, bookmarkBoxId)}
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
</BrowserHistoryList>

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
