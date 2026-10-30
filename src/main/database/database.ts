import { join } from 'path'
import { performance } from 'node:perf_hooks'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import type { AgentMessage, HistoryRole, UserMessageSummary } from '../../lib/types'
import type {
  DatabaseWorkerFactory,
  WorkerBackupResult,
  WorkerCheckpointResult,
  WorkerFtsResult,
  WorkerHealthResult,
  WorkerIntegrityResult,
  WorkerRecoverResult,
  WorkerRestoreResult,
  WorkerRetentionResult,
  WorkerSizeTelemetry,
  WorkerVacuumResult
} from './database-worker'
import {
  runProviderDeltaSync,
  type ProviderDeltaSyncResult
} from './repositories/agent-message-repo'
import { runHistoryAppend } from './repositories/history-repo'
import { applyDatabaseSchema, runLedgerMigrations, type LedgerMigrationHost } from './migrations'
import { DatabaseConnection } from './database/database-connection'
import { DatabaseMaintenance } from './database/database-maintenance'
import { DatabaseQueries } from './database/database-queries'
import { DatabaseWrites } from './database/database-writes'
import { AgentMessageSearchMirror } from './database/database-search-mirror'
import { reconcileLegacyContextUsageCosts } from './database/database-context-cost-repair'

export { MAIN_THREAD_DATABASE_WARNING_MS } from './database/database-slow-operations'

/**
 * CodeInOven's SQLite database: the composition root of the database layer.
 *
 * Every responsibility that used to live in this file now owns a module, and
 * this class only wires them together and exposes the surface the app calls:
 *
 * - `database/database-connection.ts`   the primary connection and its
 *   synchronous `run`/`get`/`all`/`prepare`/`transaction` API
 * - `database/database-maintenance.ts`   the off-main worker and every
 *   O(database-size) maintenance operation
 * - `database/database-queries.ts`   worker-backed reads and transcript export
 * - `database/database-writes.ts`   worker-backed serialized writes
 * - `database/database-search-mirror.ts`   the thread-search mirror backfill
 * - `database/database-context-cost-repair.ts`   the one-time ledger repair pass
 * - `migrations/`   the versioned chain (one file per schema version, with the
 *   worker-backed rebuilds that version owns), applied through
 *   `applyDatabaseSchema` and `runLedgerMigrations`
 * - `schema.ts`   the versioned DDL snapshot
 *
 * Callers keep the same import path and the same methods; nothing here decides
 * what a migration does or how a query runs.
 */
export class Database {
  private readonly connection: DatabaseConnection
  private readonly maintenance: DatabaseMaintenance
  private readonly queries: DatabaseQueries
  private readonly writes: DatabaseWrites
  private readonly searchMirror: AgentMessageSearchMirror
  private closing = false
  private contextCostRepair: Promise<void> | null = null

  constructor(path?: string, workerFactory?: DatabaseWorkerFactory) {
    // `join` rather than string concatenation: the config root is a platform
    // path, and a hard-coded `/` here printed `C:\Users\...\codeinoven/codeinoven.db`
    // in every log line and diagnostics export on Windows.
    const file = path ?? join(getConfigRoot(), 'codeinoven.db')
    this.connection = new DatabaseConnection(file)
    this.maintenance = new DatabaseMaintenance(file, workerFactory)
    this.queries = new DatabaseQueries({
      getWorker: () => this.maintenance.getWorker(),
      all: (sql, ...params) => this.connection.all(sql, ...params),
      syncProviderDeltas: (threadId, sessionId, messages) =>
        runProviderDeltaSync(this, threadId, sessionId, messages)
    })
    this.writes = new DatabaseWrites({
      getWorker: () => this.maintenance.getWorker(),
      run: (sql, ...params) => this.connection.run(sql, ...params),
      transaction: (fn) => this.connection.transaction(fn),
      appendHistory: (args) => runHistoryAppend(this, args)
    })
    this.searchMirror = new AgentMessageSearchMirror({
      isOpen: () => this.connection.isOpen(),
      getWorker: () => this.maintenance.getWorker(),
      readMeta: (key) => this.metaFlag(key),
      writeMeta: (key, value) => this.setMetaFlag(key, value)
    })
  }

