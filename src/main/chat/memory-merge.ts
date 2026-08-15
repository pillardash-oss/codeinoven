/**
 * Client-side merge for synced global memories.
 *
 * The cloud profile sync merges global memories per entry (newest `updatedAt`
 * wins) so multiple devices sharing an account never clobber each other. This
 * mirror of the server rule is applied defensively when the cloud snapshot is
 * written back locally, so a device never loses entries it holds even if the
 * server (or an older deployment) returns a partial list.
 */

import { MEMORY_LIMITS } from './memory-service'
import type { MemoryEntry } from '../../lib/types'

/** Normalized content identity — mirrors the desktop dedupe rule. */
function contentKey(entry: MemoryEntry): string {
  return entry.content.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Merge two global-memory lists into the newest `MEMORY_LIMITS.maxEntries`
 * entries. Primary identity is the entry id (newest `updatedAt` wins); a
 * secondary content identity collapses duplicates that carry different ids
 * (e.g. two devices auto-generated the same memory with different fallback
 * ids). The result keeps insertion order of the survivors and never exceeds
 * the desktop capacity.
 */
export function mergeGlobalMemoryEntries(
  existing: MemoryEntry[],
  incoming: MemoryEntry[]
): MemoryEntry[] {
  const byId = new Map<string, MemoryEntry>()
  const byContent = new Map<string, string>()
  const consider = (entry: MemoryEntry): void => {
    const byIdWinner = byId.get(entry.id)
    if (byIdWinner) {
      if (entry.updatedAt >= byIdWinner.updatedAt) {
        byId.set(entry.id, entry)
        byContent.set(contentKey(entry), entry.id)
      }
      return
    }
    const key = contentKey(entry)
    const contentWinnerId = byContent.get(key)
    if (contentWinnerId !== undefined) {
      const contentWinner = byId.get(contentWinnerId)
      if (contentWinner && entry.updatedAt >= contentWinner.updatedAt) {
        byId.delete(contentWinnerId)
        byId.set(entry.id, entry)
        byContent.set(key, entry.id)
      }
      return
    }
    byId.set(entry.id, entry)
    byContent.set(key, entry.id)
  }
  for (const entry of existing) consider(entry)
  for (const entry of incoming) consider(entry)

  let merged = [...byId.values()]
  if (merged.length > MEMORY_LIMITS.maxEntries) {
    merged = merged
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.updatedAt - a.entry.updatedAt || a.index - b.index)
      .slice(0, MEMORY_LIMITS.maxEntries)
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => entry)
  }
  return merged
}
