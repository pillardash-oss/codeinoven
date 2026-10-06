/**
 * Last-known payload for each surface that reads from an Oven.
 *
 * A panel that talks to an Oven cannot answer the moment it opens: the answer
 * lives on another machine, behind an SSH round trip that can be slow, and can
 * fail outright with the Oven asleep. What the user should see meanwhile is
 * what that surface read last time, dimmed and marked as stale, rather than an
 * empty panel or a false "nothing here". This module is where that last-known
 * answer lives between sessions: one bounded, versioned entry per surface.
 *
 * Entries are stored one key per surface instead of one blob: a read parses
 * only what it asks for, so a large file listing never has to be re-serialized
 * because a sibling surface's status changed. An index of `{key, savedAt,
 * bytes}` keeps eviction cheap and bounded.
 *
 * Every operation is deliberately tolerant. A missing, unreadable, quoted-out,
 * or corrupt entry is the same thing to a caller: no cache. Nothing here may
 * throw into a panel's load path, and every write is best-effort, because the
 * cache is an optimization and never the source of truth.
 */
import { APP_SLUG } from '$shared/brand'

const BASE_KEY = `${APP_SLUG}.ovenSurfaceCache.v1`
const INDEX_KEY = `${BASE_KEY}.index`
const ENTRY_PREFIX = `${BASE_KEY}.entry.`

/** Bumped when the stored entry shape changes; older entries are then ignored. */
const ENTRY_VERSION = 1

/** How many surfaces stay cached. Each is one checkout's read of one panel. */
const MAX_ENTRIES = 24

/** Largest single payload kept. A bigger listing is not worth the storage. */
const MAX_ENTRY_BYTES = 262_144

/** Largest total kept across every surface, so the cache can never grow away. */
const MAX_TOTAL_BYTES = 1_048_576

/** Which panel a cached payload belongs to. */
export type OvenSurfaceKind = 'files' | 'git'

interface OvenSurfaceIndexEntry {
  key: string
  savedAt: number
  bytes: number
}

/**
 * The cache key for one surface of one remote checkout.
 *
 * The thread is part of the key, not just the Oven: two threads on the same
 * Oven read two different checkouts, and neither may be shown the other's
 * files.
 */
export function ovenSurfaceCacheKey(
  kind: OvenSurfaceKind,
  ovenId: string,
  threadId: string
): string {
  return `${kind}:${ovenId}:${threadId}`
}

/** The minimal storage surface this module needs, so tests can supply their own. */
export interface OvenSurfaceCacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function resolveStorage(override?: OvenSurfaceCacheStorage | null): OvenSurfaceCacheStorage | null {
  if (override !== undefined) return override
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    // A renderer whose storage is unavailable simply never caches.
    return null
  }
}

function readIndex(storage: OvenSurfaceCacheStorage): OvenSurfaceIndexEntry[] {
  let raw: string | null
  try {
    raw = storage.getItem(INDEX_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: OvenSurfaceIndexEntry[] = []
    for (const candidate of parsed) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const record = candidate as Record<string, unknown>
      if (typeof record.key !== 'string') continue
      const savedAt = typeof record.savedAt === 'number' ? record.savedAt : 0
      const bytes = typeof record.bytes === 'number' ? record.bytes : 0
      entries.push({ key: record.key, savedAt, bytes })
    }
    return entries
  } catch {
    return []
  }
}

function writeIndex(storage: OvenSurfaceCacheStorage, entries: OvenSurfaceIndexEntry[]): void {
  try {
    storage.setItem(INDEX_KEY, JSON.stringify(entries))
  } catch {
    // A full or unavailable storage drops the index; the next read finds no
    // cache and the next write rebuilds it.
  }
}

/**
 * Drop entries until the cache is inside both budgets.
 *
 * The newest entry is always kept, so a payload larger than the total budget
 * still serves the surface that just wrote it.
 */
function prune(
  storage: OvenSurfaceCacheStorage,
  entries: OvenSurfaceIndexEntry[]
): OvenSurfaceIndexEntry[] {
  entries.sort((left, right) => left.savedAt - right.savedAt)
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  while (entries.length > 1 && (entries.length > MAX_ENTRIES || total > MAX_TOTAL_BYTES)) {
    const oldest = entries.shift()
    if (!oldest) break
    total -= oldest.bytes
    try {
      storage.removeItem(ENTRY_PREFIX + oldest.key)
    } catch {
      // A failed removal only costs storage; the index no longer lists it.
    }
  }
  return entries
}

interface StoredEntry<T> {
  version: number
  savedAt: number
  payload: T
}

/** The last payload written for one surface, or null when none is usable. */
export function readOvenSurface<T>(
  key: string,
  override?: OvenSurfaceCacheStorage | null
): T | null {
  const storage = resolveStorage(override)
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(ENTRY_PREFIX + key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const entry = parsed as Partial<StoredEntry<T>>
    if (entry.version !== ENTRY_VERSION) return null
    return entry.payload === undefined ? null : (entry.payload as T)
  } catch {
    return null
  }
}

/** Remember one surface's payload, evicting older entries as needed. */
export function writeOvenSurface(
  key: string,
  payload: unknown,
  override?: OvenSurfaceCacheStorage | null
): void {
  const storage = resolveStorage(override)
  if (!storage) return
  let serialized: string
  try {
    serialized = JSON.stringify({ version: ENTRY_VERSION, savedAt: Date.now(), payload })
  } catch {
    // A payload that cannot be represented is simply not cacheable.
    return
  }
  const bytes = serialized.length
  if (bytes > MAX_ENTRY_BYTES) return
  try {
    storage.setItem(ENTRY_PREFIX + key, serialized)
  } catch {
    return
  }
  const index = readIndex(storage).filter((entry) => entry.key !== key)
  index.push({ key, savedAt: Date.now(), bytes })
  writeIndex(storage, prune(storage, index))
}

/** Forget one surface, for a checkout that no longer exists. */
export function removeOvenSurface(key: string, override?: OvenSurfaceCacheStorage | null): void {
  const storage = resolveStorage(override)
  if (!storage) return
  try {
    storage.removeItem(ENTRY_PREFIX + key)
  } catch {
    // Nothing to do: the entry is unreachable either way.
  }
  const index = readIndex(storage).filter((entry) => entry.key !== key)
  writeIndex(storage, index)
}
