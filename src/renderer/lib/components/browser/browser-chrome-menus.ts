import { invoke } from '$lib/ipc.svelte'

/**
 * The browser chrome's native popup menus, opened from one place.
 *
 * Every browser surface (the project sidebar, the full screen panel and the
 * global browser) paints its own chrome, but the three menus behind that chrome
 * are the same three calls: the downloads list for a profile, the page menu
 * (reload kinds, save, print, view source), and the site-settings menu (clear
 * cookies, site data, cache and remembered permissions). Keeping the invokes
 * here means a new surface gets the whole behaviour by calling one function,
 * and a signature change in the main process touches one file.
 *
 * All three popups are OS-native and composite above the page's native view, so
 * the caller anchors them to a chrome element (or a click point) and never has
 * to detach the page.
 */

/** The point a popup should drop from for a chrome button: just under it. */
function anchorBelow(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  return { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.bottom + 4)) }
}

/** Open the native downloads menu for one browser profile, anchored under the
 *  button that opened it. `projectId` is a project id or the global browser's
 *  reserved id. */
export function openBrowserDownloadsMenu(projectId: string, anchor: HTMLElement): void {
  const { x, y } = anchorBelow(anchor)
  void invoke('browser:downloadsMenu', projectId, x, y).catch(() => {})
}

/** Open the page-level menu (soft and hard reload, save, print, view source,
 *  inspect) at a point. Used by the reload button and by a page area that is
 *  not the native view. */
export function openBrowserPageMenuAt(tabId: string, x: number, y: number): void {
  void invoke(
    'browser:pageMenu',
    tabId,
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y))
  ).catch(() => {})
}

/** Open the page-level menu anchored under a chrome button (the reload button),
 *  which is where the reload-kind submenu lives. */
export function openBrowserPageMenu(tabId: string, anchor: HTMLElement): void {
  const { x, y } = anchorBelow(anchor)
  openBrowserPageMenuAt(tabId, x, y)
}

/** The host of a page's URL, or an empty string while the address is blank or
 *  not yet a URL. The site menu shows it as the menu's header. */
export function browserSiteHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Open the site-settings menu (a host header, then the clearing actions) under
 * a chrome button. Resolves `true` once the popup is handed to the OS, `false`
 * when the call failed, so the caller can drop its `aria-expanded` state.
 */
export function openBrowserSiteMenu(
  projectId: string,
  host: string,
  anchor: HTMLElement,
  boxId: string | null = null,
  boxName = ''
): Promise<boolean> {
  const { x, y } = anchorBelow(anchor)
  return openBrowserSiteMenuAt(projectId, host, x, y, boxId, boxName)
}

/**
 * The same menu at a point, for a surface that is not the app window.
 *
 * The native overlay that draws the floating browser strip lives in a window of
 * its own, so its chrome buttons have no element here to measure. The caller
 * translates the overlay document's point into this window's content space and
 * hands it over directly, along with the box whose jar the clearing actions
 * belong to.
 */
export function openBrowserSiteMenuAt(
  projectId: string,
  host: string,
  x: number,
  y: number,
  boxId: string | null = null,
  boxName = ''
): Promise<boolean> {
  return invoke(
    'browser:siteMenu',
    projectId,
    host,
    boxId,
    boxName,
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y))
  ).then(
    () => true,
    () => false
  )
}
