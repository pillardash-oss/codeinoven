import type {
  BrowserNewTabMenuInput,
  BrowserNewTabMenuChoice
} from '$shared/browser/browser-new-tab-menu'
import { invoke } from '$lib/ipc.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import type { BrowserBoxMenuChoice, BrowserBoxMenuInput } from '$shared/browser/browser-box-menu'

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

/** Open the thread browser's box menu under the button that opened it.
 *
 * The profile's boxes are the renderer's list, so they travel with the call.
 * Resolves with the chosen box   `null` for the scope's own jar   or null when
 * the menu was dismissed, which is the caller's cue to leave the tab alone. */
export function openBrowserBoxMenu(
  input: BrowserBoxMenuInput,
  anchor: HTMLElement
): Promise<BrowserBoxMenuChoice | null> {
  const { x, y } = anchorBelow(anchor)
  return invoke('browser:boxMenu', input, x, y).catch(() => null)
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

/** The normalized origin of a page's URL (`https://host`), or an empty string
 *  while the address is blank or not an http(s) URL. The site menu's manual
 *  permission section acts on this: camera, microphone, location and
 *  notifications can be allowed or blocked for the site without waiting for
 *  the page to request them. */
export function browserSiteOrigin(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.origin
  } catch {
    return ''
  }
}

/**
 * Open the site-settings menu (manual per-site permissions, then the clearing
 * actions) under a chrome button. Resolves `true` once the popup is handed
 * to the OS, `false` when the call failed, so the caller can drop its
 * `aria-expanded` state.
 */
export function openBrowserSiteMenu(
  projectId: string,
  host: string,
  origin: string,
  anchor: HTMLElement,
  boxId: string | null = null,
  boxName = ''
): Promise<boolean> {
  const { x, y } = anchorBelow(anchor)
  return openBrowserSiteMenuAt(projectId, host, origin, x, y, boxId, boxName)
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
  origin: string,
  x: number,
  y: number,
  boxId: string | null = null,
  boxName = ''
): Promise<boolean> {
  return invoke(
    'browser:siteMenu',
    projectId,
    host,
    origin,
    boxId,
    boxName,
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y))
  ).then(
    () => true,
    () => false
  )
}

/** The ambient new-tab menu is an OS popup, so it stays above native pages. */
export function openBrowserNewTabMenu(
  input: BrowserNewTabMenuInput,
  x: number,
  y: number
): Promise<BrowserNewTabMenuChoice | null> {
  return invoke(
    'browser:newTabMenu',
    input,
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y))
  ).catch((error: unknown) => {
    logRendererError('The new tab menu could not open', error)
    return null
  })
}
