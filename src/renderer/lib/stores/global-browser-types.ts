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
import type { BrowserAppearance } from '$shared/browser/global-browser-tabs'

// The stored shape's bounds and its shared appearance vocabulary live beside the
// stored record itself (`$shared/browser/global-browser-tabs`), because the main
// process validates the same payload. They are re-exported here so every browser
// surface keeps importing one module for the model's limits.
export {
  MAX_BROWSER_BOX_NAME_LENGTH,
  MAX_BROWSER_GROUP_CUSTOM_SVG_LENGTH,
  MAX_BROWSER_GROUP_DESCRIPTION_LENGTH,
  MAX_BROWSER_GROUP_ICON_TYPE_LENGTH,
  MAX_BROWSER_GROUP_IMAGE_PATH_LENGTH,
  MAX_BROWSER_GROUP_NAME_LENGTH,
  MAX_BROWSER_TAB_TITLE_LENGTH,
  MAX_GLOBAL_BROWSER_BOXES,
  MAX_GLOBAL_BROWSER_GROUPS,
  MAX_GLOBAL_BROWSER_TABS
} from '$shared/browser/global-browser-tabs'
export { isBrowserBoxId } from '$shared/browser/global-browser-tabs'
export type { BrowserAppearance } from '$shared/browser/global-browser-tabs'

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

export interface GlobalBrowserGroup extends BrowserAppearance {
  id: string
  name: string
  /** A free-form note about what the fold is for, or an empty string. */
  description: string
  /** A pinned fold stays at the top of the strip, like a pinned thread. */
  pinned: boolean
}

/**
 * One browser box: a named container for cookies and site data.
 *
 * A box is a storage identity, not a window and not a process. Tabs that name
 * the same box share one Chromium session and therefore one set of logins;
 * tabs in different boxes are as separate as two different browsers, which is
 * the whole point. It wears the same appearance vocabulary as a group so the
 * strip's resolvers, the appearance editor and the icon cache are reused rather
 * than reinvented.
 */
export interface GlobalBrowserBox extends BrowserAppearance {
  id: string
  name: string
}

/**
 * The box every context has without making one: the jar the browser's own pages
 * live in.
 *
 * Naming it is what lets the boxes panel, the extensions panel and the install
 * target treat "a box" and "no box" as one question with one answer. The id is a
 * literal rather than a minted uuid because a stored extension record has to keep
 * pointing at the same jar across releases.
 */
export const DEFAULT_BOX_ID = 'box:default'

/** What the default box is called before the user renames it. */
export const DEFAULT_BOX_NAME = 'Default'

/** The default box with nothing chosen yet, for a snapshot that predates it. */
export function defaultBrowserBox(): GlobalBrowserBox {
  return {
    id: DEFAULT_BOX_ID,
    name: DEFAULT_BOX_NAME,
    color: null,
    iconType: null,
    customSvg: null,
    imagePath: null
  }
}

/**
 * The jar main knows for a box the interface names.
 *
 * Main has no notion of a default box: the context's own jar is the absent box id,
 * which is what a tab with no box already uses. Every conversion between the two
 * vocabularies goes through here, because a default box id handed to main as-is
 * would be taken for a box that exists and would mint a partition for it.
 */
export function jarIdForBox(boxId: string): string | null {
  return boxId === DEFAULT_BOX_ID ? null : boxId
}

/** The same jar as an extension record spells it, where the context's own jar is
 *  the empty string rather than an absent id. */
export function extensionJarForBox(boxId: string): string {
  return jarIdForBox(boxId) ?? ''
}

/** The box a jar names, for showing a stored jar list as boxes. */
export function boxIdForJar(jarId: string | null): string {
  return jarId === null || jarId === '' ? DEFAULT_BOX_ID : jarId
}

/**
 * The appearance fields a box carries, named once so the store's create and
 * update signatures cannot drift from the modal that fills them in.
 */
export type BrowserBoxAppearance = BrowserAppearance

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
  /** The address the tab is showing, normalized, or empty for a blank tab. */
  url: string
  /**
   * The page's own icon as a data URL, or null while the app has none for this
   * tab.
   *
   * The icon belongs to the tab's address rather than to the running page, so it
   * is written down with the tab: the row wears it while the tab is hibernated
   * and after a restart, before any page loads. A page that reports a different
   * icon replaces it, a tab that navigates drops it with the address it came from,
   * and a tab that has none resolves one from its own address (see
   * `GlobalBrowserState.ensureFavicon`).
   */
  favicon: string | null
  groupId: string | null
  /**
   * The box this tab runs against, or null for the browser's own default jar.
   *
   * A tab cannot change jars in place, because cookies do not migrate between
   * partitions, so this is fixed when the tab is created and carried to the main
   * process on every `browser:show` and `browser:navigate`. "Reopen in box" is
   * the only honest way to move a page, and it is a close plus an open.
   */
  boxId: string | null
  createdAt: number
  /** Last moment the tab was shown to the user; the hibernation clock reads it. */
  lastUsedAt: number
  hibernated: boolean
  /** A pinned tab stays at the top of the strip and is never hibernated. */
  pinned: boolean
  /** When the tab was pinned, so the pinned block keeps a stable order. */
  pinnedAt: number | null
  /**
   * The assistant conversation bound to this tab (a real thread in the reserved
   * hidden browser project), or null while the tab has never asked the agent
   * anything. The link is focused on the tab because the conversation's lifetime
   * is the tab's: it is kept until the tab or the conversation is closed, and a
   * restart restores both.
   */
  assistantThreadId: string | null
}

/**
 * How many closed tabs this session keeps for a reopen.
 *
 * The reopen stack is a convenience, not a record: quitting empties it, and a
 * browser only needs to remember far enough back for a person to undo a
 * handful of mistaken closes. The bound mirrors the main process's own closed
 * history set, so the two never disagree about which tab is still reopenable.
 */
export const MAX_REOPENED_BROWSER_TABS = 20

/** One tab closed this session, kept so it can be reopened.
 *
 * The tab is stored whole (with its strip position) because reopening restores
 * it, not merely its address: the label, colour, icon, group and box all come
 * back the way the user arranged them. It is deliberately never written to the
 * durable tab list   a restart forgets the reopen stack, exactly as a browser
 * does.
 */
export interface ClosedGlobalBrowserTab {
  /** The tab as it was, so a reopen restores it rather than a bare address. */
  tab: GlobalBrowserTab
  /** The position it held in the strip, clamped when the strip has shrunk. */
  index: number
}

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
