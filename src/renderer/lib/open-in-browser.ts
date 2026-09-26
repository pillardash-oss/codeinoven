import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { isLocalDevelopmentUrl } from '$shared/local-development-url'

/**
 * Whether the in-app browser can take a page right now.
 *
 * Every tab belongs to a project thread, so a link can only be opened inside
 * the workspace with a thread on screen. A project-less global browser is what
 * would make this answer yes from any surface; until it exists, callers hide
 * the action instead of offering one that would go nowhere.
 */
export function canOpenInCioBrowser(): boolean {
  return contextSidebarState.canOpenBrowserTab
}

/**
 * Open `url` in the in-app browser tab of the project the workspace is working
 * in, and report whether it found a home for the page.
 *
 * This is the explicit, user-asked-for version of the routing below: it never
 * falls back to the operating-system browser, because a caller offering both
 * (the link context menu) keeps its own item for that, and silently switching
 * browser would make the label a lie. It is also the single place a future
 * global browser plugs in, so no caller has to learn about it.
 */
export function openInCioBrowser(url: string): boolean {
  return contextSidebarState.openBrowser(url) !== null
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
