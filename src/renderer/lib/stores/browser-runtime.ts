/**
 * The one seam that wires the in-app browser's renderer runtime.
 *
 * The browser is not part of the app's first paint. The app opens on projects and
 * chat, so a launch that never touches the browser should pay nothing for it. The
 * expensive half of the browser has always behaved that way: the main process
 * creates a tab's native view, its partition session and its download listeners
 * only when a tab is actually shown. The renderer half did not, because four
 * stores did their setup in their constructors and were evaluated while the
 * renderer document evaluated. That put five IPC listeners, a 60s idle sweep, a
 * `MutationObserver` on `documentElement` and a `browser:loadTabs` round trip
 * (with the file read behind it) on the first-paint path, plus a synchronous
 * `localStorage` parse in the sidebar's browser controller.
 *
 * Those stores are now inert until `start` is called on them. This module is the
 * one place that calls, so every path that can put a browser on screen asks here
 * first and the wiring happens exactly once, ahead of the first surface that needs
 * it. `App.svelte` calls it from a post-paint deferral (so the strip is warm for
 * anything that reaches the browser later) and from the moment the browser view or
 * its rail entry is reached for (so the first open is not the one that waits).
 */

import { browserDownloads } from './browser-downloads.svelte'
import { browserInspector } from './browser-inspector.svelte'
import { browserPopupWindows } from './browser-popup-windows.svelte'
import { contextSidebarState } from './context-sidebar.svelte'
import { globalBrowser } from './global-browser.svelte'

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
  contextSidebarState.startBrowserTabs()
}
