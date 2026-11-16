import { shell } from 'electron'
import { Logger } from '../system/logger'
import type {
  StorageAreaId,
  StorageClearResult,
  StorageClearTarget,
  StorageUsage,
  StorageVacuumResult
} from '../../lib/types'
import { StorageUsageWorker } from './storage-usage-worker'

/**
 * How long a measurement stays valid.
 *
 * A walk of the data root is the expensive part of this feature, so the answer
 * is kept for a while: five minutes is long enough that reopening the surface,
 * or switching away and back, never pays for a second walk, and short enough
 * that the number on screen is never meaningfully out of date. A measurement
 * that finishes after its window closed still lands in this cache, which is
 * what makes a closed-mid-measure open instant the next time.
 */
const USAGE_CACHE_MS = 5 * 60_000

/** Pages handed back per compaction step. */
const VACUUM_PAGES_PER_CHUNK = 512

/**
 * Steps one compaction may run. The ceiling bounds how long a write lock is
 * ever held: whatever is still free after it is collected by pressing Compact
 * again, rather than by blocking the database for minutes.
 */
const VACUUM_MAX_CHUNKS = 128

/** Pause between compaction steps, so a step never lands back-to-back with the next. */
const VACUUM_GAP_MS = 32

/** The database's own bounded compaction and size read, off the main thread. */
export interface StorageDatabaseMaintenance {
  sizeTelemetry(): Promise<{
    ok: boolean
    dbBytes: number
    walBytes: number
    shmBytes: number
    error?: string
  }>
  incrementalVacuum(pages: number): Promise<{ ok: boolean; freedPages?: number; error?: string }>
  truncateCheckpoint?(): Promise<{ ok: boolean; error?: string }>
}

export interface StorageManagerDeps {
  /** The one directory the app owns, read at call time so a redirect is honoured. */
  configRoot: () => string
  /** The database's compaction, or null before it exists (and in a bare handler set). */
  database?: StorageDatabaseMaintenance | null
}

/**
 * The Storage manager.
 *
 * This class is deliberately thin, because everything expensive about the
 * feature happens elsewhere: measuring the data root and removing a cleared
 * area both run on a worker thread ({@link StorageUsageWorker}), and compacting
 * the database runs on the database's own maintenance worker. What is left here
 * is the short-lived measurement cache, the compaction loop that only awaits
 * that worker, and the one shell call that reveals a folder.
 *
 * It is also never built at startup. The IPC layer imports this module on the
 * first request, so an installation that never opens the Storage manager pays
 * nothing for it at launch.
 */
export class StorageManagerService {
  private readonly worker = new StorageUsageWorker()
  private cached: StorageUsage | null = null
  private cachedAt = 0
  private pending: { root: string; promise: Promise<StorageUsage> } | null = null
  private vacuuming = false

  constructor(private readonly deps: StorageManagerDeps) {}

  /**
   * The current measurement.
   *
   * Concurrent opens share one request, and a fresh one is only paid when the
   * cache has aged out or the surface asked for it explicitly. A refresh the
   * user pressed always measures again, because it comes right after a clear.
   */
  async usage(force = false): Promise<StorageUsage> {
    const root = this.deps.configRoot()
    if (!force && this.cached && Date.now() - this.cachedAt < USAGE_CACHE_MS) return this.cached
    if (this.pending && this.pending.root === root) return this.pending.promise
    const promise = this.worker.run<StorageUsage>({ kind: 'usage', root })
    this.pending = { root, promise }
    try {
      const usage = await promise
      this.cached = usage
      this.cachedAt = Date.now()
      return usage
    } finally {
      if (this.pending?.promise === promise) this.pending = null
    }
  }

  /** Remove exactly one area the user confirmed, on the worker thread. */
  async clear(target: StorageClearTarget): Promise<StorageClearResult> {
    const root = this.deps.configRoot()
    const result = await this.worker.run<StorageClearResult>({ kind: 'clear', root, target })
    this.cached = null
    this.cachedAt = 0
    Logger.info('Storage area cleared', {
      target,
      freedBytes: result.freedBytes,
      removedFiles: result.removedFiles
    })
    return result
  }

  /** Show one area's folder, or the whole data root, in the OS file manager. */
  async reveal(area: StorageAreaId | 'root'): Promise<boolean> {
    const resolved = await this.worker.run<{ path: string | null }>({
      kind: 'reveal',
      root: this.deps.configRoot(),
      area
    })
    if (!resolved.path) return false
    const opened = await shell.openPath(resolved.path)
    if (!opened) return true
    // `openPath` reports a string failure rather than throwing, and a folder the
    // OS refuses to open is still worth showing where it lives.
    shell.showItemInFolder(resolved.path)
    return true
  }

  /**
   * Hand the database's free pages back to disk, a bounded step at a time.
   *
   * This is deliberately not a full `VACUUM`: that rewrites the whole file under
   * one exclusive lock and stalls every write queued behind it, which is what
   * froze the app once. Incremental steps hold the lock for milliseconds each
   * and stop when the free list is empty.
   */
  async vacuum(): Promise<StorageVacuumResult> {
    const database = this.deps.database
    if (!database) return { ok: false, freedBytes: 0, error: 'The database is not available' }
    if (this.vacuuming)
      return { ok: false, freedBytes: 0, error: 'A compaction is already running' }

    this.vacuuming = true
    try {
      const before = await database.sizeTelemetry()
      let ok = true
      let error: string | undefined
      for (let chunk = 0; chunk < VACUUM_MAX_CHUNKS; chunk += 1) {
        const result = await database.incrementalVacuum(VACUUM_PAGES_PER_CHUNK)
        if (!result.ok) {
          ok = false
          error = result.error ?? 'The database could not be compacted'
          break
        }
        if ((result.freedPages ?? 0) === 0) break
        await new Promise((settle) => setTimeout(settle, VACUUM_GAP_MS))
      }
      if (ok && database.truncateCheckpoint) {
        const checkpoint = await database.truncateCheckpoint()
        if (!checkpoint.ok && checkpoint.error) {
          Logger.dev('Storage manager checkpoint did not complete', checkpoint.error)
        }
      }
      const after = await database.sizeTelemetry()
      const wasBefore = before.ok ? before.dbBytes + before.walBytes + before.shmBytes : 0
      const isNow = after.ok ? after.dbBytes + after.walBytes + after.shmBytes : 0
      const freedBytes = Math.max(0, wasBefore - isNow)
      this.cached = null
      this.cachedAt = 0
      if (ok) Logger.info('Database compacted', { freedBytes })
      return { ok, freedBytes, ...(error ? { error } : {}) }
    } catch (caught: unknown) {
      const message =
        caught instanceof Error ? caught.message : 'The database could not be compacted'
      return { ok: false, freedBytes: 0, error: message }
    } finally {
      this.vacuuming = false
    }
  }

  /** Release the worker thread (app shutdown). */
  stop(): void {
    this.worker.stop()
  }
}
