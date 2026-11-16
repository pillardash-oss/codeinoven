import { mkdir, rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Logger } from '../system/logger'
import type {
  StorageArea,
  StorageClearResult,
  StorageClearTarget,
  StorageUsage,
  StorageVacuumResult
} from '../../lib/types'
import { storageAreaSpecs, type StorageAreaSpec } from './storage-areas'
import { measurePaths, measureStorageRoot } from './storage-measure'

/** How long a measurement is reused before the next open walks the root again. */
const USAGE_CACHE_MS = 30_000

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
 * The Storage manager's service.
 *
 * It owns three things and nothing else: one measurement of the data root, the
 * four destructive clears the surface offers, and the database's bounded
 * compaction. Every path it deletes is decided here from {@link storageAreaSpecs},
 * so the IPC surface can name an area but never a folder.
 */
export class StorageManagerService {
  private cached: StorageUsage | null = null
  private cachedAt = 0
  private pending: { root: string; promise: Promise<StorageUsage> } | null = null
  private vacuuming = false

  constructor(private readonly deps: StorageManagerDeps) {}

  /**
   * The current measurement.
   *
   * Concurrent opens share one walk, and a fresh walk is only paid when the
   * cache has aged out or the surface asked for it explicitly. A refresh the
   * user pressed always measures again, because it comes right after a clear.
   */
  async usage(force = false): Promise<StorageUsage> {
    const root = resolve(this.deps.configRoot())
    if (!force && this.cached && this.cachedAt > 0 && Date.now() - this.cachedAt < USAGE_CACHE_MS) {
      return this.cached
    }
    if (this.pending && this.pending.root === root) return this.pending.promise
    const promise = this.measure(root)
    this.pending = { root, promise }
    try {
      return await promise
    } finally {
      if (this.pending?.promise === promise) this.pending = null
    }
  }

  private async measure(root: string): Promise<StorageUsage> {
    const specs = await storageAreaSpecs(root)
    const measurement = await measureStorageRoot(root, specs)
    const areas: StorageArea[] = specs.map((spec) => {
      const tally = measurement.areas.get(spec.id)
      return {
        id: spec.id,
        label: spec.label,
        detail: spec.detail,
        bytes: tally?.bytes ?? 0,
        files: tally?.files ?? 0,
        action: spec.action,
        actionLabel: spec.actionLabel
      }
    })
    const reclaimableBytes = areas.reduce(
      (total, area) => (area.action === 'delete' ? total + area.bytes : total),
      0
    )
    const usage: StorageUsage = {
      totalBytes: measurement.totalBytes,
      reclaimableBytes,
      areas,
      measuredAt: Date.now()
    }
    this.cached = usage
    this.cachedAt = Date.now()
    return usage
  }

  /**
   * Remove exactly one spam-free area the user confirmed.
   *
   * The folders are recreated empty right after removal, so a running speech or
   * logging writer finds the directory it expects instead of failing its next
   * write. What was handed back is measured before anything is removed, which
   * is the only moment the size is still readable.
   */
  async clear(target: StorageClearTarget): Promise<StorageClearResult> {
    const root = resolve(this.deps.configRoot())
    const specs = await storageAreaSpecs(root)
    const spec = specs.find((candidate) => candidate.id === target)
    if (!spec) throw new Error(`Unknown storage area: ${target}`)
    if (spec.action !== 'delete') throw new Error(`Storage area cannot be cleared: ${target}`)

    const paths = this.clearablePaths(root, spec)
    if (paths.length === 0) return { target, freedBytes: 0, removedFiles: 0 }

    const directories: string[] = []
    for (const path of paths) {
      try {
        const info = await stat(path)
        if (info.isDirectory()) directories.push(path)
      } catch {
        // Already gone: removal is a no-op and there is nothing to recreate.
      }
    }

    const before = await measurePaths(paths)
    for (const path of paths) {
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 2 })
      } catch (error: unknown) {
        Logger.error(`Clearing storage area ${target} could not remove ${path}:`, error)
      }
    }
    for (const directory of directories) {
      try {
        await mkdir(directory, { recursive: true })
      } catch (error: unknown) {
        Logger.error(`Clearing storage area ${target} could not recreate ${directory}:`, error)
      }
    }

    this.cached = null
    this.cachedAt = 0
    Logger.info('Storage area cleared', {
      target,
      freedBytes: before.bytes,
      removedFiles: before.files
    })
    return { target, freedBytes: before.bytes, removedFiles: before.files }
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
      const gained = before.ok && after.ok ? before.dbBytes + before.walBytes + before.shmBytes : 0
      const now = after.ok ? after.dbBytes + after.walBytes + after.shmBytes : 0
      const freedBytes = Math.max(0, gained - now)
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

  /**
   * The paths one clear may touch, filtered to what is provably inside the root.
   *
   * The list already comes from main's own area table, so this is the second
   * lock rather than the only one: no resolved path, and no path equal to the
   * data root itself, ever reaches `rm`.
   */
  private clearablePaths(root: string, spec: StorageAreaSpec): string[] {
    const accepted: string[] = []
    for (const path of spec.clearance) {
      const resolved = resolve(path)
      if (resolved === root) continue
      if (!resolved.startsWith(`${root}${sep}`)) continue
      if (accepted.includes(resolved)) continue
      accepted.push(resolved)
    }
    return accepted
  }
}
