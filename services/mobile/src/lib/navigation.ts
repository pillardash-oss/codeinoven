/**
 * Where the app's panels are, and what a screen calls the panel it was opened
 * from.
 *
 * The dock owns three destinations: the work list (threads or projects), the
 * chats panel, and the assistant. Those are the panels, and a panel is the only
 * kind of screen that wears the dock at its foot. Anything opened from one of
 * them is a screen with a parent, so it carries the chevron and the crumb that
 * lead back instead of the navigation it would otherwise duplicate.
 */

export interface Crumb {
  label: string
  href: string
}

/** The dock's own panels, by the name each one wears in a breadcrumb. */
const PANELS: Readonly<Record<string, string>> = {
  '/': 'Threads',
  '/threads': 'Threads',
  '/projects': 'Projects',
  '/chats': 'Chats',
  '/assistant': 'Assistant'
}

export function isPanel(pathname: string): boolean {
  return Object.hasOwn(PANELS, pathname)
}

/** The dock belongs to the panels, and to nothing reached from them. */
export function showsDock(pathname: string): boolean {
  return isPanel(pathname)
}

/**
 * What this path is called when it is the place a screen came from. A
 * conversation has no panel name of its own, because its own title is the name.
 */
export function panelCrumb(pathname: string): Crumb | null {
  const panel = PANELS[pathname]
  if (panel) return { label: panel, href: pathname }
  if (/^\/threads\/[^/]+$/.test(pathname)) return { label: 'Thread', href: pathname }
  return null
}

/**
 * The panel a screen was opened from. The shell passes it as `?from=`, because a
 * static SPA has no server to write a referrer into the page and the crumb has to
 * survive a reload.
 */
export function crumbFrom(value: string | null): Crumb | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null
  const query = value.indexOf('?')
  return panelCrumb(query === -1 ? value : value.slice(0, query))
}

/** The trail a screen wears: its ancestors, nearest last. */
export function trailTo(parent: Crumb | null): Crumb[] {
  return parent ? [parent] : []
}

/** The address of the settings screen, remembering the panel it was opened from. */
export function settingsHref(from: string): string {
  return `/settings?from=${encodeURIComponent(from)}`
}
