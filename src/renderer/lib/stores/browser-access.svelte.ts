/**
 * The lazy handle to the in-app browser's renderer state.
 *
 * Everything about the browser is secondary. The app opens on projects and chat,
 * so a launch that never reaches the browser must pay neither for its code (it is
 * not in the first-paint chunk) nor for its runtime (nothing subscribes, nothing
 * reads the stored tab list, nothing allocates a tab). The eager shell therefore
 * never imports the browser store directly: it asks here.
 *
 * This module is the only bridge. It holds the live store once the browser's
 * modules have loaded, and `null` until then, and it is reactive, so a read that
 * happens before the load re-runs the moment the store arrives. That is what lets
 * the two eager surfaces that know about browser tabs - the app header's browser
 * centre and the Ctrl+Tab switcher - render their empty state first and their
 * real one after, without either of them pulling the browser into the entry
 * chunk.
 *
 * A surface that can put a browser on screen calls {@link loadBrowser} before it
 * needs the state, so the store is already there when it renders. The single
 * launch allowed to pay eagerly is a session that restores straight onto the
 * browser view, and `App.svelte` is what decides that.
 */

import { preloadBrowserChunk } from '$lib/page-preload'
import type { GlobalBrowserState } from './global-browser.svelte'

/** The live store, or null while the browser has not been asked for. */
let store: GlobalBrowserState | null = $state(null)

/** The load in flight, so every caller shares one and the second call is free. */
let pending: Promise<GlobalBrowserState> | null = null

/**
 * The live browser store, or null while the browser has not been asked for.
 *
 * Reactive: a `$derived` or an `$effect` that reads this re-runs when the browser
 * loads, which is why an eager surface can render its empty state first and its
 * real one once the store is there.
 */
export function browserStore(): GlobalBrowserState | null {
  return store
}

/**
 * Whether the browser's modules are loaded and wired, as a plain read.
 *
 * A side effect that must only run once there is a browser uses this rather than
 * {@link browserStore}: reading a `$state` inside an effect subscribes the effect
 * to it, and a push to main has nothing to re-run when the browser arrives. The
 * work that was skipped is done by the browser's own runtime when it comes up.
 */
export function isBrowserLoaded(): boolean {
  return store !== null
}

/**
 * Load the browser's renderer modules and wire them, then hand back the store.
 *
 * Idempotent, so every caller can ask without coordinating and the second and
 * later calls resolve against the same promise. `browser-access.svelte.ts` is
 * eager while this import is not, so the browser's code is fetched the first time
 * something actually reaches for it.
 */
export function loadBrowser(): Promise<GlobalBrowserState> {
  // Warm the surfaces first: they are separate chunks and fetching them in
  // parallel with the stores means the first open is not the one that waits.
  preloadBrowserChunk()
  pending ??= import('./browser-runtime').then((runtime) => {
    runtime.startBrowserRuntime()
    store = runtime.globalBrowser
    return store
  })
  return pending
}

/**
 * Run `action` against the browser store, loading it first if nothing has asked
 * for the browser yet.
 *
 * This is the escape hatch for the eager shell's own browser commands (a
 * keyboard chord, a palette action), which must work whether or not the browser
 * happens to be loaded. The action is applied a microtask later when the store
 * was not up, which is unobservable for a command that toggles a panel or opens
 * an address field.
 */
export function withBrowser<T>(action: (store: GlobalBrowserState) => T): Promise<T> {
  return loadBrowser().then(action)
}
