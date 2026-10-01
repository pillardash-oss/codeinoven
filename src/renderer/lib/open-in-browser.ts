import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { withBrowser } from '$lib/stores/browser-access.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { isLocalDevelopmentUrl } from '$shared/local-development-url'

/**
 * Whether the thread browser can take a page right now.
 *
 * A thread-browser tab belongs to a project thread, so a link can only be
 * opened that way with a thread on screen. The app-wide global browser is the
 * destination that works from any surface; it is {@link openInGlobalCioBrowser},
 * and callers that offer both (the link context menu) hide this one when it
 * cannot work instead of offering a dead item.
 */
export function canOpenInCioBrowser(): boolean {
  return contextSidebarState.canOpenBrowserTab
}

/**
 * Open `url` in the thread browser: the in-app browser tab of the project the
 * workspace is working in, and report whether it found a home for the page.
 *
 * This is the explicit, user-asked-for version of the routing below: it never
 * falls back to the operating-system browser, because a caller offering both
 * (the link context menu) keeps its own item for that, and silently switching
 * browser would make the label a lie.
 */
export function openInCioBrowser(url: string): boolean {
  return contextSidebarState.openBrowser(url) !== null
}

/**
 * Open `url` in the app-wide global browser and bring that view on screen.
 *
 * Unlike {@link openInCioBrowser}, this needs no project thread: the global
 * browser is project-less, so it can take the page from any surface. The view
 * is revealed first because reaching it is what builds the browser's lazy
 * store; the tab is then opened on the same store, which `withBrowser` loads
 * (and reuses, since it is the same in-flight load).
 *
 * For a click with nothing riding on the answer. A caller that must not claim the
 * page is there until it really is uses
 * {@link openInGlobalCioBrowserWhenReady}.
 */
export function openInGlobalCioBrowser(url: string): void {
  workspaceState.navigateToBrowser?.()
  void withBrowser((store) => store.open(url))
}

/**
 * How long {@link openInGlobalCioBrowserWhenReady} waits for the browser to take
 * the page before it reports that it did not.
 *
 * Reaching the browser for the first time in a session loads its modules and then
 * its durable tab list, and the answer is what decides whether that page is
 * there. A read that never lands (a feature graph still assembling, a renderer
 * that reloaded mid-call) must not leave the caller waiting on a click that
 * visibly did nothing, and past this point the page in the operating system's
 * browser is the better answer.
 */
const GLOBAL_BROWSER_OPEN_TIMEOUT_MS = 8000

/**
 * Open `url` in the app-wide global browser and report whether the browser
 * actually took it, waiting until that is known.
 *
 * {@link openInGlobalCioBrowser} is the fire-and-forget form, for a click with
 * nothing riding on the answer. A caller that must not claim success until the
 * page exists needs this one: it resolves true only once the browser holds a tab
 * showing `url`, and false when the browser refused it or did not answer within
 * {@link GLOBAL_BROWSER_OPEN_TIMEOUT_MS}. The wait is not a cancellation: a
 * late answer still opens its tab, which leaves the caller with the page it could
 * not wait for.
 */
export function openInGlobalCioBrowserWhenReady(url: string): Promise<boolean> {
  workspaceState.navigateToBrowser?.()
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (opened: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(opened)
    }
    const timer = setTimeout(() => settle(false), GLOBAL_BROWSER_OPEN_TIMEOUT_MS)
    withBrowser((store) => store.open(url)).then(
      (tabId) => settle(Boolean(tabId)),
      () => settle(false)
    )
  })
}

/**
 * Open `url` in the tab the global browser already has on screen, revealing the
 * app-wide browser first when it is not the view in front.
 *
 * This is the destination a link has when the reader is already browsing: the
 * page in front of them moves, exactly as typing a new address into the address
 * field would, instead of a second tab appearing beside it. When no tab exists
 * yet the browser opens its first one.
 */
export function openInGlobalBrowserTabOnScreen(url: string): void {
  workspaceState.navigateToBrowser?.()
  void withBrowser((store) => store.openInActiveTab(url))
}

/**
 * Route a link the user activated normally (a click, an agent's suggested URL,
 * an "open the docs" control) to whichever browser belongs to it.
 *
 * Local development links stay inside the workspace when that preference is on
 * and a project thread can own the tab, and they never fall through to the
 * general preference: they always belong to the surface they were clicked in.
 * When the general preference is on, every other link takes the same route.
 * Otherwise, and whenever no project thread can own the tab, the operating
 * system browser is the fallback instead of a silent no-op.
 */
export async function openInBrowser(url: string): Promise<void> {
  const wantsCioBrowser =
    (appConfigState.openLocalhostInCioBrowser && isLocalDevelopmentUrl(url)) ||
    appConfigState.openAllLinksInCioBrowser
  if (wantsCioBrowser) {
    // A link opened while the app-wide browser is the view on screen belongs to
    // that browser: the thread browser would put the page in a project thread's
    // tab behind a workspace the reader is not looking at, so it takes a tab
    // beside the page they are reading instead.
    if (rendererRecovery.activeView === 'browser') {
      openInGlobalCioBrowser(url)
      return
    }
    if (openInCioBrowser(url)) return
  }
  await invoke('shell:openExternal', url)
}
