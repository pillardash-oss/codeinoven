import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { withBrowser } from '$lib/stores/browser-access.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
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
 */
export function openInGlobalCioBrowser(url: string): void {
  workspaceState.navigateToBrowser?.()
  void withBrowser((store) => store.open(url))
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
  if (wantsCioBrowser && openInCioBrowser(url)) return
  await invoke('shell:openExternal', url)
}