  /** Initialise the database: open the connection, apply the schema, start the worker. */
  async init(): Promise<void> {
    if (this.connection.isOpen()) return
    this.closing = false
    const startedAt = performance.now()

    this.connection.open()
    const schemaUpgrade = applyDatabaseSchema(this.connection.raw())
    this.maintenance.start()
    // The ledger rebuilds below belong to the versions this boot applied, not to
    // steady state. A database that already carries the current schema version
    // applies no version and therefore skips them, so a boot never pays a
    // compatibility pass it cannot need.
    await runLedgerMigrations(
      schemaUpgrade.ledgerMigrations,
      this.ledgerMigrationHost(),
      this.connection.raw()
    )
    this.connection.raw().pragma('optimize = 0x10002')
    // Non-blocking: the mirror is brought up to date on the worker in small
    // serialized batches, so init never waits on it and the main thread stays
    // free. Until it reports ready, search uses the legacy (correct) query.
    void this.searchMirror.backfill()
    this.contextCostRepair = reconcileLegacyContextUsageCosts({
      isClosing: () => this.closing,
      queryViaWorker: (sql, params, maxRows) => this.queries.queryViaWorker(sql, params, maxRows),
      executeViaWorker: (sql, params) => this.writes.executeViaWorker(sql, params)
    })

    Logger.info('SQLite database initialised', {
      path: this.connection.filePath(),
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10
    })
  }

  /**
   * Close the database: gracefully shuts the maintenance worker down (typed
   * shutdown sent, clean exit awaited, bounded force only on timeout) and then
   * closes the primary connection. Awaitable so lifecycle code can be sure the
   * worker has stopped and its connection is closed before teardown completes.
   */
  async close(): Promise<void> {
    this.closing = true
    await this.contextCostRepair
    this.contextCostRepair = null
    await this.maintenance.stop()
    this.connection.close()
    Logger.info('SQLite database closed')
  }

  /**
   * Restore an atomic backup over the live database, coordinating every
   * connection on the restored inode:
   *
   * - The primary connection is closed before the swap and reopened afterwards.
   * - The maintenance worker is retained for the whole restore (its handle is
   *   never cleared early); the worker's `restore` op closes its own connection
   *   before the atomic swap, so no handle survives onto the pre-restore file.
   * - Failure kinds (`source_invalid` / `verify_failed` / `io`) are preserved
   *   on the returned result.
   */
  async restoreFromBackup(sourcePath: string): Promise<WorkerRestoreResult> {
    if (!this.maintenance.isRunning()) {
      return { ok: false, reason: 'io', error: 'no maintenance worker' }
    }
    // Drain the bounded repair before the worker swaps database files. Its
    // next queued statement must never race a restore onto a different inode.
    this.closing = true
    await this.contextCostRepair
    this.contextCostRepair = null
    // Close the primary connection so it cannot hold the pre-restore inode.
    this.connection.close()
    const result = await this.maintenance.restore(sourcePath)
    if (result.ok) {
      // Reopen the primary connection on the restored inode. If the reopen
      // fails, the restore must be reported as failed: a restored database
      // the app cannot open is not a successful restore.
      try {
        await this.init()
      } catch (error) {
        return {
          ok: false,
          reason: 'io',
          error: `restore completed but reopening the database failed: ${String(error)}`
        }
      }
    } else {
      // Reopen the unchanged inode best-effort so the app stays usable.
      await this.init().catch((error) => {
        Logger.error('Failed to reopen the database after a failed restore', error)
      })
    }
    return result
  }

  /** Whether the database connection is currently open. */
  isOpen(): boolean {
    return this.connection.isOpen()
  }

