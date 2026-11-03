import type { RunReceipt } from '../../../lib/types'

/**
 * The receipt cache.
 *
 * Rendering a receipt must cost nothing once it has been read, because a
 * conversation can re-render it on every scroll and every fold. The key is the
 * range itself   project, scope, base and head   so a re-render of an unchanged
 * range is a hit, a new commit is a miss, and nothing has to be invalidated by a
 * timer that would then need its own reason to run.
 *
 * Background work only when there is work to do: entries expire on read rather
 * than on an interval, so an idle app owns no timer for receipts at all.
 */

/** Entries one cache holds: enough for an open conversation's receipts. */
export const RUN_RECEIPT_CACHE_ENTRIES = 24

/** How long a read stays current. A settled run costs one read per window. */
export const RUN_RECEIPT_CACHE_TTL_MS = 10 * 60_000

interface Entry {
  receipt: RunReceipt
  storedAt: number
}

export class RunReceiptCache {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly maxEntries = RUN_RECEIPT_CACHE_ENTRIES,
    private readonly ttlMs = RUN_RECEIPT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** The cache key one range reads under. */
  static key(
    projectId: string,
    scopeBucketId: string,
    baseSha: string | null,
    headSha: string | null
  ): string {
    return [projectId, scopeBucketId, baseSha ?? '-', headSha ?? '-'].join('\u0000')
  }

  get(key: string): RunReceipt | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (this.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key)
      return null
    }
    return entry.receipt
  }

  set(key: string, receipt: RunReceipt): void {
    this.entries.delete(key)
    this.entries.set(key, { receipt, storedAt: this.now() })
    // Oldest-first eviction: a conversation that walks back through many
    // threads must not grow this map without a bound.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  /** Drop one entry, which invalidation does by its full key. */
  delete(key: string): void {
    this.entries.delete(key)
  }

  /** Drop every entry, which a scope change or a repair can do without IO. */
  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
