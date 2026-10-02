/**
 * The browser's user library: the pages the user has visited, and the ones they
 * saved.
 *
 * History and bookmarks are one feature in the product and one shape on disk, so
 * they share this module: one bounded record envelope, one address rule, one
 * query matcher. Both are app-owned state, which means they follow the same
 * contract as the durable tab list
 * (`src/lib/browser/global-browser-tabs.ts`): the renderer holds the live list,
 * the main process owns the file under the config root, and every field is
 * treated as untrusted input on the way in   arriving from a renderer, or from a
 * file any process could have written   and *repaired* rather than rejected,
 * because silently dropping a record the user could see is exactly the data loss
 * this module exists to prevent.
 *
 * A visit is keyed by its address: the same page visited again is the same
 * record moved to the front with its visit count bumped, which is what makes a
 * capped list useful for suggestions instead of a wall of one site's pagination.
 */

import {
  MAX_BROWSER_TAB_PAGE_TITLE_LENGTH,
  MAX_BROWSER_TAB_URL_LENGTH,
  MAX_GLOBAL_BROWSER_BOXES,
  DEFAULT_BOX_ID,
  isBrowserBoxId,
  isStorableBrowserFavicon,
  parseAppearance
} from './global-browser-tabs'
import { looksLikeBrowserAddress } from '../browser-search-engines'
import { normalizeBrowserUrl } from '../local-development-url'

/** Where the durable browsing history lives, relative to the config root. */
export const BROWSER_HISTORY_STATE_RELATIVE_PATH = 'state/browser-history.json'
/** Where the durable bookmark list lives, relative to the config root. */
export const BROWSER_BOOKMARKS_STATE_RELATIVE_PATH = 'state/browser-bookmarks.json'
/** Bumped only if a stored shape changes incompatibly. */
export const BROWSER_LIBRARY_SNAPSHOT_VERSION = 1

/**
 * How many history records the file may hold, whatever the user configured.
 *
 * The configured cap is what evicts entries; this is the ceiling the *file* is
 * read and written with, so a hand-edited or corrupted file cannot make the app
 * load an unbounded list into memory.
 */
export const MAX_BROWSER_HISTORY_RECORDS = 10_000
/** How many bookmarks are kept. A bookmark is a user intent, so it is never
 *  evicted for a newer one: the ceiling only bounds a corrupt file. */
export const MAX_BROWSER_BOOKMARKS = 5_000

/**
 * How long a change to either library waits before it is written.
 *
 * A visit is one write per page otherwise, and a redirect chain, a paginated
 * flow or an agent clicking through a site is a burst of them: one write per burst
 * is what keeps a capped list from costing more than it is worth. A quit flushes
 * the pending write outright, so the delay can never lose the last visit.
 */
export const BROWSER_LIBRARY_SAVE_COALESCE_MS = 400

/** One visited page. */
export interface BrowserHistoryEntry {
  /** The committed address, normalized. It is also the record's identity. */
  url: string
  /** The page's own title when one was reported, otherwise the address. */
  title: string
  /** Epoch milliseconds of the most recent visit. */
  visitedAt: number
  /** How many times this address has been visited. */
  visitCount: number
}

/** The stored browsing history, newest first. */
export interface BrowserHistorySnapshot {
  entries: BrowserHistoryEntry[]
  /** Durable visits from named boxes, keyed by their stable box id. */
  boxEntries?: Record<string, BrowserHistoryEntry[]>
}

/** One saved page. */
export interface BrowserBookmark {
  id: string
  url: string
  title: string
  /** Epoch milliseconds the page was saved. */
  createdAt: number
  /**
   * The page's own icon, as the data URL the app had when the page was saved.
   *
   * A copy rather than a lookup: a bookmark is durable state, so its default icon
   * is in the file instead of being reachable only while the site and the network
   * are. It is exactly the icon the tab that saved the page was wearing by default,
   * and any icon the user chooses replaces it. A stored icon follows one rule
   * wherever the app keeps one, a tab or a saved page: see
   * `isStorableBrowserFavicon`.
   */
  favicon: string | null
  /**
   * The icon the user chose, in the same vocabulary a project, a routine, a tab,
   * a group and a box use: a `PROJECT_SVG_ICONS` key, a sanitized pasted SVG, or
   * a picked image file. All null while the page wears its own favicon. A
   * bookmark takes the icon half of that vocabulary only: there is no accent to
   * tint in a list of pages.
   */
  iconType: string | null
  customSvg: string | null
  imagePath: string | null
}

