/**
 * One tab's Back/Forward stack, in the shape it survives a restart.
 *
 * The stack itself lives in the live `WebContentsView` and dies with it, which is
 * exactly what hibernation, closing the app and parking a view do to it. So the
 * app keeps its own copy: the entries a tab has been through, and which one it is
 * on. It is app-owned state on disk, like the durable tab list and the browsing
 * library, and it is treated the same way: an untrusted payload is repaired rather
 * than rejected.
 *
 * The copy is keyed by tab id and carries the tab's own `(projectId, threadId)`,
 * which is what scopes it. A record is only ever restored into the tab that wrote
 * it, so a thread browser's history can never appear behind the global browser's
 * Back button, and a thread browser that is gone takes its history with it.
 *
 * `pageState` is Chromium's own opaque page snapshot (scroll position, form
 * values). It is by far the largest part of an entry and the least of what the
 * user asked for, so it is kept for the entry the tab was actually on and dropped
 * for the rest, leaving a stack that costs a few hundred bytes per page instead of
 * kilobytes.
 */

import { MAX_BROWSER_TAB_PAGE_TITLE_LENGTH } from './global-browser-tabs'
import { normalizeBrowserLibraryUrl } from './browser-library'

/** Where a tab's navigation history lives, relative to the config root. */
export const BROWSER_TAB_HISTORY_STATE_RELATIVE_PATH = 'state/browser-tab-history.json'
/** Bumped only if the stored shape changes incompatibly. */
export const BROWSER_TAB_HISTORY_SNAPSHOT_VERSION = 1

/**
 * How many entries of one tab's stack are kept.
 *
 * A real stack is unbounded: a session spent clicking through a site produces
 * hundreds of entries, most of them pages nobody will walk back through. The
 * window closest to the active entry is the part still reachable by a person
 * clicking Back a few times, so the far ends of a long stack are dropped.
 */
export const MAX_BROWSER_TAB_HISTORY_ENTRIES = 60
/**
 * How many tabs' stacks the file holds.
 *
 * The strip caps are 100 global tabs plus a bounded thread-browser list, so this
 * covers every tab the app can have open at once with room to spare. It is a
 * ceiling on a corrupt or hand-edited file rather than an eviction policy: a
 * record is dropped when its tab is closed, not when it gets old.
 */
export const MAX_BROWSER_TAB_HISTORY_RECORDS = 200
/** The most of Chromium's own page snapshot that is kept, for the active entry. */
export const MAX_BROWSER_HISTORY_PAGE_STATE_LENGTH = 8_192

/** One page of a tab's history, as it is stored. */
export interface BrowserTabHistoryEntry {
  /** The committed address. Only a page the browser would load again is kept. */
  url: string
  /** The title the page reported, or an empty string. */
  title: string
  /** Chromium's opaque page snapshot, kept only for the active entry and only when
   *  it fits its bound whole (see {@link MAX_BROWSER_HISTORY_PAGE_STATE_LENGTH}). */
  pageState?: string
}

/** One tab's stored stack, and the tab that owns it. */
export interface BrowserTabHistoryRecord {
  /** The project the tab belongs to. `browser-global` for a global tab. */
  projectId: string
  /** The thread the tab belongs to. */
  threadId: string
  /** The entries, oldest first, the way `navigationHistory` reports them. */
  entries: BrowserTabHistoryEntry[]
  /** Which entry the tab was on, as an index into `entries`. */
  index: number
  /** Epoch milliseconds of the last capture. */
  updatedAt: number
}

/** The stored navigation history of every tab that has one, keyed by tab id. */
export interface BrowserTabHistorySnapshot {
  records: Record<string, BrowserTabHistoryRecord>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/**
 * Chromium's page snapshot when it is worth keeping, or undefined.
 *
 * The snapshot arrives as a base64 data string, so one that does not fit its bound
 * is dropped whole rather than sliced: a truncated blob is not a smaller snapshot,
 * it is an invalid one. Both paths into a record run through here, so a capture can
 * no more put a kilobyte-heavy entry on disk than a hand-edited file can.
 */
function boundedPageState(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length <= MAX_BROWSER_HISTORY_PAGE_STATE_LENGTH ? value : undefined
}

/**
 * Drop `pageState` from every entry but the one the tab is on.
 *
 * Applied on both paths into a record, so neither a hand-edited file nor an
 * over-eager capture can hold a stack that costs kilobytes per page. The snapshot
 * is the only part of an entry that scales with the page rather than with the
 * address.
 */
function keepPageStateOnActiveEntry(
  entries: readonly BrowserTabHistoryEntry[],
  index: number
): BrowserTabHistoryEntry[] {
  return entries.map((entry, position) => {
    const pageState = position === index ? boundedPageState(entry.pageState) : undefined
    if (pageState === undefined) return { url: entry.url, title: entry.title }
    return { url: entry.url, title: entry.title, pageState }
  })
}

/**
 * A window of a tab's stack that is worth keeping, re-indexed.
 *
 * Entries the browser would refuse to load again (an `about:` document, a
 * `javascript:` string) are dropped rather than stored: restoring one would either
 * be blocked by the tab's own navigation policy or put a page on screen the
 * address bar cannot describe. Dropping entries moves the active index, so the
 * index is recomputed here rather than carried.
 *
 * Returns null when nothing loadable is left, which is the signal that this tab
 * has no history worth a record.
 */
export function boundedBrowserTabHistory(
  entries: readonly BrowserTabHistoryEntry[],
  activeIndex: number
): { entries: BrowserTabHistoryEntry[]; index: number } | null {
  const loadable: BrowserTabHistoryEntry[] = []
  let loadableIndex = -1
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position]
    const url = normalizeBrowserLibraryUrl(entry.url)
    if (url === null) continue
    if (position === activeIndex) loadableIndex = loadable.length
    const next: BrowserTabHistoryEntry = {
      url,
      title: boundedString(entry.title, MAX_BROWSER_TAB_PAGE_TITLE_LENGTH)
    }
    if (entry.pageState !== undefined) next.pageState = entry.pageState
    loadable.push(next)
  }
  if (loadable.length === 0) return null
  const active = loadableIndex < 0 ? loadable.length - 1 : loadableIndex
  if (loadable.length <= MAX_BROWSER_TAB_HISTORY_ENTRIES) {
    return { entries: keepPageStateOnActiveEntry(loadable, active), index: active }
  }
  // Keep the window closest to the active entry, with more of it behind than
  // ahead, because Back is what a person reaches for.
  const half = Math.floor(MAX_BROWSER_TAB_HISTORY_ENTRIES / 2)
  const furthest = loadable.length - MAX_BROWSER_TAB_HISTORY_ENTRIES
  const start = Math.max(0, Math.min(active - half, furthest))
  const windowed = loadable.slice(start, start + MAX_BROWSER_TAB_HISTORY_ENTRIES)
  const index = active - start
  return { entries: keepPageStateOnActiveEntry(windowed, index), index }
}

