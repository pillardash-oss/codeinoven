/**
 * The one seam that wires the in-app browser's renderer runtime.
 *
 * This module is deliberately reachable only through a dynamic import, from
 * `browser-access.svelte.ts`. It statically imports every browser store, so
 * anything that imported it statically would pull the whole browser - the strip's
 * model, its persistence, the sidebar's tab controller, the design inspector -
 * into the first-paint chunk. Keeping the import dynamic is what puts that code in
 * its own chunk, fetched the first time something actually reaches for the
 * browser.
 *
 * The expensive half of the browser has always behaved that way: the main process
 * creates a tab's native view, its partition session and its download listeners
 * only when a tab is actually shown. The renderer half did not, because the stores
 * did their setup in their constructors and were evaluated while the renderer
 * document evaluated. They are inert until `start` is called on them now, and this
 * module is the one place that calls, so a launch that never touches the browser
 * pays nothing: no listener, no timer, no stored-tab read, no `MutationObserver`.
 */

import { publishBrowserSearchEngine } from '$lib/browser-search-context'
import { publishBrowserScrollbarTheme } from '$lib/browser-page-scrollbar'
import { appConfigState } from './app-config.svelte'
import { browserBookmarks } from './browser-bookmarks.svelte'
import { browserDownloads } from './browser-downloads.svelte'
import { browserHistory } from './browser-history.svelte'
import { browserInspector } from './browser-inspector.svelte'
import { browserPopupWindows } from './browser-popup-windows.svelte'
import { contextSidebarState } from './context-sidebar.svelte'
import { globalBrowser } from './global-browser.svelte'

/** The live browser store, re-exported so the access seam needs one import. */
export { globalBrowser }

let started = false

/**
 * Wire every browser store's runtime. Idempotent, so callers never have to
 * coordinate or check: the second and later calls are free.
 */
export function startBrowserRuntime(): void {
  if (started) return
  started = true
  globalBrowser.start()
  browserPopupWindows.start()
  browserDownloads.start()
  browserInspector.start()
  // The history and the bookmark list are the browser's memory: one records every
  // page a tab commits, the other is what the user saved. Both are read here, once
  // the browser is actually wanted, so a launch that never reaches it pays nothing
  // for them.
  browserHistory.start()
  browserBookmarks.start()
  contextSidebarState.startBrowserTabs()
  // Two pushes to main describe the browser's chrome rather than its state, and
  // both are skipped while no browser exists (see `publishBrowserScrollbarTheme`
  // and `appConfigState.sync`). This is where the values they held back are sent,
  // before the first page exists to use them.
  publishBrowserScrollbarTheme()
  publishBrowserSearchEngine(appConfigState.browserSearchEngine)
}
