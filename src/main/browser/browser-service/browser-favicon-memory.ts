import { originOf } from '../../../lib/local-development-url'

/**
 * The favicons one browser tab remembers, as a pure decision.
 *
 * Chromium announces an icon only when a document resolves to a different one
 * than the tab already holds. A reload, a client-side redirect, or a link inside
 * one site commits a fresh document carrying the same icon, so no announcement
 * ever follows it. Clearing the tab on every committed navigation therefore left
 * those documents iconless until the site happened to change its icon, and the
 * tab strip fell back to its globe.
 *
 * The tab remembers the icon of each origin it has shown instead. A document is
 * adopted with the icon its own origin is known by, and a document from an origin
 * the tab has never shown starts out without one, so a real move to another site
 * still drops the old site's icon.
 *
 * Kept out of `BrowserService` for the same reason as `browser-tab-mark`: the
 * rule is a function of the committed URL and the icons already remembered, and
 * nothing about a `WebContentsView`. Memory rather than a fetch, because the icon
 * of a site the tab has already shown is the data URL the tab already holds.
 */

/**
 * How many origins one tab remembers the icon of.
 *
 * A tab follows the pages a user reads, not the whole web, so a handful covers
 * returning to a site. The cap is what keeps a long-lived tab's memory from
 * growing with the session, and each remembered icon is a data URL bounded by the
 * favicon service, so the worst case stays small.
 */
const REMEMBERED_ORIGINS_PER_TAB = 6

/**
 * The origin an icon can be remembered under, or null when the page has none to
 * speak of: a `data:` or `file:` document has an opaque origin, which every such
 * document would otherwise share as one bucket.
 */
export function faviconOriginOf(url: string): string | null {
  const origin = originOf(url)
  return origin === null || origin === 'null' ? null : origin
}

/**
 * Remember the icon a document announced as the icon of the origin that showed it.
 *
 * Called on every icon update and on every adoption, so the map stays ordered
 * most-recently-used last, which is what the eviction here reads.
 */
export function rememberFavicon(
  memory: Map<string, string>,
  origin: string,
  favicon: string
): void {
  memory.delete(origin)
  memory.set(origin, favicon)
  while (memory.size > REMEMBERED_ORIGINS_PER_TAB) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) return
    memory.delete(oldest)
  }
}

/**
 * The icon to put on a tab whose document just committed at `url`: the icon that
 * URL's origin is known by, or null when the tab has not shown that origin yet.
 */
export function faviconForCommittedUrl(memory: Map<string, string>, url: string): string | null {
  const origin = faviconOriginOf(url)
  if (origin === null) return null
  const favicon = memory.get(origin)
  if (favicon === undefined) return null
  // Showing an icon again counts as using it, so the site a session keeps coming
  // back to outlives one it merely passed through.
  rememberFavicon(memory, origin, favicon)
  return favicon
}