/** One stored entry, or null when it is not a page the browser would load again. */
function storedEntry(value: unknown): BrowserTabHistoryEntry | null {
  if (!isRecord(value)) return null
  const url = normalizeBrowserLibraryUrl(value['url'])
  if (url === null) return null
  const entry: BrowserTabHistoryEntry = {
    url,
    title: boundedString(value['title'], MAX_BROWSER_TAB_PAGE_TITLE_LENGTH)
  }
  // Bounded here as well as on the capture path, so an oversized blob is refused
  // before it is held rather than after.
  const pageState = boundedPageState(value['pageState'])
  if (pageState !== undefined) entry.pageState = pageState
  return entry
}

/** One stored record, or null when it does not describe a restorable stack. */
function storedRecord(value: unknown): BrowserTabHistoryRecord | null {
  if (!isRecord(value)) return null
  const projectId = value['projectId']
  const threadId = value['threadId']
  if (typeof projectId !== 'string' || projectId.length === 0 || projectId.length > 512) return null
  if (typeof threadId !== 'string' || threadId.length > 512) return null
  const rawEntries = value['entries']
  if (!Array.isArray(rawEntries)) return null
  const entries: BrowserTabHistoryEntry[] = []
  for (const stored of rawEntries) {
    if (entries.length >= MAX_BROWSER_TAB_HISTORY_ENTRIES) break
    const entry = storedEntry(stored)
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return null
  const rawIndex = value['index']
  const index =
    typeof rawIndex === 'number' && Number.isSafeInteger(rawIndex)
      ? Math.max(0, Math.min(rawIndex, entries.length - 1))
      : entries.length - 1
  const rawUpdatedAt = value['updatedAt']
  const updatedAt =
    typeof rawUpdatedAt === 'number' && Number.isSafeInteger(rawUpdatedAt) && rawUpdatedAt > 0
      ? rawUpdatedAt
      : Date.now()
  return {
    projectId,
    threadId,
    // The same rule the capture path applies, so a hand-edited file cannot put
    // a page snapshot on sixty entries.
    entries: keepPageStateOnActiveEntry(entries, index),
    index,
    updatedAt
  }
}

/**
 * A bounded, repaired view of anything that claims to be a stored navigation
 * history.
 *
 * Never fails and never returns null: a value that is not a snapshot at all parses
 * to an empty one, and a value that is one keeps every tab whose stack it can
 * still describe. Once the file ceiling is reached the most recently captured
 * records are the ones kept, because a tab that has not been visited since is the
 * one a corrupt file should lose first.
 */
export function parseBrowserTabHistorySnapshot(value: unknown): BrowserTabHistorySnapshot {
  if (!isRecord(value)) return { records: {} }
  const stored = value['records']
  if (!isRecord(stored)) return { records: {} }
  const candidates: { tabId: string; record: BrowserTabHistoryRecord }[] = []
  for (const [tabId, rawRecord] of Object.entries(stored)) {
    if (tabId.length === 0 || tabId.length > 512) continue
    const record = storedRecord(rawRecord)
    if (record) candidates.push({ tabId, record })
  }
  candidates.sort((a, b) => b.record.updatedAt - a.record.updatedAt)
  const records: Record<string, BrowserTabHistoryRecord> = {}
  for (const candidate of candidates.slice(0, MAX_BROWSER_TAB_HISTORY_RECORDS)) {
    records[candidate.tabId] = candidate.record
  }
  return { records }
}

/** The JSON payload for the durable file, stamped with the moment it was written. */
export function browserTabHistorySnapshotPayload(
  snapshot: BrowserTabHistorySnapshot
): Record<string, unknown> {
  return {
    version: BROWSER_TAB_HISTORY_SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    records: snapshot.records
  }
}
