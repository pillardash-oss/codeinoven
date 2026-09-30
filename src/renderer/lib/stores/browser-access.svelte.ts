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
 * The switcher cannot wait for a load that may never come: a session that
 * restores onto a thread never opens the browser, yet its tabs are exactly the
 * surfaces the switcher is for. So this module also mirrors the durable tab
 * list, which is what {@link switcherBrowserTabs} resolves rows against until
 * the live store has read it (see {@link ensureStoredBrowserTabs}).
 *
 * A surface that can put a browser on screen calls {@link loadBrowser} before it
 * needs the state, so the store is already there when it renders. The single
 * launch allowed to pay eagerly is a session that restores straight onto the
 * browser view, and `App.svelte` is what decides that.
 */

import { preloadBrowserChunk } from '$lib/page-preload'
import type { GlobalBrowserState } from './global-browser.svelte'
import type { GlobalBrowserTab } from './global-browser-types'
import { loadStoredGlobalBrowserTabs, runtimeTabFromPersisted } from './global-browser-persistence'

/** The live store, or null while the browser has not been asked for. */
let store: GlobalBrowserState | null = $state(null)

/** The load in flight, so every caller shares one and the second call is free. */
let pending: Promise<GlobalBrowserState> | null = null

/** The durable tab list, for a switcher that has no live store to read yet. */
let storedTabs: readonly GlobalBrowserTab[] = $state([])

/** The one read of that list, in flight or done, so it is never repeated. */
let storedTabsRead: Promise<void> | null = null

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
 *
 * The store is published as soon as its modules are loaded, which is what makes
 * the eager surfaces that render off {@link browserStore} work; the returned
 * promise additionally waits for its durable tab list, because what a caller
 * does with the answer is almost always resolve one tab against that list (open
 * an address, switch to a tab) and doing that before the list arrives silently
 * acted on an empty strip.
 */
export function loadBrowser(): Promise<GlobalBrowserState> {
  // Warm the surfaces first: they are separate chunks and fetching them in
  // parallel with the stores means the first open is not the one that waits.
  preloadBrowserChunk()
  pending ??= import('./browser-runtime').then(async (runtime) => {
    runtime.startBrowserRuntime()
    store = runtime.globalBrowser
    await store.whenHydrated
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

/**
 * The tab list the Ctrl+Tab switcher resolves its browser rows against.
 *
 * The switching order is the recent-visit list, which the eager shell already
 * holds, but a key there only becomes a row if the tab it names still exists. This
 * is that lookup, not the list the switcher shows: a tab the visit order does not
 * name is never listed, however many tabs are open. The live store answers it once
 * it has read the durable list; before then, a launch that restored onto a thread
 * or a renderer that reloaded, the durable list is the same lookup done early.
 */
export function switcherBrowserTabs(): readonly GlobalBrowserTab[] {
  const live = store
  // Only once the store has read the list: before that its `tabs` is empty, and
  // a mirror of the stored tabs is the better answer rather than a stale one.
  if (live?.hydrated) return live.tabs
  return storedTabs
}

/**
 * Read the durable tab list for {@link switcherBrowserTabs}, once.
 *
 * Deliberately not {@link loadBrowser}: this is one small IPC read and leaves
 * the browser's runtime inert (no listeners, no idle sweep, no page), so a
 * session that only ever switches between threads still pays nothing for the
 * browser. A failed read leaves the mirror empty, which costs the switcher its
 * browser rows and nothing else.
 *
 * There is no retry, and none is needed: the channel is registered on main's
 * pre-navigation surface alongside the other hydration reads, and the store
 * behind it answers "nothing stored" rather than rejecting a file it cannot
 * parse, so a rejection here would mean the bridge itself is gone.
 */
export function ensureStoredBrowserTabs(): void {
  if (storedTabsRead) return
  storedTabsRead = loadStoredGlobalBrowserTabs()
    .then((snapshot) => {
      if (snapshot) storedTabs = snapshot.tabs.map(runtimeTabFromPersisted)
    })
    .catch(() => {
      // The switcher simply lists no browser tab.
    })
}
