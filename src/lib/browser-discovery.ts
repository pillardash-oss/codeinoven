import { APP_BROWSER_UTILITY_ID } from './utility-ids'

/**
 * The in-app browser, handed back by a capability search that is about a page.
 *
 * A model asked to prove something on a page once concluded the session had no
 * browser, opened its own Playwright chromium and a second dev server, and
 * reported evidence from an origin nobody was watching. The browser was
 * installed the whole time; the search simply ranked utilities and never named
 * it. A page question now names it, its id, and the operations that do the work,
 * so the answer cannot be "there is no browser".
 */
export const BROWSER_SEARCH_INTENT =
  /(?:browser|web ?page|page|tab|screenshot|console|click|type into|navigate|localhost|url|dom|viewport|render(?:ed|ing)?)/iu

/** The search entry for the in-app browser. */
export interface BrowserSearchEntry {
  id: string
  kind: 'tool'
  name: string
  activateWith: string
  callDirectly: false
  description: string
}

export function matchesBrowserSearchIntent(query: string): boolean {
  return BROWSER_SEARCH_INTENT.test(query)
}

export function browserSearchEntry(): BrowserSearchEntry {
  return {
    id: APP_BROWSER_UTILITY_ID,
    kind: 'tool',
    name: 'In-app browser (this app’s own Chromium)',
    activateWith: 'cio_util_init',
    callDirectly: false,
    description:
      'The only browser you have, and it is already installed: activate it with cio_util_init (utility_id "cio:browser"), then drive the page in the tab the user can watch. Operations: open, navigate, reload, run (a whole flow in one call), snapshot, query, screenshot, console, click, type, press, select, check, mouse, drag, scroll, viewport, upload, evaluate, wait. A conversation on the page is yours to finish: send, then poll with wait. Never launch chromium, Chrome, Playwright, Puppeteer or WebKit yourself.'
  }
}