  /** Execute a write query (INSERT/UPDATE/DELETE) with optional params. */
  run(sql: string, ...params: unknown[]): void {
    this.connection.run(sql, ...params)
  }

  /** Fetch a single row as an object. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.connection.get<T>(sql, ...params)
  }

  /** Fetch all rows as an array of objects. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.connection.all<T>(sql, ...params)
  }

  /** Prepare a reusable statement. */
  prepare(sql: string): Statement {
    return this.connection.prepare(sql)
  }

  /** Execute a callback within a transaction. */
  transaction<T>(fn: () => T): T {
    return this.connection.transaction(fn)
  }

  /** Return the raw better-sqlite3 Database instance (for advanced usage). */
  raw(): DatabaseType {
    return this.connection.raw()
  }

  /** Check if a table exists in the schema. */
  tableExists(name: string): boolean {
    return this.connection.tableExists(name)
  }

  /** Whether thread search may rank against the narrow search mirror. */
  isSearchMetaReady(): boolean {
    return this.searchMirror.isReady()
  }

  // ── Maintenance boundary (off-main worker) ─────────────────────────────

  /** Whether a maintenance worker is running for this connection. */
  hasMaintenanceWorker(): boolean {
    return this.maintenance.isRunning()
  }

  /** Directory the worker uses for atomic backup artifacts. */
  backupDirectory(): string {
    return this.maintenance.backupDirectory()
  }

  /** Passive WAL checkpoint: returns an explicit result. */
  async passiveCheckpoint(): Promise<WorkerCheckpointResult> {
    return this.maintenance.passiveCheckpoint()
  }

  /** Full integrity strategy: quick_check by default, full `integrity_check` when asked. */
  async integrityCheck(quick = true): Promise<WorkerIntegrityResult> {
    return this.maintenance.integrityCheck(quick)
  }

  /** Current on-disk size telemetry (db/wal/shm bytes, pages, journal mode). */
  async sizeTelemetry(): Promise<WorkerSizeTelemetry> {
    return this.maintenance.sizeTelemetry()
  }

  /** Atomic online backup of the database to `targetPath` (tmp + rename). */
  async backupDatabase(targetPath: string): Promise<WorkerBackupResult> {
    return this.maintenance.backupDatabase(targetPath)
  }

  /** Atomic backup to the worker's default backups directory. */
  async backupDatabaseToDefaultDir(stamp = Date.now()): Promise<WorkerBackupResult> {
    return this.maintenance.backupDatabaseToDefaultDir(stamp)
  }

  /** Incremental vacuum to reclaim free pages (bounded, off-main). */
  async incrementalVacuum(pages = 128): Promise<WorkerVacuumResult> {
    return this.maintenance.incrementalVacuum(pages)
  }

  /** Full VACUUM (heavy; off-main). */
  async fullVacuum(): Promise<WorkerVacuumResult> {
    return this.maintenance.fullVacuum()
  }

  /** FTS ownership: merge index segments. */
  async optimizeFts(): Promise<WorkerFtsResult> {
    return this.maintenance.optimizeFts()
  }

  /** FTS ownership: rebuild all indexes from their source tables. */
  async rebuildFts(): Promise<WorkerFtsResult> {
    return this.maintenance.rebuildFts()
  }

  /** FTS ownership: integrity-check all indexes. */
  async ftsIntegrityCheck(): Promise<WorkerFtsResult> {
    return this.maintenance.ftsIntegrityCheck()
  }

  /** Bounded retention: permanently delete expired high-volume log rows. */
  async runRetention(): Promise<WorkerRetentionResult> {
    return this.maintenance.runRetention()
  }

  /** Rebuild a clean, verified copy of a corrupt database at `targetPath`. */
  async recoverTo(targetPath: string): Promise<WorkerRecoverResult> {
    return this.maintenance.recoverTo(targetPath)
  }

  /** Explicit corruption / full-disk health check. */
  async healthCheck(): Promise<WorkerHealthResult> {
    return this.maintenance.healthCheck()
  }

