import { dirname, join } from 'path'
import { Logger } from '../../system/logger'
import {
  DatabaseWorker,
  DATABASE_WORKER_DEFAULTS,
  type DatabaseWorkerFactory,
  type WorkerBackupResult,
  type WorkerCheckpointResult,
  type WorkerFtsResult,
  type WorkerHealthResult,
  type WorkerIntegrityResult,
  type WorkerRecoverResult,
  type WorkerRestoreResult,
  type WorkerRetentionResult,
  type WorkerSizeTelemetry,
  type WorkerVacuumResult
} from '../database-worker'

/**
 * The maintenance worker boundary: a second WAL connection owned by a worker
 * thread, which owns every O(database-size) operation (checkpoint, integrity,
 * telemetry, backup, retention, FTS) plus the ledger rebuilds.
 *
 * Keeping the operation out of the main process is the whole point, so this
 * class only forwards and types the results: no statement here ever runs on the
 * main thread. An in-memory test database cannot share a file with a second
 * connection, so it runs without a worker and every operation answers its own
 * typed "no maintenance worker" result.
 */
export class DatabaseMaintenance {
  private worker: DatabaseWorker | null = null
  private readonly path: string
  private readonly workerFactory: DatabaseWorkerFactory | undefined

  constructor(path: string, workerFactory?: DatabaseWorkerFactory) {
    this.path = path
    this.workerFactory = workerFactory
  }

  /** Start the worker once, unless this database cannot have one. */
  start(): void {
    if (this.path === ':memory:' || this.worker) return
    const worker = new DatabaseWorker(
      {
        dbPath: this.path,
        backupDir: join(dirname(this.path), 'backups'),
        maintenanceEnabled: true,
        ...DATABASE_WORKER_DEFAULTS
      },
      Logger,
      this.workerFactory
    )
    this.worker = worker
    worker.start()
  }

  /**
   * The live worker, for the callers that issue their own serialized requests
   * (the search mirror backfill, the transcript export). `null` when this
   * database runs without one.
   */
  getWorker(): DatabaseWorker | null {
    return this.worker
  }

  /** Whether a maintenance worker is running for this connection. */
  isRunning(): boolean {
    return this.worker?.isRunning() ?? false
  }

  /** Directory the worker uses for atomic backup artifacts. */
  backupDirectory(): string {
    return join(dirname(this.path), 'backups')
  }