/** The stored bookmark list, in the order the user put it in. */
export interface BrowserBookmarksSnapshot {
  bookmarks: BrowserBookmark[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A bounded string, or the fallback when the stored value is not one. Repairing
 *  the field keeps the record it belongs to. */
function boundedString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/** A safe integer at or after `floor`, or the fallback. */
function safeTimestamp(value: unknown, fallback: number, floor = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < floor) return fallback
  return value
}

/**
 * The address a browser library record may hold, or null.
 *
 * Only `http:` and `https:` are library material, with no embedded credentials:
 * everything else a browser can display (an `about:` popup document, a `file:`
 * path, a `javascript:` string) is either not a page the user navigated to or not
 * an address worth offering again.
 */
export function normalizeBrowserLibraryUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '' || value.length > MAX_BROWSER_TAB_URL_LENGTH) return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username !== '' || parsed.password !== '') return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * The host of an address, for display and for ranking a suggestion: the `www.`
 * prefix is dropped because nobody types it, and a port is kept because
 * `localhost:5173` and `localhost:3000` are different pages.
 */
export function browserLibraryHost(url: string): string {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./u, '')
    return parsed.port ? `${host}:${parsed.port}` : host
  } catch {
    return ''
  }
}

function historyEntry(value: unknown): BrowserHistoryEntry | null {
  if (!isRecord(value)) return null
  const url = normalizeBrowserLibraryUrl(value['url'])
  if (url === null) return null
  const visitedAt = safeTimestamp(value['visitedAt'], 0)
  const rawCount = value['visitCount']
  const visitCount =
    typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1
  // A page with no title is still a page; the address is the label the surfaces
  // fall back to, and it is filled in on the next visit.
  const title = boundedString(value['title'], MAX_BROWSER_TAB_PAGE_TITLE_LENGTH).trim()
  return { url, title: title === '' ? browserLibraryHost(url) : title, visitedAt, visitCount }
}

/**
 * A bounded, repaired view of anything that claims to be a stored history.
 *
 * Newest first, one record per address, capped at the file ceiling. Never fails:
 * a value that is not a snapshot at all parses to an empty one.
 */
export function parseBrowserHistorySnapshot(value: unknown): BrowserHistorySnapshot {
  if (!isRecord(value)) return { entries: [] }
  const entries = parseHistoryEntries(Array.isArray(value['entries']) ? value['entries'] : [])
  const boxEntries: Record<string, BrowserHistoryEntry[]> = {}
  const rawBoxes = value['boxEntries']
  if (isRecord(rawBoxes)) {
    for (const [boxId, records] of Object.entries(rawBoxes).slice(0, MAX_GLOBAL_BROWSER_BOXES)) {
      if (!isBrowserBoxId(boxId) || boxId === DEFAULT_BOX_ID || !Array.isArray(records)) continue
      boxEntries[boxId] = parseHistoryEntries(records)
    }
  }
  return Object.keys(boxEntries).length > 0 ? { entries, boxEntries } : { entries }
}

function parseHistoryEntries(records: readonly unknown[]): BrowserHistoryEntry[] {
  const byUrl = new Map<string, BrowserHistoryEntry>()
  for (const stored of records) {
    const entry = historyEntry(stored)
    if (!entry) continue
    const existing = byUrl.get(entry.url)
    if (!existing) {
      byUrl.set(entry.url, entry)
      continue
    }
    mergeHistoryEntry(existing, entry)
  }
  return [...byUrl.values()]
    .sort((a, b) => b.visitedAt - a.visitedAt)
    .slice(0, MAX_BROWSER_HISTORY_RECORDS)
}

/** Fold a duplicate record into the one being kept, in place. */
function mergeHistoryEntry(kept: BrowserHistoryEntry, duplicate: BrowserHistoryEntry): void {
  kept.visitCount = Math.max(kept.visitCount, duplicate.visitCount)
  if (duplicate.visitedAt > kept.visitedAt) {
    kept.visitedAt = duplicate.visitedAt
    kept.title = duplicate.title
  }
}

function bookmark(value: unknown): BrowserBookmark | null {
  if (!isRecord(value)) return null
  const url = normalizeBrowserLibraryUrl(value['url'])
  if (url === null) return null
  const rawId = value['id']
  const id = typeof rawId === 'string' && rawId !== '' && rawId.length <= 128 ? rawId : null
  const title = boundedString(value['title'], MAX_BROWSER_TAB_PAGE_TITLE_LENGTH).trim()
  const appearance = parseAppearance(value)
  return {
    id: id ?? `bookmark:${crypto.randomUUID()}`,
    url,
    title: title === '' ? browserLibraryHost(url) : title,
    createdAt: safeTimestamp(value['createdAt'], Date.now()),
    favicon: isStorableBrowserFavicon(value['favicon']) ? value['favicon'] : null,
    iconType: appearance.iconType,
    customSvg: appearance.customSvg,
    imagePath: appearance.imagePath
  }
}

