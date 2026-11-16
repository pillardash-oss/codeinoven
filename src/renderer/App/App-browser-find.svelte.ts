/**
 * The browser find store, loaded on first use.
 *
 * Find belongs to the browser view's pages and is reachable only through its
 * Cmd/Ctrl+F chord, so nothing on the first screen needs this store. It is
 * imported dynamically so its module (the find bar and the state the bar draws)
 * stays out of the initial renderer closure and is fetched by the gesture that
 * actually opens the bar.
 */
import type { BrowserFindDirection } from '$lib/stores/browser-find.svelte'

type BrowserFindModule = typeof import('$lib/stores/browser-find.svelte')
type BrowserFindStore = BrowserFindModule['browserFindState']

let modulePromise: Promise<BrowserFindModule> | null = null

function loadBrowserFind(): Promise<BrowserFindModule> {
  modulePromise ??= import('$lib/stores/browser-find.svelte').catch((error: unknown) => {
    // A transient failure must not poison every later press.
    modulePromise = null
    throw error
  })
  return modulePromise
}

/** Run one find action against the store, loading it if this is the first press. */
function useBrowserFind(action: (store: BrowserFindStore) => void): void {
  void loadBrowserFind().then(
    ({ browserFindState }) => action(browserFindState),
    () => {
      // Nothing to report: the press had no state to act on, and the next press
      // retries the import.
    }
  )
}

/** Show a tab's find bar and hand its field the keyboard. */
export function openBrowserFind(tabId: string): void {
  useBrowserFind((store) => store.open(tabId))
}

/** Step within a tab's search, or open its bar when find is not on screen. */
export function stepBrowserFind(tabId: string, direction: BrowserFindDirection): void {
  useBrowserFind((store) => store.step(tabId, direction))
}
