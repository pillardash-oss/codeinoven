import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { performance } from 'node:perf_hooks'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import {
  AGENT_MESSAGES_THINKING_LEVEL_MIGRATION_SQL,
  AGENT_MESSAGES_TOKENS_TOTAL_MIGRATION_SQL,
  DATABASE_SCHEMA_SQL,
  HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL,
  HARNESS_USAGE_MODELS_COLUMNS_SQL,
  HARNESS_USAGE_MODELS_EXPECTED_COLUMNS,
  HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL,
  HARNESS_USAGE_THINKING_LEVEL_MIGRATION_SQL,
  TURN_FEEDBACK_COLUMNS_SQL,
  TURN_FEEDBACK_COST_MIGRATION_SQL,
  TURN_FEEDBACK_EXPECTED_COLUMNS,
  TURN_FEEDBACK_SET_NULL_MIGRATION_SQL,
  USAGE_EVENTS_THINKING_LEVEL_MIGRATION_SQL
} from './schema'
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
} from './database-worker'
import {
  runProviderDeltaSync,
  type ProviderDeltaSyncResult
} from './repositories/agent-message-repo'
import { runHistoryAppend } from './repositories/history-repo'
import type { AgentMessage } from '../../lib/types'

/** Main-thread SQLite work above one 60 Hz frame is diagnostic-worthy. */
export const MAIN_THREAD_DATABASE_WARNING_MS = 16.7

/**
 * Database — synchronous SQLite wrapper for the Electron main process.
 *
 * - WAL journal mode for concurrent reads
 * - busy_timeout to prevent SQLITE_BUSY
 * - Lazy-init: call init() once at startup
 * - Query helpers: run(), get(), all()
 */
export class Database {
  private db: DatabaseType | null = null
  private readonly path: string
  private maintenanceWorker: DatabaseWorker | null = null
  private readonly workerFactory: DatabaseWorkerFactory | undefined

  constructor(path?: string, workerFactory?: DatabaseWorkerFactory) {
    this.path = path ?? getConfigRoot() + '/codeinoven.db'
    this.workerFactory = workerFactory
  }

  /** Initialise the database: open connection, apply schema, set WAL mode. */
  async init(): Promise<void> {
    if (this.db) return
    const startedAt = performance.now()

    // On a fresh install the config root does not exist yet and
    // `storage.initialize()` runs concurrently with this call, so create the
    // parent directory first — otherwise SQLite aborts with
    // "cannot open database because the directory does not exist".
    mkdirSync(dirname(this.path), { recursive: true })

    this.db = new DatabaseConstructor(this.path)

    this.configureConnection()
    this.applySchema()
    this.db.pragma('optimize = 0x10002')

    this.startMaintenanceWorker()
    this.backfillAgentMessageTokensTotal()

    Logger.info('SQLite database initialised', {
      path: this.path,
      durationMs: this.roundDuration(performance.now() - startedAt)
    })
  }

  /**
   * The maintenance worker opens a second WAL connection and owns every
   * O(database-size) operation (checkpoint, integrity, telemetry, backup,
   * retention, FTS). In-memory test databases cannot share a file with a
   * second connection, so they run without a worker.
   */
  private startMaintenanceWorker(): void {
    if (this.path === ':memory:' || this.maintenanceWorker) return
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
    this.maintenanceWorker = worker
    worker.start()
  }

  /** Whether the database connection is currently open. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Close the primary connection only; the maintenance worker is retained. */
  private closeConnection(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
  }

  /**
   * Close the database: gracefully shuts the maintenance worker down (typed
   * shutdown sent, clean exit awaited, bounded force only on timeout) and then
   * closes the primary connection. Awaitable so lifecycle code can be sure the
   * worker has stopped and its connection is closed before teardown completes.
   */
  async close(): Promise<void> {
    const worker = this.maintenanceWorker
    this.maintenanceWorker = null
    if (worker?.isRunning()) {
      await worker.shutdown()
    }
    this.closeConnection()
    Logger.info('SQLite database closed')
  }

