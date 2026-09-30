<script lang="ts">
  import { onMount } from 'svelte'
  import FindInBar from '$lib/components/files/FindInBar.svelte'
  import { browserFindState } from '$lib/stores/browser-find.svelte'

  /**
   * The browser's find bar, for the page of one tab.
   *
   * It draws the app's one find bar (`files/FindInBar.svelte`) and does nothing
   * else: the search belongs to the page, the page's own engine reports the match
   * count, and the state a user left behind lives in `browserFindState`, because
   * the sidebar panel and the global Browser view can both show this tab's page.
   *
   * The bar is a row of the surface that shows the page rather than a floating
   * overlay, and deliberately so: a page is a native `WebContentsView` composited
   * above every DOM node, so a bar over it would be invisible unless it also hid
   * the page it is searching.
   */

  interface Props {
    /** The tab whose page this bar searches. */
    tabId: string
  }

  let { tabId }: Props = $props()

  const state = $derived(browserFindState.stateFor(tabId))

  onMount(() => {
    // A bar that comes back carries the query the user last searched, so the page
    // is searched again and its highlight returns with the bar. That is what makes
    // Cmd/Ctrl+F a return to the search rather than a fresh empty one.
    if (state.query.length > 0) browserFindState.setQuery(tabId, state.query)
  })
</script>

<FindInBar
  query={state.query}
  matches={state.matches}
  activeIndex={Math.max(0, state.activeMatchOrdinal - 1)}
  matchCase={state.matchCase}
  focusTrigger={state.focusTrigger}
  placeholder="Find in page…"
  label="Find in page"
  onToggleMatchCase={() => browserFindState.setMatchCase(tabId, !state.matchCase)}
  onQueryChange={(query) => browserFindState.setQuery(tabId, query)}
  onNext={() => browserFindState.step(tabId, 'next')}
  onPrev={() => browserFindState.step(tabId, 'previous')}
  onClose={() => browserFindState.close(tabId)}
/>