  // ── Serialized worker CRUD (bounded/paged reads, batched writes) ────────

  /** Bounded read executed on the worker's connection (see `DatabaseQueries`). */
  async queryViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number,
    options: { allowPrimaryFallback?: boolean; deadlineMs?: number } = {}
  ): Promise<{
    ok: boolean
    rows: Record<string, unknown>[]
    truncated: boolean
    error?: string
    timedOut?: boolean
  }> {
    return this.queries.queryViaWorker(sql, params, maxRows, options)
  }

  /** Bounded read decoded to `AgentMessage[]` on the worker's connection. */
  async queryMessagesViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number,
    includeTransport = false
  ): Promise<{ ok: boolean; messages: AgentMessage[]; truncated: boolean; error?: string }> {
    return this.queries.queryMessagesViaWorker(sql, params, maxRows, includeTransport)
  }

  /** Bounded read decoded to `UserMessageSummary[]` on the worker's connection. */
  async queryUserMessagesViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<{ ok: boolean; messages: UserMessageSummary[]; truncated: boolean; error?: string }> {
    return this.queries.queryUserMessagesViaWorker(sql, params, maxRows)
  }

  /** Single write statement on the worker's connection; primary fallback. */
  async executeViaWorker(
    sql: string,
    params: unknown[],
    options: { allowPrimaryFallback?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    return this.writes.executeViaWorker(sql, params, options)
  }

  /** Atomic batch: all statements run in one transaction on the worker's connection. */
  async transactionViaWorker(
    statements: Array<{ sql: string; params: unknown[] }>
  ): Promise<{ ok: boolean; error?: string }> {
    return this.writes.transactionViaWorker(statements)
  }

  /** Atomic history append, allocating the next sequence inside one transaction. */
  async appendHistoryViaWorker(
    id: string,
    threadId: string,
    role: HistoryRole,
    content: string,
    metadata: Record<string, unknown> | undefined,
    timestamp: number
  ): Promise<{ ok: boolean; sequence?: number; error?: string }> {
    return this.writes.appendHistoryViaWorker(id, threadId, role, content, metadata, timestamp)
  }

  /** Delta-only transcript sync, executed off the main thread. */
  async syncProviderDeltasViaWorker(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<ProviderDeltaSyncResult> {
    return this.queries.syncProviderDeltasViaWorker(threadId, sessionId, messages)
  }

  /** Serialize a thread's mirrored conversation into a Markdown transcript. */
  async exportTranscriptViaWorker(
    threadId: string,
    includeTrace: boolean,
    destinationPath: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    return this.queries.exportTranscriptViaWorker(threadId, includeTrace, destinationPath)
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** The worker-backed connection the ledger rebuilds run through. */
  private ledgerMigrationHost(): LedgerMigrationHost {
    return {
      execute: (sql, params) => this.writes.executeViaWorker(sql, params),
      transaction: (statements) => this.writes.transactionViaWorker(statements)
    }
  }

  /**
   * Read a `db_meta` value, or null when the key is absent (or the db is closed).
   *
   * On the worker's connection: the mirror backfill reads its cursor between
   * batches, and even a one-row read must not reach the primary connection from
   * the main thread while the user is working (see the main-thread SQLite rule
   * in `docs/APP-BIBLE.md`).
   */
  private async metaFlag(key: string): Promise<string | null> {
    if (!this.connection.isOpen()) return null
    const result = await this.queries.queryViaWorker(
      'SELECT value FROM db_meta WHERE key = ?',
      [key],
      1
    )
    const row = result.rows[0] as { value: string } | undefined
    return row?.value ?? null
  }

  /**
   * Write a `db_meta` value. The connection can close underneath the backfill
   * (its waits are on the worker), so a closed database turns this into a no-op
   * rather than an error on a normal quit.
   */
  private setMetaFlag(key: string, value: string): void {
    if (!this.connection.isOpen()) return
    this.run('INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)', key, value)
  }
}
