import { viewShowsWorkspaceShell } from '$lib/content-view-projects'
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
 * Whether a link the user activated normally belongs in an app browser.
 *
 * Named rather than inlined so the callers that must agree do not each grow their
 * own copy of the rule. Local development links stay inside the workspace when
 * that preference is on and a project thread can own the tab, and they never fall
 * through to the general preference: they always belong to the surface they were
 * clicked in. Every other link follows the general preference.
 *
 * This is a routing decision only. Whether a thread can actually take the tab is
 * {@link openInCioBrowser}'s answer, and where the page ends up when it cannot is
 * {@link openSignInPage}'s.
 */
export function prefersCioBrowser(url: string): boolean {
  return (
    (appConfigState.openLocalhostInCioBrowser && isLocalDevelopmentUrl(url)) ||
    appConfigState.openAllLinksInCioBrowser
  )
}

/**
 * Which browser a link belongs to.
 *
 * - `auto` (the default): the surface on screen decides. The thread browser is
 *   only a home while the workspace shell is showing a thread, which is
 *   {@link resolveLinkDestination}.
 * - `context`: the thread browser of the project the workspace is working in,
 *   for a surface that already knows it is the workspace.
 * - `global`: the app-wide browser, for a caller that knows the link is the
 *   app's own (a sign-in page, a settings control) whatever is on screen.
 */
export type LinkDestination = 'auto' | 'context' | 'global'

/**
 * Where a link belongs when its caller does not say.
 *
 * The thread browser is the workspace's own: it puts the page in the tab of a
 * project thread. That is the right home only while the workspace shell is what
 * the user is looking at, and the takeover pages break that assumption   Scope,
 * Settings and the app-wide browser each replace the shell, yet the workspace
 * still holds an active project and thread behind them. Without this, a link
 * clicked in Settings lands in a thread's browser the reader never asked for and
 * cannot connect to the page in front of them.
 *
 * So the surface decides: the workspace shell keeps links in context, every
 * other surface sends them to the app-wide browser, which needs no thread.
 */
function resolveLinkDestination(destination: LinkDestination): 'context' | 'global' {
  if (destination !== 'auto') return destination
  return viewShowsWorkspaceShell(rendererRecovery.activeView) ? 'context' : 'global'
}

/**
 * Route a link the user activated normally (a click, an agent's suggested URL,
 * an "open the docs" control) to whichever browser belongs to it.
 *
 * The destination is the surface's, not the caller's to remember: leaving it at
 * `auto` routes by what is on screen, so an app-chrome control cannot send a
 * page into a project thread's browser by omission. A caller that genuinely
 * knows better passes `context` or `global`.
 *
 * When the preference says an app browser and a project thread can own the tab,
 * the page stays in the workspace; otherwise the operating system browser is the
 * fallback rather than a silent no-op.
 */
export async function openInBrowser(
  url: string,
  destination: LinkDestination = 'auto'
): Promise<void> {
  if (prefersCioBrowser(url)) {
    if (resolveLinkDestination(destination) === 'global') {
      if (await openInGlobalCioBrowserWhenReady(url)) return
      await invoke('shell:openExternal', url)
      return
    }
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

/**
 * Where a sign-in page actually landed, so the caller knows who is holding the
 * rest of the flow. `system-browser` covers both the user turning the preference
 * off and the app browser failing to take the page: from here they are the same
 * situation, the page is in another application and this one has to say so.
 */
export type SignInPageDestination = 'app-browser' | 'system-browser'

/**
 * Open a sign-in page where the user's link routing says, and report where it went.
 *
 * A provider authorization page is not a link the user picked a destination for.
 * There is no context menu to choose from and no button labelled for one browser,
 * so it follows the same preference every other link follows: off sends it to the
 * user's default browser, on sends it to the app-wide global browser.
 *
 * The report is the point. A sign-in that silently lands nowhere is the worst
 * outcome of this flow, so a caller has to be able to dock for a page the app
 * browser really holds rather than assume it, and one handed off to the system has
 * to be able to say so instead of pretending the app still has it.
 */
export async function openSignInPage(url: string): Promise<SignInPageDestination> {
  if (prefersCioBrowser(url) && (await openInGlobalCioBrowserWhenReady(url))) {
    return 'app-browser'
  }
  await invoke('shell:openExternal', url)
  return 'system-browser'
}