/**
 * A bounded, repaired view of anything that claims to be a stored bookmark list.
 *
 * The stored order is kept: the list is the user's own, and its order is what
 * their reordering produced. A file written before order was theirs is already
 * newest first, so preserving it is also the shape it was written in.
 */
export function parseBrowserBookmarksSnapshot(value: unknown): BrowserBookmarksSnapshot {
  if (!isRecord(value) || !Array.isArray(value['bookmarks'])) return { bookmarks: [] }
  const bookmarks: BrowserBookmark[] = []
  const seenUrls = new Set<string>()
  const seenIds = new Set<string>()
  for (const stored of value['bookmarks']) {
    if (bookmarks.length >= MAX_BROWSER_BOOKMARKS) break
    const parsed = bookmark(stored)
    if (!parsed) continue
    let id = parsed.id
    while (seenIds.has(id)) id = `bookmark:${crypto.randomUUID()}`
    // One saved page is one row: a duplicate address would render twice and
    // removing either copy would look like nothing happened.
    if (seenUrls.has(parsed.url)) continue
    seenUrls.add(parsed.url)
    seenIds.add(id)
    bookmarks.push({ ...parsed, id })
  }
  return { bookmarks }
}

/**
 * The address a bookmark editor's URL field produces, or null when what was typed
 * is not a web address.
 *
 * Accepts exactly what an address bar accepts as a URL, so a saved page can never
 * be re-addressed to something the browser would have searched for instead.
 */
export function normalizeBookmarkAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!looksLikeBrowserAddress(trimmed)) return null
  return normalizeBrowserLibraryUrl(normalizeBrowserUrl(trimmed))
}

/** The JSON payload for a stored library file: the records, stamped with the
 *  moment and the shape they were written in. */
function librarySnapshotPayload(records: Record<string, unknown>): Record<string, unknown> {
  return {
    version: BROWSER_LIBRARY_SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    ...records
  }
}

export function browserHistorySnapshotPayload(
  snapshot: BrowserHistorySnapshot
): Record<string, unknown> {
  return librarySnapshotPayload({
    entries: snapshot.entries,
    boxEntries: snapshot.boxEntries ?? {}
  })
}

export function browserBookmarksSnapshotPayload(
  snapshot: BrowserBookmarksSnapshot
): Record<string, unknown> {
  return librarySnapshotPayload({ bookmarks: snapshot.bookmarks })
}

/**
 * How well a history record answers a query, or -1 when it does not.
 *
 * Lower is better. Rank is by where the match lands   host, then title, then the
 * rest of the address   because that is the order a person means when they type
 * into an address bar: the site they are going back to, then the page they
 * remember, then anything else that happens to contain the text.
 */
function libraryMatchRank(record: { url: string; title: string }, needle: string): number {
  const host = browserLibraryHost(record.url).toLowerCase()
  if (host.startsWith(needle)) return 0
  if (host.includes(needle)) return 1
  const title = record.title.toLowerCase()
  if (title.startsWith(needle)) return 2
  if (title.includes(needle)) return 3
  return record.url.toLowerCase().includes(needle) ? 4 : -1
}

/**
 * The history records to offer for a query, best first.
 *
 * An empty query offers the most recent pages, which is what an address bar shows
 * when the user has typed nothing yet. A query keeps only records it can place,
 * ranked by where the text matched and then by recency, so the page the user
 * means is the first one Enter would take.
 */
export function browserHistorySuggestions(
  entries: readonly BrowserHistoryEntry[],
  query: string,
  limit: number
): BrowserHistoryEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return entries.slice(0, limit)
  const ranked: { entry: BrowserHistoryEntry; rank: number }[] = []
  for (const entry of entries) {
    const rank = libraryMatchRank(entry, needle)
    if (rank < 0) continue
    ranked.push({ entry, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || b.entry.visitedAt - a.entry.visitedAt)
  return ranked.slice(0, limit).map((candidate) => candidate.entry)
}

/** Whether one bookmark answers a query. The rule the history suggestions rank
 *  with, minus the ranking: a panel filters, it does not order. */
export function browserBookmarkMatches(bookmark: BrowserBookmark, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return libraryMatchRank(bookmark, needle) >= 0
}

/** Whether one history record answers a query. */
export function browserHistoryMatches(entry: BrowserHistoryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return libraryMatchRank(entry, needle) >= 0
}
