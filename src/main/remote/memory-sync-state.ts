/**
 * Local bookkeeping for global-memory deletion sync.
 *
 * The desktop does not track individual delete calls; instead it diffs the
 * last synced global-memory id snapshot against the current local list at sync
 * time. Ids that disappeared locally become tombstones, and tombstones are
 * merged/pruned in `memory/sync-state.json` so deletions persist across syncs
 * and propagate to every device via the account profile.
 */

import type { StorageEngine } from '../storage/storage-engine'
import type { MemoryTombstone } from '../../lib/types'

export interface MemorySyncState {
  /** Global memory ids applied at the last successful sync. */
  lastSnapshotIds: string[]
  tombstones: MemoryTombstone[]
  updatedAt: number
}

const SYNC_STATE_PATH = 'memory/sync-state.json'
export const MEMORY_TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000

export async function readMemorySyncState(
  storage: StorageEngine | null
): Promise<MemorySyncState | null> {
  if (!storage) return null
  try {
    const value = await storage.read<MemorySyncState>(SYNC_STATE_PATH)
    if (!value || !Array.isArray(value.lastSnapshotIds) || !Array.isArray(value.tombstones)) {
      return null
    }
    return {
      lastSnapshotIds: value.lastSnapshotIds.filter((id): id is string => typeof id === 'string'),
      tombstones: value.tombstones.filter(
        (tombstone): tombstone is MemoryTombstone =>
          typeof tombstone === 'object' &&
          tombstone !== null &&
          typeof tombstone['id'] === 'string' &&
          typeof tombstone['deletedAt'] === 'number'
      ),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0
    }
  } catch {
    return null
  }
}

export async function writeMemorySyncState(
  storage: StorageEngine | null,
  state: MemorySyncState
): Promise<void> {
  if (!storage) return
  try {
    await storage.write(SYNC_STATE_PATH, state)
  } catch {
    // Sync bookkeeping is best-effort; a failed write only delays tombstone
    // propagation until the next successful sync.
  }
}

/** Ids that were synced before but are gone locally now — treat them as deleted. */
export function tombstonesForDeletions(
  snapshotIds: string[],
  currentIds: string[],
  now: number
): MemoryTombstone[] {
  const current = new Set(currentIds)
  return snapshotIds.filter((id) => !current.has(id)).map((id) => ({ id, deletedAt: now }))
}

/** Merge tombstone lists (id -> newest deletedAt) and prune expired ones. */
export function mergeTombstones(tombstones: MemoryTombstone[], now: number): MemoryTombstone[] {
  const byId = new Map<string, number>()
  for (const tombstone of tombstones) {
    const existing = byId.get(tombstone.id)
    if (existing === undefined || tombstone.deletedAt > existing) {
      byId.set(tombstone.id, tombstone.deletedAt)
    }
  }
  const retention = now - MEMORY_TOMBSTONE_RETENTION_MS
  const pruned: MemoryTombstone[] = []
  for (const [id, deletedAt] of byId) {
    if (deletedAt > retention) pruned.push({ id, deletedAt })
  }
  return pruned.sort((a, b) => a.deletedAt - b.deletedAt)
}