  /**
   * Stop the worker gracefully: hand the write-ahead log back, then send the
   * typed shutdown and await the clean exit.
   *
   * The handle is cleared before the wait, so nothing can queue a request onto a
   * worker this call is closing. The checkpoint is best effort by design: one
   * that cannot finish must never hold teardown open. A truncating checkpoint
   * here is the last thing that writes to the database, costs nothing when the
   * log is already small, and saves the next launch from replaying an inherited
   * log against a database it has not opened yet.
   */
  async stop(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker?.isRunning()) return
    const checkpoint = await worker.truncateCheckpoint()
    if (!checkpoint.ok) {
      Logger.dev('WAL checkpoint at shutdown did not complete', checkpoint.error ?? '')
    }
    await worker.shutdown()
  }

  /** Passive WAL checkpoint: returns an explicit result. */
  async passiveCheckpoint(): Promise<WorkerCheckpointResult> {
    return this.worker?.passiveCheckpoint() ?? { ok: false, error: 'no maintenance worker' }
  }

  /** Full integrity strategy: quick_check by default, full `integrity_check` when asked. */
  async integrityCheck(quick = true): Promise<WorkerIntegrityResult> {
    return (
      this.worker?.integrityCheck(quick) ?? {
        ok: false,
        text: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** Current on-disk size telemetry (db/wal/shm bytes, pages, journal mode). */
  async sizeTelemetry(): Promise<WorkerSizeTelemetry> {
    return (
      this.worker?.sizeTelemetry() ?? {
        ok: false,
        dbBytes: 0,
        walBytes: 0,
        shmBytes: 0,
        pageSize: 0,
        pageCount: 0,
        freelistPages: 0,
        journalMode: '',
        schemaVersion: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** Atomic online backup of the database to `targetPath` (tmp + rename). */
  async backupDatabase(targetPath: string): Promise<WorkerBackupResult> {
    return this.worker?.backup(targetPath) ?? { ok: false, error: 'no maintenance worker' }
  }

  /** Atomic backup to the worker's default backups directory. */
  async backupDatabaseToDefaultDir(stamp = Date.now()): Promise<WorkerBackupResult> {
    return this.backupDatabase(join(this.backupDirectory(), `codeinoven-${stamp}.db`))
  }

  /**
   * Restore an atomic backup over the live database on the worker's connection.
   *
   * The worker closes its own connection before the atomic swap, so no handle
   * survives onto the pre-restore file. Coordinating the primary connection and
   * reopening the database afterwards stays with the caller, which owns the
   * lifecycle. Failure kinds (`source_invalid` / `verify_failed` / `io`) are
   * preserved on the returned result.
   */
  async restore(sourcePath: string): Promise<WorkerRestoreResult> {
    const worker = this.worker
    if (!worker || !worker.isRunning()) {
      return { ok: false, reason: 'io', error: 'no maintenance worker' }
    }
    try {
      const raw = await worker.restore(sourcePath)
      // Preserve the expected result kinds even when the worker failed: only
      // inject the io reason when the worker did not return a proper restore
      // result (or returned one without a reason).
      if (raw.kind !== 'restore') {
        return { ok: false, reason: 'io', error: raw.error ?? 'restore failed' }
      }
      if (!raw.ok && !raw.reason) return { ...raw, reason: 'io' }
      return raw
    } catch (error) {
      return { ok: false, reason: 'io', error: String(error) }
    }
  }

  /** Incremental vacuum to reclaim free pages (bounded, off-main). */
  async incrementalVacuum(pages = 128): Promise<WorkerVacuumResult> {
    return this.worker?.incrementalVacuum(pages) ?? { ok: false, error: 'no maintenance worker' }
  }

  /** Full VACUUM (heavy; off-main). */
  async fullVacuum(): Promise<WorkerVacuumResult> {
    return this.worker?.fullVacuum() ?? { ok: false, error: 'no maintenance worker' }
  }

  /** FTS ownership: merge index segments. */
  async optimizeFts(): Promise<WorkerFtsResult> {
    return (
      this.worker?.optimizeFts() ?? {
        ok: false,
        action: 'optimize',
        details: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** FTS ownership: rebuild all indexes from their source tables. */
  async rebuildFts(): Promise<WorkerFtsResult> {
    return (
      this.worker?.rebuildFts() ?? {
        ok: false,
        action: 'rebuild',
        details: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** FTS ownership: integrity-check all indexes. */
  async ftsIntegrityCheck(): Promise<WorkerFtsResult> {
    return (
      this.worker?.ftsIntegrityCheck() ?? {
        ok: false,
        action: 'integrity-check',
        details: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** Bounded retention: permanently delete expired high-volume log rows. */
  async runRetention(): Promise<WorkerRetentionResult> {
    return this.worker?.runRetention() ?? { ok: false, deleted: 0, error: 'no maintenance worker' }
  }

  /** Rebuild a clean, verified copy of a corrupt database at `targetPath`. */
  async recoverTo(targetPath: string): Promise<WorkerRecoverResult> {
    return (
      this.worker?.recoverTo(targetPath) ?? {
        ok: false,
        reason: 'unrecoverable',
        error: 'no maintenance worker'
      }
    )
  }

  /** Explicit corruption / full-disk health check. */
  async healthCheck(): Promise<WorkerHealthResult> {
    return (
      this.worker?.healthCheck() ?? {
        ok: false,
        status: 'error',
        quickCheck: '',
        details: {
          ok: false,
          dbBytes: 0,
          walBytes: 0,
          shmBytes: 0,
          pageSize: 0,
          pageCount: 0,
          freelistPages: 0,
          journalMode: '',
          schemaVersion: '',
          error: 'no maintenance worker'
        },
        message: 'no maintenance worker'
      }
    )
  }
}