  /** Execute a write query (INSERT/UPDATE/DELETE) with optional params. */
  run(sql: string, ...params: unknown[]): void {
    const startedAt = performance.now()
    try {
      this.requireDb()
        .prepare(sql)
        .run(...params)
    } catch (error) {
      Logger.error('Database.run failed', { sql, error: String(error) })
      throw error
    } finally {
      this.reportSlowMainThreadOperation('run', startedAt, sql)
    }
  }

  /** Fetch a single row as an object. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    const startedAt = performance.now()
    try {
      return this.requireDb()
        .prepare(sql)
        .get(...params) as T | undefined
    } catch (error) {
      Logger.error('Database.get failed', { sql, error: String(error) })
      throw error
    } finally {
      this.reportSlowMainThreadOperation('get', startedAt, sql)
    }
  }

  /** Fetch all rows as an array of objects. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const startedAt = performance.now()
    try {
      return this.requireDb()
        .prepare(sql)
        .all(...params) as T[]
    } catch (error) {
      Logger.error('Database.all failed', { sql, error: String(error) })
      throw error
    } finally {
      this.reportSlowMainThreadOperation('all', startedAt, sql)
    }
  }

  /** Prepare a reusable statement. */
  prepare(sql: string): Statement {
    try {
      return this.requireDb().prepare(sql)
    } catch (error) {
      Logger.error('Database.prepare failed', { sql, error: String(error) })
      throw error
    }
  }

  /** Execute a callback within a transaction. */
  transaction<T>(fn: () => T): T {
    const startedAt = performance.now()
    try {
      return this.requireDb().transaction(fn)()
    } catch (error) {
      Logger.error('Database.transaction failed', { error: String(error) })
      throw error
    } finally {
      this.reportSlowMainThreadOperation('transaction', startedAt)
    }
  }

  private roundDuration(durationMs: number): number {
    return Math.round(durationMs * 10) / 10
  }

  /**
   * Log only operation class, duration, and the statement text (params and
   * user data are never logged). The SQL is attributed verbatim so a slow op
   * can be traced to its caller; very long statements are bounded.
   */
  private reportSlowMainThreadOperation(operation: string, startedAt: number, sql?: string): void {
    const durationMs = performance.now() - startedAt
    if (durationMs < MAIN_THREAD_DATABASE_WARNING_MS) return
    Logger.info('Slow synchronous SQLite operation on Electron main', {
      operation,
      durationMs: this.roundDuration(durationMs),
      sql: sql ? truncateSqlForLog(sql) : undefined
    })
  }

  /** Return the raw better-sqlite3 Database instance (for advanced usage). */
  raw(): DatabaseType {
    return this.requireDb()
  }

