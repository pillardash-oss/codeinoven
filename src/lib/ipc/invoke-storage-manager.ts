import type { Contract } from './contract-helpers'
import type {
  StorageAreaId,
  StorageClearResult,
  StorageClearTarget,
  StorageUsage,
  StorageVacuumResult
} from '../types'

/**
 * The Storage manager's invoke surface.
 *
 * `usage` is the one read every open performs, `clear` removes exactly the area
 * the user confirmed, and `vacuum` runs the database's own bounded compaction.
 * There is no channel that takes a path: main decides what an area is, so a
 * renderer can never name a folder to delete.
 */
export const invokeStorageManagerContract = {
  'storageManager:usage': {} as Contract<[force?: boolean], StorageUsage>,
  'storageManager:clear': {} as Contract<[target: StorageClearTarget], StorageClearResult>,
  'storageManager:vacuum': {} as Contract<[], StorageVacuumResult>,
  /** Show one area's folder, or the whole data root, in the OS file manager. */
  'storageManager:reveal': {} as Contract<[area: StorageAreaId | 'root'], boolean>
}
