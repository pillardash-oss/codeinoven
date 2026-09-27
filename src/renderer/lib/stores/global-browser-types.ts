/**
 * Types and pure rules for the global (personal) browser workspace.
 *
 * The global browser is a first-class top-level view, so its tab list is not
 * owned by a project or a thread the way the context sidebar's browser is. This
 * module holds the shape of that model and the closed catalogs a group is
 * allowed to draw from, so the store, the sidebar and the header all agree on
 * one vocabulary instead of inventing labels per surface.
 */

/** Live runtime state of one global tab, keyed by tab id. */
export interface GlobalBrowserRuntime {
  audible: boolean
  muted: boolean
  capturing: boolean
  loading: boolean
  /** Whether the page's own history can step back / forward. */
  canGoBack: boolean
  canGoForward: boolean
}

/** The state of a tab nothing has been reported for yet. */
export const IDLE_GLOBAL_BROWSER_RUNTIME: GlobalBrowserRuntime = Object.freeze({
  audible: false,
  muted: false,
  capturing: false,
  loading: false,
  canGoBack: false,
  canGoForward: false
})

/**
 * One group of tabs in the browser sidebar: a named, coloured, iconed fold.
 *
 * Its appearance is deliberately the *same* model projects and assistant
 * routines use   a hex colour, a `PROJECT_SVG_ICONS` key, a sanitized custom
 * SVG, and a picked image file   so all three are edited with the one
 * `AppearancePicker` and drawn by the one `getProjectIcon` resolver. Nothing
 * here invents a parallel colour or icon vocabulary.
 */
export interface GlobalBrowserGroup {
  id: string
  name: string
  /** A `PROJECT_COLORS` hex, or a custom hex, or null for no colour. */
  color: string | null
  /** A `PROJECT_SVG_ICONS` key, or null. */
  iconType: string | null
  /** A sanitized pasted SVG, or null. */
  customSvg: string | null
  /** Absolute path of a picked image file, read to a data URL for display. */
  imagePath: string | null
}

/**
 * The appearance fields a group carries, named once so the store's create and
 * update signatures cannot drift from the modal that fills them in.
 */
export type BrowserGroupAppearance = Pick<
  GlobalBrowserGroup,
  'color' | 'iconType' | 'customSvg' | 'imagePath'
>

/**
 * One global browser tab.
 *
 * `hibernated` is the app's promise about the page, not a guess: a tab marked
 * hibernated has no live `WebContents` in the main process and reloads from
 * `url` the next time it is shown. Restored tabs start hibernated so a restart
 * never silently reloads dozens of pages.
 */
export interface GlobalBrowserTab {
  id: string
  title: string
  url: string
  favicon: string | null
  groupId: string | null
  createdAt: number
  /** Last moment the tab was shown to the user; the hibernation clock reads it. */
  lastUsedAt: number
  hibernated: boolean
}

/** Group names and tab titles are bounded the same way thread titles are. */
export const MAX_BROWSER_GROUP_NAME_LENGTH = 60
export const MAX_GLOBAL_BROWSER_TABS = 100
export const MAX_GLOBAL_BROWSER_GROUPS = 40
/** Bounds for the appearance payload a group may persist. The SVG ceiling
 *  matches `sanitizeCustomSvg`, so a stored value can only be one it accepted. */
export const MAX_BROWSER_GROUP_ICON_TYPE_LENGTH = 64
export const MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH = 16_384
export const MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH = 2_048

/**
 * The tab title a fresh tab shows before the page reports its own.
 *
 * Derived from the address so a restored strip reads usefully without a live
 * page, and an address-less tab reads as a new tab.
 */
export function browserTabTitleForUrl(url: string): string {
  if (url === '') return 'New Tab'
  try {
    const parsed = new URL(url)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return 'Browser'
  }
}

/** Whether an idle tab is past the configured hibernation window. */
export function isTabIdlePastWindow(tab: GlobalBrowserTab, now: number, windowMs: number): boolean {
  if (tab.hibernated) return false
  return now - tab.lastUsedAt >= windowMs
}
