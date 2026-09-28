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

/** One group of tabs in the browser sidebar: a named, coloured, iconed fold. */
export interface GlobalBrowserGroup {
  id: string
  name: string
  /** A `BROWSER_GROUP_COLORS` id; unknown ids fall back to the first entry. */
  color: string
  /** A catalog icon id, or null for a plain colour dot. Typed as the union, so
   *  an unknown persisted id can only reach it through the validator. */
  icon: BrowserGroupIconId | null
}

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

/** The colour catalog a group may use. Class strings, so no hex is hardcoded. */
export interface BrowserGroupColor {
  id: string
  label: string
  /** Small solid dot / accent fill. */
  dot: string
  /** Low-opacity fill for the group's own row and its tab tint. */
  tint: string
  /** Text/icon tone for the group's name. */
  text: string
}

export const BROWSER_GROUP_COLORS: readonly BrowserGroupColor[] = [
  { id: 'auric', label: 'Auric', dot: 'bg-accent', tint: 'bg-accent/10', text: 'text-accent' },
  { id: 'sky', label: 'Sky', dot: 'bg-info', tint: 'bg-info/10', text: 'text-info' },
  { id: 'glade', label: 'Glade', dot: 'bg-success', tint: 'bg-success/10', text: 'text-success' },
  { id: 'ember', label: 'Ember', dot: 'bg-warning', tint: 'bg-warning/10', text: 'text-warning' },
  { id: 'crimson', label: 'Crimson', dot: 'bg-danger', tint: 'bg-danger/10', text: 'text-danger' },
  {
    id: 'violet',
    label: 'Violet',
    dot: 'bg-thread-spec',
    tint: 'bg-thread-spec/10',
    text: 'text-thread-spec'
  }
]

/** The icon catalog a group may use, resolved to components by the sidebar. */
export const BROWSER_GROUP_ICON_IDS = [
  'folder',
  'briefcase',
  'cloud',
  'code',
  'chart',
  'star',
  'heart',
  'globe'
] as const

export type BrowserGroupIconId = (typeof BROWSER_GROUP_ICON_IDS)[number]

export function isBrowserGroupIconId(value: string): value is BrowserGroupIconId {
  return (BROWSER_GROUP_ICON_IDS as readonly string[]).includes(value)
}

/** The catalog entry for an id, falling back to the first colour for an
 *  unknown id so a stale persisted value can never render an unstyled group. */
export function browserGroupColor(id: string): BrowserGroupColor {
  return BROWSER_GROUP_COLORS.find((entry) => entry.id === id) ?? BROWSER_GROUP_COLORS[0]
}

/** Group names and tab titles are bounded the same way thread titles are. */
export const MAX_BROWSER_GROUP_NAME_LENGTH = 60
export const MAX_GLOBAL_BROWSER_TABS = 100
export const MAX_GLOBAL_BROWSER_GROUPS = 40

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
