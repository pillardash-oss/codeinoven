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

/** The two readings of the one work list. */
const WORK_READINGS: ReadonlySet<string> = new Set(['/', '/threads', '/projects'])

/**
 * The dock's own order, left to right. A move between two panels that both sit in
 * the dock runs the way the dock reads, so the screen arrives from the edge the
 * square sits on instead of dissolving into place.
 */
const DOCK_ORDER: Readonly<Record<string, number>> = {
  '/': 0,
  '/threads': 0,
  '/projects': 0,
  '/chats': 1,
  '/assistant': 2
}

/** How far from the sign-in frame a screen sits, counting the panels as the root. */
export function screenDepth(pathname: string): number {
  if (pathname === '/sign-in') return 0
  if (isPanel(pathname)) return 1
  return /^\/threads\/[^/]+$/.test(pathname) ? 2 : 3
}

/**
 * What a change from one screen to another means, which is what decides how it
 * moves:
 *
 * - `push` and `pop` are one step down or back up the ladder, so the screen that
 *   arrives covers the one it came from and leaving it uncovers the same screen
 *   again.
 * - `next` and `prev` are two panels side by side in the dock, so both screens
 *   travel together in the direction the dock reads.
 * - `reread` is the same list read the other way, so it turns in place rather than
 *   travelling anywhere, and `reread-back` is the same turn the other way.
 * - `enter` and `leave` are the session itself opening or closing: the app rising
 *   over the sign-in frame, and settling back onto it.
 *
 * `none` is a query change on the screen already shown, which must not move.
 */
export type ScreenMotion =
  'none' | 'push' | 'pop' | 'next' | 'prev' | 'reread' | 'reread-back' | 'enter' | 'leave'

export function screenMotion(from: string, to: string): ScreenMotion {
  if (from === to) return 'none'
  if (from === '/sign-in') return 'enter'
  if (to === '/sign-in') return 'leave'
  if (WORK_READINGS.has(from) && WORK_READINGS.has(to)) {
    // Projects is the first reading in the list's own menu, so choosing it turns
    // the list upward and choosing threads turns it back.
    return to === '/projects' ? 'reread' : 'reread-back'
  }

  const fromRank = DOCK_ORDER[from]
  const toRank = DOCK_ORDER[to]
  if (fromRank !== undefined && toRank !== undefined) {
    return toRank > fromRank ? 'next' : 'prev'
  }

  return screenDepth(to) > screenDepth(from) ? 'push' : 'pop'
}
