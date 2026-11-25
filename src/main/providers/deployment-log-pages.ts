/**
 * Read an arbitrarily long provider log in tail-first pages.
 *
 * A deployment log is evidence, so it is never discarded. Handing a multi
 * megabyte payload to the renderer in one IPC message would put the whole log
 * on the UI thread at once, so main keeps the full payload and serves it in
 * windows instead: the newest window first, and each earlier window on request
 * through an opaque cursor.
 *
 * Windows are cut on a boundary the renderer can still parse:
 * - A Coolify log is one JSON-encoded array of entries, so a window is a
 *   complete array of whole entries (never a half-written entry, and never a
 *   stray comma).
 * - Anything else is plain text, so a window is a run of complete lines.
 *
 * Cursors count units from the START of the payload (entries, or lines), which
 * stays stable while a build appends at the end: loading an earlier window of
 * a log that grew in the meantime still lands on the same content.
 */

/** Characters one page may carry before the next earlier page is required. */
export const DEPLOYMENT_LOG_PAGE_CHARACTERS = 200_000

/** One readable window of a provider log. */
export interface DeploymentLogPage {
  /** Raw payload text of this window (a complete JSON array, or whole lines). */
  log: string
  /** True while earlier content exists behind {@link cursor}. */
  hasMore: boolean
  /** Pass back as `before` to read the preceding window; null at the head. */
  cursor: string | null
}

/** Byte span of one top-level array entry inside a structured log payload. */
interface EntrySpan {
  start: number
  end: number
}

/**
 * A payload prepared once for paging: a structured log keeps its entry spans,
 * and plain text keeps its lines.
 */
export interface PreparedDeploymentLog {
  payload: string
  entries: EntrySpan[] | null
  lines: string[] | null
}

/** Prepare a payload for repeated paging (scanned once, then reused). */
export function prepareDeploymentLog(payload: string): PreparedDeploymentLog {
  if (payload.startsWith('[')) {
    const entries = scanEntrySpans(payload)
    // An array payload with no complete entry (an empty build log, or JSON cut
    // before the first entry closed) is read as plain text so nothing is lost.
    if (entries.length > 0) return { payload, entries, lines: null }
  }
  return { payload, entries: null, lines: payload.split(/\r?\n/u) }
}

/** Read one window of a raw payload. */
export function readDeploymentLogPage(
  payload: string,
  before?: string,
  budget = DEPLOYMENT_LOG_PAGE_CHARACTERS
): DeploymentLogPage {
  return readPreparedDeploymentLogPage(prepareDeploymentLog(payload), before, budget)
}

/** Read one window of a payload that was already prepared for paging. */
export function readPreparedDeploymentLogPage(
  prepared: PreparedDeploymentLog,
  before?: string,
  budget = DEPLOYMENT_LOG_PAGE_CHARACTERS
): DeploymentLogPage {
  const total = prepared.entries?.length ?? prepared.lines?.length ?? 0
  if (total === 0) return { log: '', hasMore: false, cursor: null }

  const requestedEnd = parseCursor(before)
  // A missing or nonsensical cursor reads the newest window; a cursor at the
  // head means there is nothing earlier to load.
  const end = requestedEnd === null ? total : Math.min(requestedEnd, total)
  if (end <= 0) return { log: '', hasMore: false, cursor: null }

  const start = prepared.entries
    ? windowStart(
        end,
        budget,
        (index) => (prepared.entries?.[index]?.end ?? 0) - (prepared.entries?.[index]?.start ?? 0)
      )
    : windowStart(end, budget, (index) => (prepared.lines?.[index]?.length ?? 0) + 1)

  const log = prepared.entries
    ? renderEntries(prepared.payload, prepared.entries, start, end)
    : (prepared.lines ?? []).slice(start, end).join('\n')

  return {
    log,
    hasMore: start > 0,
    cursor: start > 0 ? String(start) : null
  }
}

/** Render a complete JSON array holding entries `[start, end)`. */
function renderEntries(payload: string, entries: EntrySpan[], start: number, end: number): string {
  const first = entries[start]
  const last = entries[end - 1]
  if (!first || !last) return '[]'
  return `[${payload.slice(first.start, last.end)}]`
}

/**
 * Index of the first unit kept by a window that ends at `end` and carries at
 * most `budget` characters. A single oversized unit is kept whole rather than
 * skipped, because a window that renders nothing would hide real content.
 *
 * Unit sizes are read through a callback rather than a lengths array so paging
 * a long log never allocates one entry per line.
 */
function windowStart(end: number, budget: number, lengthAt: (index: number) => number): number {
  let start = end
  let used = 0
  while (start > 0) {
    const length = lengthAt(start - 1)
    if (start < end && used + length > budget) break
    used += length
    start -= 1
    if (used >= budget) break
  }
  return start
}

/** Parse an opaque cursor into a unit count, or null when it is not one. */
function parseCursor(before: string | undefined): number | null {
  if (before === undefined) return null
  const parsed = Number(before)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null
  return parsed
}

/**
 * Spans of the complete top-level array entries in a payload. A payload cut
 * mid-entry (the provider capped it) yields only the entries that closed, so a
 * window is never built from half an entry.
 */
function scanEntrySpans(payload: string): EntrySpan[] {
  const spans: EntrySpan[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let start = -1

  for (let index = 1; index < payload.length; index += 1) {
    const char = payload[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (depth === 0) {
      if (char === ']') break
      if (char === '{' || char === '[') {
        depth = 1
        start = index
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        spans.push({ start, end: index + 1 })
        start = -1
      }
    }
  }

  return spans
}

interface CachedPayload {
  prepared: PreparedDeploymentLog
  fetchedAt: number
}

/**
 * Full provider logs kept in main so paging through one log does not re-read the
 * provider for every window. Bounded by age, entry count, and total characters,
 * so a handful of huge builds can never grow main's memory without limit.
 */
export class DeploymentLogPageCache {
  private readonly entries = new Map<string, CachedPayload>()
  private totalCharacters = 0

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxPayloads = 6,
    private readonly maxCharacters = 24_000_000
  ) {}

  /** The prepared payload for `key`, or null when absent or expired. */
  get(key: string): PreparedDeploymentLog | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.drop(key)
      return null
    }
    return entry.prepared
  }

  /** Cache a payload for `key` and return its prepared form. */
  set(key: string, payload: string): PreparedDeploymentLog {
    this.drop(key)
    const prepared = prepareDeploymentLog(payload)
    // A payload larger than the whole budget is still served, it just is not
    // kept: paging it re-reads the provider instead of evicting everything else.
    if (payload.length <= this.maxCharacters) {
      this.entries.set(key, { prepared, fetchedAt: Date.now() })
      this.totalCharacters += payload.length
      this.evict()
    }
    return prepared
  }

  /** Forget one key, e.g. when its deployment was refreshed. */
  drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.totalCharacters -= entry.prepared.payload.length
    this.entries.delete(key)
  }

  /** Drop everything (a provider account changed, so no payload is still valid). */
  clear(): void {
    this.entries.clear()
    this.totalCharacters = 0
  }

  /** Evict the oldest payloads until the cache fits its bounds. */
  private evict(): void {
    while (this.entries.size > this.maxPayloads || this.totalCharacters > this.maxCharacters) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.fetchedAt < oldestAt) {
          oldestAt = entry.fetchedAt
          oldestKey = key
        }
      }
      if (oldestKey === null) return
      this.drop(oldestKey)
    }
  }
}