  /** Check if a table exists in the schema. */
  tableExists(name: string): boolean {
    const row = this.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?",
      name
    )
    return (row?.cnt ?? 0) > 0
  }

  // ── Maintenance boundary (off-main worker) ─────────────────────────────

  /** Whether a maintenance worker is running for this connection. */
  hasMaintenanceWorker(): boolean {
    return this.maintenanceWorker?.isRunning() ?? false
  }

  /** Directory the worker uses for atomic backup artifacts. */
  backupDirectory(): string {
    return join(dirname(this.path), 'backups')
  }

  /** Passive WAL checkpoint — returns an explicit result. */
  async passiveCheckpoint(): Promise<WorkerCheckpointResult> {
    return (
      this.maintenanceWorker?.passiveCheckpoint() ?? { ok: false, error: 'no maintenance worker' }
    )
  }

  /** Full integrity strategy: quick_check by default, full `integrity_check` when asked. */
  async integrityCheck(quick = true): Promise<WorkerIntegrityResult> {
    return (
      this.maintenanceWorker?.integrityCheck(quick) ?? {
        ok: false,
        text: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** Current on-disk size telemetry (db/wal/shm bytes, pages, journal mode). */
  async sizeTelemetry(): Promise<WorkerSizeTelemetry> {
    return (
      this.maintenanceWorker?.sizeTelemetry() ?? {
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
    return (
      this.maintenanceWorker?.backup(targetPath) ?? { ok: false, error: 'no maintenance worker' }
    )
  }

  /** Atomic backup to the worker's default backups directory. */
  async backupDatabaseToDefaultDir(stamp = Date.now()): Promise<WorkerBackupResult> {
    return this.backupDatabase(join(this.backupDirectory(), `codeinoven-${stamp}.db`))
  }

  /**
   * Restore an atomic backup over the live database, coordinating every
   * connection on the restored inode:
   *
   * - The primary connection is closed before the swap and reopened afterwards.
   * - The maintenance worker is retained for the whole restore (its handle is
   *   never cleared early); the worker's `restore` op closes its own connection
   *   before the atomic swap, so no handle survives onto the pre-restore file.
   * - Typed `shutdown` (when used) is sent and awaited before the handle is
   *   cleared — see `DatabaseWorker.shutdown`.
   * - Failure kinds (`source_invalid` / `verify_failed` / `io`) are preserved
   *   on the returned result.
   */
  async restoreFromBackup(sourcePath: string): Promise<WorkerRestoreResult> {
    const worker = this.maintenanceWorker
    if (!worker || !worker.isRunning()) {
      return { ok: false, reason: 'io', error: 'no maintenance worker' }
    }
    // Close the primary connection so it cannot hold the pre-restore inode.
    this.closeConnection()
    let result: WorkerRestoreResult
    try {
      const raw = await worker.restore(sourcePath)
      // Preserve the expected result kinds even when the worker failed: only
      // inject the io reason when the worker did not return a proper restore
      // result (or returned one without a reason).
      if (raw.kind !== 'restore') {
        result = { ok: false, reason: 'io', error: raw.error ?? 'restore failed' }
      } else if (!raw.ok && !raw.reason) {
        result = { ...raw, reason: 'io' }
      } else {
        result = raw
      }
    } catch (error) {
      result = { ok: false, reason: 'io', error: String(error) }
    }
    if (result.ok) {
      // Reopen the primary connection on the restored inode. If the reopen
      // fails, the restore must be reported as failed — a restored database
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

  /**
   * Delta-only transcript sync executed on the maintenance worker's connection
   * so the reconciliation never blocks the main process. Falls back to the
   * primary connection when no worker is available (e.g. in-memory test
   * databases) or when the worker fails.
   */
  async syncProviderDeltasViaWorker(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): Promise<ProviderDeltaSyncResult> {
    const worker = this.maintenanceWorker
    if (worker?.isRunning()) {
      const response = await worker.syncProviderDeltas(threadId, sessionId, messages)
      if (response.ok && response.result) {
        return response.result
      }
      if (response.error) {
        Logger.error(
          'Database worker delta sync failed; falling back to primary connection',
          response.error
        )
      }
    }
    return runProviderDeltaSync(this, threadId, sessionId, messages)
  }

  // ── Serialized worker CRUD (bounded/paged reads, batched writes) ────────

  /**
   * Bounded read executed on the worker's connection (serialized with every
   * other worker request and the maintenance loop). `sql` must not contain
   * LIMIT; `maxRows` (>0) bounds the response. Falls back to the primary
   * connection when no worker is available or the worker fails.
   */
  async queryViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<{ ok: boolean; rows: Record<string, unknown>[]; truncated: boolean; error?: string }> {
    const worker = this.maintenanceWorker
    if (worker?.isRunning()) {
      const response = await worker.query(sql, params, maxRows)
      if (response.ok) {
        return { ok: true, rows: response.rows ?? [], truncated: response.truncated ?? false }
      }
      if (response.error) {
        Logger.error(
          'Database worker query failed; falling back to primary connection',
          response.error
        )
      }
    }
    return runLocalBoundedQuery(this, sql, params, maxRows)
  }

  /** Single write statement on the worker's connection; primary fallback. */
  async executeViaWorker(sql: string, params: unknown[]): Promise<{ ok: boolean; error?: string }> {
    const worker = this.maintenanceWorker
    if (worker?.isRunning()) {
      const response = await worker.execute(sql, params)
      if (response.ok) return { ok: true }
      if (response.error) {
        Logger.error(
          'Database worker execute failed; falling back to primary connection',
          response.error
        )
      }
    }
    try {
      this.run(sql, ...params)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  /**
   * Atomic batch: all statements run in one transaction on the worker's
   * connection (serialized). Primary-connection fallback keeps the same
   * batching guarantee.
   */
  async transactionViaWorker(
    statements: Array<{ sql: string; params: unknown[] }>
  ): Promise<{ ok: boolean; error?: string }> {
    const worker = this.maintenanceWorker
    if (worker?.isRunning()) {
      const response = await worker.transaction(statements)
      if (response.ok) return { ok: true }
      if (response.error) {
        Logger.error(
          'Database worker transaction failed; falling back to primary connection',
          response.error
        )
      }
    }
    try {
      this.transaction(() => {
        for (const statement of statements) {
          this.run(statement.sql, ...(statement.params ?? []))
        }
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  /**
   * Atomic history append: allocates the next sequence and inserts the row in
   * one serialized worker transaction, so concurrent appends can never
   * allocate the same sequence. Falls back to an equivalent atomic transaction
   * on the primary connection when no worker is available.
   */
  async appendHistoryViaWorker(
    id: string,
    threadId: string,
    role: import('../../lib/types').HistoryRole,
    content: string,
    metadata: Record<string, unknown> | undefined,
    timestamp: number
  ): Promise<{ ok: boolean; sequence?: number; error?: string }> {
    const worker = this.maintenanceWorker
    if (worker?.isRunning()) {
      const response = await worker.appendHistory(id, threadId, role, content, metadata, timestamp)
      if (response.ok) return { ok: true, sequence: response.sequence }
      if (response.error) {
        Logger.error(
          'Database worker history append failed; falling back to primary connection',
          response.error
        )
      }
    }
    try {
      const { sequence } = runHistoryAppend(this, {
        id,
        threadId,
        role,
        content,
        metadata,
        timestamp
      })
      return { ok: true, sequence }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  }

  /** Incremental vacuum to reclaim free pages (bounded, off-main). */
  async incrementalVacuum(pages = 128): Promise<WorkerVacuumResult> {
    return (
      this.maintenanceWorker?.incrementalVacuum(pages) ?? {
        ok: false,
        error: 'no maintenance worker'
      }
    )
  }

  /** Full VACUUM (heavy; off-main). */
  async fullVacuum(): Promise<WorkerVacuumResult> {
    return this.maintenanceWorker?.fullVacuum() ?? { ok: false, error: 'no maintenance worker' }
  }

  /** FTS ownership: merge index segments. */
  async optimizeFts(): Promise<WorkerFtsResult> {
    return (
      this.maintenanceWorker?.optimizeFts() ?? {
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
      this.maintenanceWorker?.rebuildFts() ?? {
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
      this.maintenanceWorker?.ftsIntegrityCheck() ?? {
        ok: false,
        action: 'integrity-check',
        details: '',
        error: 'no maintenance worker'
      }
    )
  }

  /** Bounded retention: permanently delete expired high-volume log rows. */
  async runRetention(): Promise<WorkerRetentionResult> {
    return (
      this.maintenanceWorker?.runRetention() ?? {
        ok: false,
        deleted: 0,
        error: 'no maintenance worker'
      }
    )
  }

  /** Rebuild a clean, verified copy of a corrupt database at `targetPath`. */
  async recoverTo(targetPath: string): Promise<WorkerRecoverResult> {
    return (
      this.maintenanceWorker?.recoverTo(targetPath) ?? {
        ok: false,
        reason: 'unrecoverable',
        error: 'no maintenance worker'
      }
    )
  }

  /** Explicit corruption / full-disk health check. */
  async healthCheck(): Promise<WorkerHealthResult> {
    return (
      this.maintenanceWorker?.healthCheck() ?? {
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

  // ── Private helpers ────────────────────────────────────────────────────

  private requireDb(): DatabaseType {
    if (!this.db) {
      throw new Error('Database not initialised. Call init() first.')
    }
    return this.db
  }

  /** Configure each primary connection for bounded latency and WAL concurrency. */
  private configureConnection(): void {
    const connection = this.requireDb()
    connection.pragma('journal_mode = WAL')
    connection.pragma('synchronous = NORMAL')
    connection.pragma('foreign_keys = ON')
    connection.pragma('busy_timeout = 5000')
    connection.pragma('temp_store = MEMORY')
    connection.pragma('cache_size = -32768')
    connection.pragma('mmap_size = 268435456')
    connection.pragma('wal_autocheckpoint = 1000')
    connection.pragma('journal_size_limit = 67108864')
  }

  private applySchema(): void {
    const connection = this.requireDb()
    connection.transaction(() => connection.exec(DATABASE_SCHEMA_SQL))()
    this.applyTokensTotalMigration(connection)
    // Rebuild migrations must be atomic: each drops the old table before
    // renaming the populated staging table. Outside a transaction a crash in
    // that window would leave the canonical table missing (or empty) while the
    // staged data survives; SQLite rolls an interrupted transaction back on
    // the next open, so the source table is always intact on retry.
    connection.transaction(() => this.applyThinkingLevelMigrations(connection))()
  }

  /**
   * Guarded column additions and table rebuilds for databases created before
   * usage records captured the model's thinking level. Each is a no-op on
   * fresh installs, which already carry the columns from the CREATE TABLE.
   */
  private applyThinkingLevelMigrations(connection: DatabaseType): void {
    // First recover any database that crashed mid-rebuild before the rebuild
    // migrations ran inside a transaction: adopt a populated staging table
    // when the canonical table was recreated empty.
    this.adoptInterruptedRebuild(
      connection,
      'harness_usage_models',
      'harness_usage_models_v2',
      HARNESS_USAGE_MODELS_EXPECTED_COLUMNS,
      HARNESS_USAGE_MODELS_COLUMNS_SQL,
      [
        'CREATE INDEX IF NOT EXISTS idx_harness_usage_models_thread ON harness_usage_models(thread_id)',
        'CREATE INDEX IF NOT EXISTS idx_harness_usage_models_harness ON harness_usage_models(harness_id)'
      ]
    )
    this.adoptInterruptedRebuild(
      connection,
      'turn_feedback',
      'turn_feedback_v2',
      TURN_FEEDBACK_EXPECTED_COLUMNS,
      TURN_FEEDBACK_COLUMNS_SQL,
      [
        'CREATE INDEX IF NOT EXISTS idx_turn_feedback_thread ON turn_feedback(thread_id, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_turn_feedback_pending ON turn_feedback(status, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_turn_feedback_attribution ON turn_feedback(harness_id, provider_id, model_id, thinking_level, feature)'
      ]
    )

    const columns = (table: string): Array<{ name: string; notnull?: number }> =>
      connection.pragma(`table_info(${table})`) as Array<{ name: string; notnull?: number }>

    if (!columns('agent_messages').some((column) => column.name === 'thinking_level')) {
      connection.exec(AGENT_MESSAGES_THINKING_LEVEL_MIGRATION_SQL)
      Logger.info('Migrated agent_messages: added thinking_level column')
    }
    if (!columns('usage_events').some((column) => column.name === 'thinking_level')) {
      connection.exec(USAGE_EVENTS_THINKING_LEVEL_MIGRATION_SQL)
      Logger.info('Migrated usage_events: added thinking_level column')
    }
    if (!columns('harness_usage').some((column) => column.name === 'thinking_level')) {
      connection.exec(HARNESS_USAGE_THINKING_LEVEL_MIGRATION_SQL)
      Logger.info('Migrated harness_usage: added thinking_level column')
    }
    const modelLevel = columns('harness_usage_models').find(
      (column) => column.name === 'thinking_level'
    )
    // Rebuild when the column is missing entirely OR is still nullable: SQLite
    // treats NULLs as distinct inside a composite PRIMARY KEY, so a nullable
    // level would let one model's usage fragment into a row per message. The
    // missing-column variant must not reference the column (it does not exist);
    // the nullable variant normalizes NULLs to '' and merges duplicates.
    if (!modelLevel) {
      connection.exec(HARNESS_USAGE_MODELS_ADD_THINKING_LEVEL_MIGRATION_SQL)
      Logger.info('Migrated harness_usage_models: added NOT NULL thinking_level to key')
    } else if (modelLevel.notnull === 0) {
      connection.exec(HARNESS_USAGE_MODELS_NORMALIZE_THINKING_LEVEL_MIGRATION_SQL)
      Logger.info('Migrated harness_usage_models: normalized nullable thinking_level in key')
    }
    // Rebuild turn_feedback when its thread reference still cascade-deletes:
    // resolved outcomes (including cleanup passes) must survive thread deletion
    // to feed the model-performance analytics.
    const fks = connection.pragma('foreign_key_list(turn_feedback)') as Array<{
      table: string
      on_delete: string
    }>
    if (fks.some((fk) => fk.table === 'threads' && fk.on_delete === 'CASCADE')) {
      connection.exec(TURN_FEEDBACK_SET_NULL_MIGRATION_SQL)
      Logger.info('Migrated turn_feedback: thread reference now SET NULL on delete')
    }
    // Databases created before turn outcomes recorded their cost get the
    // columns via guarded ALTER TABLE; fresh installs already carry them.
    if (!columns('turn_feedback').some((column) => column.name === 'cost_usd')) {
      connection.exec(TURN_FEEDBACK_COST_MIGRATION_SQL)
      Logger.info('Migrated turn_feedback: added cost accounting columns')
    }
  }

  /**
   * Recovery for databases that crashed in the pre-transaction migration window
   * (a crash between dropping the old table and renaming the populated staging
   * table). On the next startup the canonical table was recreated empty while
   * the staged data survived, so the migration guard no longer fires. When the
   * staging table holds rows and the canonical table is empty, the staged data
   * is adopted — but only after its schema is validated against the columns the
   * app relies on, and the data is copied into a canonical-shaped table so
   * constraints (primary key, nullability, foreign keys, checks) are restored
   * even when the staging table came from a bare copy that stripped them.
   */
  private adoptInterruptedRebuild(
    connection: DatabaseType,
    canonical: string,
    staging: string,
    expectedColumns: readonly string[],
    columnsSql: string,
    indexStatements: string[]
  ): void {
    const stagingExists = connection
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(staging)
    if (!stagingExists) return
    const stagingRows = (
      connection.prepare(`SELECT COUNT(*) AS count FROM ${staging}`).get() as {
        count: number
      }
    ).count
    if (stagingRows <= 0) return
    const canonicalRows = (
      connection.prepare(`SELECT COUNT(*) AS count FROM ${canonical}`).get() as {
        count: number
      }
    ).count
    if (canonicalRows > 0) return

    // Never adopt a staging table that lacks columns the rest of the app
    // reads. A mismatched table is disposable; installing it would break every
    // subsequent read of the canonical table.
    const stagingColumns = connection.pragma(`table_info(${staging})`) as Array<{
      name: string
    }>
    const stagingNames = new Set(stagingColumns.map((column) => column.name))
    if (!expectedColumns.every((column) => stagingNames.has(column))) {
      Logger.info(`Skipped adopting ${staging}: schema does not match ${canonical}`)
      return
    }

    connection.exec(`DROP TABLE ${canonical}`)
    connection.exec(`CREATE TABLE ${canonical} (${columnsSql})`)
    connection.exec(
      `INSERT INTO ${canonical} (${expectedColumns.join(', ')})
       SELECT ${expectedColumns.join(', ')} FROM ${staging}`
    )
    connection.exec(`DROP TABLE ${staging}`)
    for (const index of indexStatements) connection.exec(index)
    Logger.info(
      `Migrated ${canonical}: adopted and normalized staging data after interrupted rebuild`
    )
  }

  /**
   * Databases created before `tokens_total` existed get the column via a
   * guarded ALTER TABLE (SQLite cannot ADD a STORED generated column). Fresh
   * installs already carry the column from the CREATE TABLE.
   */
  private applyTokensTotalMigration(connection: DatabaseType): void {
    const columns = connection.pragma('table_info(agent_messages)') as Array<{ name: string }>
    if (columns.some((column) => column.name === 'tokens_total')) return
    connection.exec(AGENT_MESSAGES_TOKENS_TOTAL_MIGRATION_SQL)
    Logger.info('Migrated agent_messages: added tokens_total column')
  }

  /**
   * Non-blocking backfill of `tokens_total` from `tokens_json`, run on the
   * maintenance worker connection so a large table never blocks the main
   * thread or startup. Small rowid-chunked UPDATEs keep each write lock brief
   * so concurrent message ingestion is not starved. Idempotent and resumable:
   * a completed run records a `db_meta` marker, and rows written afterwards
   * already carry `tokens_total` from the encoder.
   */
  private async backfillAgentMessageTokensTotal(): Promise<void> {
    if (this.path === ':memory:' || this.db === null) return
    try {
      const marked = await this.queryViaWorker(
        "SELECT 1 AS done FROM db_meta WHERE key = 'tokens_total_backfilled'",
        [],
        1
      )
      if ((marked.rows.length ?? 0) > 0) return
      const bounds = await this.queryViaWorker(
        `SELECT COALESCE(MIN(rowid), 0) AS min_id, COALESCE(MAX(rowid), 0) AS max_id
         FROM agent_messages
         WHERE tokens_total IS NULL AND tokens_json IS NOT NULL`,
        [],
        100
      )
      const minRow = bounds.rows[0] as { min_id?: number; max_id?: number } | undefined
      const minId = minRow?.min_id ?? 0
      const maxId = minRow?.max_id ?? 0
      if (minId === 0 && maxId === 0) {
        await this.executeViaWorker(
          "INSERT OR IGNORE INTO db_meta(key, value) VALUES('tokens_total_backfilled', '1')",
          []
        )
        return
      }
      const CHUNK_SIZE = 2000
      for (let start = minId; start <= maxId; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, maxId)
        const result = await this.executeViaWorker(
          `UPDATE agent_messages
           SET tokens_total = CAST(json_extract(tokens_json, '$.total') AS INTEGER)
           WHERE tokens_total IS NULL AND tokens_json IS NOT NULL AND rowid >= ? AND rowid <= ?`,
          [start, end]
        )
        if (!result.ok) {
          Logger.error('agent_messages.tokens_total backfill failed', {
            error: result.error ?? 'unknown'
          })
          return
        }
      }
      await this.executeViaWorker(
        "INSERT OR IGNORE INTO db_meta(key, value) VALUES('tokens_total_backfilled', '1')",
        []
      )
      Logger.info('Migrated agent_messages: tokens_total backfill complete')
    } catch (error) {
      Logger.error('agent_messages.tokens_total backfill aborted', { error: String(error) })
    }
  }
}

/** Statement text attributed in slow-op logs; capped and normalized to a single line. */
const MAX_SLOW_OP_SQL_LENGTH = 240

function truncateSqlForLog(sql: string): string {
  const singleLine = sql.replace(/\s+/gu, ' ').trim()
  return singleLine.length > MAX_SLOW_OP_SQL_LENGTH
    ? `${singleLine.slice(0, MAX_SLOW_OP_SQL_LENGTH)}…`
    : singleLine
}

/**
 * Local fallback for the worker's bounded query: applies the same LIMIT +
 * truncation semantics against a primary connection.
 */
function runLocalBoundedQuery(
  db: Database,
  sql: string,
  params: unknown[],
  maxRows: number
): { ok: boolean; rows: Record<string, unknown>[]; truncated: boolean; error?: string } {
  try {
    const bounded = Math.max(0, Math.floor(maxRows))
    let statementSql = sql.replace(/;\s*$/u, '')
    const boundParams = [...params]
    if (bounded > 0) {
      statementSql = `${statementSql} LIMIT ?`
      boundParams.push(bounded + 1)
    }
    const rows = db.all<Record<string, unknown>>(statementSql, ...boundParams)
    const truncated = bounded > 0 && rows.length > bounded
    return { ok: true, rows: truncated ? rows.slice(0, bounded) : rows, truncated }
  } catch (error) {
    return { ok: false, rows: [], truncated: false, error: String(error) }
  }
}
