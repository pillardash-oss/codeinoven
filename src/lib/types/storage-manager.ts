/**
 * The Storage manager: how the app's own data root is spent, and what the user
 * may do about it.
 *
 * The app owns exactly one directory (`getConfigRoot()`), and everything it
 * writes lives there: the database, downloaded models, recordings, caches,
 * logs, conversation workspaces, browser profiles and project data. The server
 * measures that directory as a fixed list of **areas** rather than as a live
 * folder tree, so the surface always adds up to the same whole and a row's
 * number never depends on which subfolder happened to exist that day.
 *
 * An area either answers for itself (`delete`), offers the database's own
 * bounded compaction (`vacuum`), or is handed to CIO Cleanup because its
 * removal is not a blind delete (`cleanup`). Everything else is measured and
 * reported with no action: it is the app's working data, and reclaiming it is
 * not a button the user should be able to press by accident.
 */
export type StorageAreaId =
  'database' | 'models' | 'recordings' | 'caches' | 'logs' | 'workspaces' | 'projects' | 'app-data'

/** What a row's one action does. */
export type StorageAreaAction = 'delete' | 'vacuum' | 'cleanup'

/** One measured part of the data root. */
export interface StorageArea {
  id: StorageAreaId
  /** Short name of the area, as the row reads it. */
  label: string
  /** What the area holds and what removing it costs. */
  detail: string
  bytes: number
  /** Files counted while measuring, so a row can say how much work it is. */
  files: number
  /** The one action this area offers, or null when it must be left alone. */
  action: StorageAreaAction | null
  /** The verb the row's action button carries, e.g. `Delete models`. */
  actionLabel: string | null
}

/** One complete measurement of the data root. */
export interface StorageUsage {
  /** Every byte inside the data root, mapped areas included. */
  totalBytes: number
  /** The bytes the offered actions would hand back. */
  reclaimableBytes: number
  areas: StorageArea[]
  /** When this measurement was taken, so the surface can say how old it is. */
  measuredAt: number
}

/** One destructive clear the user confirmed. Only these ids may be cleared. */
export type StorageClearTarget = 'models' | 'recordings' | 'caches' | 'logs'

/** What a clear actually removed. */
export interface StorageClearResult {
  target: StorageClearTarget
  freedBytes: number
  removedFiles: number
}

/** What one compaction handed back. */
export interface StorageVacuumResult {
  ok: boolean
  freedBytes: number
  /** The failure, when the database could not be compacted. */
  error?: string
}
