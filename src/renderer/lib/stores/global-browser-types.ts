/**
 * Types and pure rules for the global (personal) browser workspace.
 *
 * The global browser is a first-class top-level view, so its tab list is not
 * owned by a project or a thread the way the context sidebar's browser is. This
 * module holds the shape of that model and the closed catalogs a group is
 * allowed to draw from, so the store, the sidebar and the header all agree on
 * one vocabulary instead of inventing labels per surface.
 */

import type { BrowserLoadError } from '$shared/ipc-contract'

/** Live runtime state of one global tab, keyed by tab id. */
export interface GlobalBrowserRuntime {
  audible: boolean
  muted: boolean
  capturing: boolean
  loading: boolean
  /** The failure that left this tab with no page, or null while it has one. */
  loadError: BrowserLoadError | null
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
  loadError: null,
  canGoBack: false,
  canGoForward: false
})

/**
 * The appearance vocabulary a browser tab and a browser group share, copied
 * from the project/routine model: a hex colour, a `PROJECT_SVG_ICONS` key, a
 * sanitized custom SVG, and a picked image file. One shape means one editor and
 * one icon resolver for every browser surface that carries an identity.
 */
export interface BrowserAppearance {
  /** A `PROJECT_COLORS` hex, or a custom hex, or null for no colour. */
  color: string | null
  /** A `PROJECT_SVG_ICONS` key, or null. */
  iconType: string | null
  /** A sanitized pasted SVG, or null. */
  customSvg: string | null
  /** Absolute path of a picked image file, read to a data URL for display. */
  imagePath: string | null
}

export interface GlobalBrowserGroup extends BrowserAppearance {
  id: string
  name: string
  /** A free-form note about what the fold is for, or an empty string. */
  description: string
  /** A pinned fold stays at the top of the strip, like a pinned thread. */
  pinned: boolean
}

/**
 * The appearance fields a group carries, named once so the store's create and
 * update signatures cannot drift from the modal that fills them in.
 */
export type BrowserGroupAppearance = BrowserAppearance

/**
 * One global browser tab.
 *
 * `hibernated` is the app's promise about the page, not a guess: a tab marked
 * hibernated has no live `WebContents` in the main process and reloads from
 * `url` the next time it is shown. Restored tabs start hibernated so a restart
 * never silently reloads dozens of pages.
 */
export interface GlobalBrowserTab extends BrowserAppearance {
  id: string
  title: string
  /**
   * A label the user typed, shown instead of the page's own title. Null means
   * the live title is used, so a rename survives the page reporting its title
   * on the next load while an unnamed tab keeps tracking the page.
   */
  customTitle: string | null
  url: string
  favicon: string | null
  groupId: string | null
  createdAt: number
  /** Last moment the tab was shown to the user; the hibernation clock reads it. */
  lastUsedAt: number
  hibernated: boolean
  /** A pinned tab stays at the top of the strip and is never hibernated. */
  pinned: boolean
  /** When the tab was pinned, so the pinned block keeps a stable order. */
  pinnedAt: number | null
}

/** Group names, tab titles and descriptions are bounded the way thread titles are. */
export const MAX_BROWSER_GROUP_NAME_LENGTH = 60
export const MAX_BROWSER_GROUP_DESCRIPTION_LENGTH = 240
export const MAX_BROWSER_TAB_TITLE_LENGTH = 120
export const MAX_GLOBAL_BROWSER_TABS = 100
export const MAX_GLOBAL_BROWSER_GROUPS = 40
/** Bounds for the appearance payload a group may persist. The SVG ceiling
 *  matches `sanitizeCustomSvg`, so a stored value can only be one it accepted. */
export const MAX_BROWSER_GROUP_ICON_TYPE_LENGTH = 64
export const MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH = 16_384
export const MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH = 2_048

/** Whether two load errors describe the same failure. Main sends a fresh object
 *  with every state report, so identity would report a change on every publish. */
export function isSameBrowserLoadError(
  a: BrowserLoadError | null,
  b: BrowserLoadError | null
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.kind === b.kind && a.code === b.code && a.description === b.description
}

/**
 * Whether a tab has no committed address yet, which is what a fresh tab is.
 *
 * Nothing loads for a blank tab, and its address spotlight   the field where the
 * user types a search or an address   is the only way in, so every surface that
 * asks "is there a page here?" asks it through this one predicate.
 */
export function isBlankBrowserAddress(url: string): boolean {
  return url === ''
}

/**
 * The tab title a fresh tab shows before the page reports its own.
 *
 * Derived from the address so a restored strip reads usefully without a live
 * page, and an address-less tab reads as a new tab.
 */
export function browserTabTitleForUrl(url: string): string {
  if (isBlankBrowserAddress(url)) return 'New Tab'
  try {
    const parsed = new URL(url)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return 'Browser'
  }
}

/** Whether an idle tab is past the configured hibernation window. A pinned tab
 *  never hibernates: it survives the sweep the way a pinned thread survives
 *  cleanup. */
export function isTabIdlePastWindow(tab: GlobalBrowserTab, now: number, windowMs: number): boolean {
  if (tab.hibernated) return false
  if (tab.pinned) return false
  return now - tab.lastUsedAt >= windowMs
}

/**
 * The label the strip, the notes rail and the close affordances show: the
 * user's own title when there is one, otherwise the page's live title. A blank
 * custom title is treated as "no custom title" so clearing the field restores
 * the page title instead of leaving an unnamed tab.
 */
export function browserTabLabel(tab: Pick<GlobalBrowserTab, 'title' | 'customTitle'>): string {
  const custom = tab.customTitle?.trim() ?? ''
  if (custom !== '') return custom
  const title = tab.title.trim()
  return title !== '' ? title : 'New Tab'
}
