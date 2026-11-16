import type { StorageAreaId, StorageClearTarget } from '../../lib/types'

/**
 * What the storage usage worker is asked to do.
 *
 * Both requests carry the data root rather than resolving it in the worker, so
 * a redirected root (a probe, a second instance) is measured exactly as the
 * main process sees it, and the worker never has to guess which app root it
 * belongs to.
 */
export type StorageUsageWorkerRequest =
  | { kind: 'usage'; root: string }
  | { kind: 'clear'; root: string; target: StorageClearTarget }
  /** Resolve the folder a reveal should open; the main process opens it. */
  | { kind: 'reveal'; root: string; area: StorageAreaId | 'root' }
