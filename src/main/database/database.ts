import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { performance } from 'node:perf_hooks'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../system/logger'
import {
  DATABASE_SCHEMA_SQL,
  LEGACY_RUBRIC_VERSION,
  MODEL_RANKINGS_COLUMNS_SQL,
  MODEL_RANKING_CALC_VERSION,
  MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL,
  MODEL_RANKING_SNAPSHOT_INDEXES_SQL,
  MODEL_RANKING_INDEXES_SQL,
  USAGE_EVENTS_COLUMNS_SQL,
  USAGE_EVENTS_INDEXES_SQL
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
import { buildBoundedQuery } from './bounded-query'

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
    this.startMaintenanceWorker()
    await this.migrateIndependentUsageLedger()
    this.db.pragma('optimize = 0x10002')

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

  /**
   * Serialize a thread's mirrored conversation into a Markdown transcript on
   * the maintenance worker's thread and write it atomically. Returns the
   * written path, or a typed error when the worker is unavailable or fails.
   */
  async exportTranscriptViaWorker(
    threadId: string,
    includeTrace: boolean,
    destinationPath: string
  ): Promise<{ ok: boolean; path?: string; error?: string }> {
    const worker = this.maintenanceWorker
    if (!worker?.isRunning()) {
      return { ok: false, error: 'no maintenance worker' }
    }
    const response = await worker.exportTranscript(threadId, includeTrace, destinationPath)
    if (response.ok) return { ok: true, path: response.path }
    return { ok: false, error: response.error ?? 'transcript export failed' }
  }

  // ── Serialized worker CRUD (bounded/paged reads, batched writes) ────────

  /**
   * Bounded read executed on the worker's connection (serialized with every
   * other worker request and the maintenance loop). `maxRows` (>0) bounds the
   * response; caller-owned LIMIT clauses are preserved inside an outer bound.
   * Falls back to the primary connection when no worker is available or the
   * worker fails.
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
    // Free deleted pages onto the freelist so `PRAGMA incremental_vacuum`
    // (maintenance worker) can hand them back to the OS in bounded batches.
    // Takes effect on new databases immediately; existing databases convert
    // on their next full VACUUM (triggered after project deletion).
    connection.pragma('auto_vacuum = INCREMENTAL')
    connection.pragma('busy_timeout = 5000')
    connection.pragma('temp_store = MEMORY')
    connection.pragma('cache_size = -32768')
    connection.pragma('mmap_size = 268435456')
    connection.pragma('wal_autocheckpoint = 1000')
    connection.pragma('journal_size_limit = 67108864')
  }

  private applySchema(): void {
    const connection = this.requireDb()
    connection.transaction(() => {
      this.migrateModelRankingTables(connection)
      connection.exec(DATABASE_SCHEMA_SQL)
      this.migrateEngineeringLifecycleColumns(connection)
      this.migrateUsageEventColumns(connection)
      this.migrateThreadSettingsLegacyEngineeringFlag(connection)
    })()
  }

  /**
   * One-time replacement of the legacy per-turn `turn_feedback` ledger (1–5
   * grades) with the `model_rankings` aggregate + `model_ranking_snapshots`
   * queue. Graded legacy rows are folded into the aggregate with the linear
   * map grade → (grade − 1) × 2.5 under `rubric_version = 'legacy-1to5-map-v1'`
   * (no duration information existed, so duration sums stay 0), and only then
   * is the legacy table dropped. Idempotent: without a legacy table this is a
   * no-op. The fold-in is a single grouped INSERT … SELECT, so large ledgers
   * stay one bounded pass rather than per-row inserts.
   */
  migrateModelRankingTables(connection?: DatabaseType): void {
    const target = connection ?? this.requireDb()
    const columns = new Set<string>(
      (target.prepare('PRAGMA table_info(turn_feedback)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    if (columns.size === 0) return
    if (!columns.has('grade')) {
      // Databases predating LLM-graded turn feedback carry the useless binary
      // pass/fail ledger (status 'success'/'corrected', regex-driven). The
      // metric was unreliable by construction: nothing is worth translating.
      target.exec('DROP TABLE turn_feedback')
      return
    }
    // The aggregate must exist before the fold-in; the canonical schema's
    // CREATE IF NOT EXISTS below stays a no-op afterwards.
    target.exec(
      `CREATE TABLE IF NOT EXISTS model_rankings (${MODEL_RANKINGS_COLUMNS_SQL});
       CREATE TABLE IF NOT EXISTS model_ranking_snapshots (${MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL});`
    )
    target.exec(MODEL_RANKING_INDEXES_SQL)
    target.exec(MODEL_RANKING_SNAPSHOT_INDEXES_SQL)
    target.exec(`
      INSERT INTO model_rankings(
        id, harness_id, provider_id, model_id, thinking_level,
        one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
        multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
        rubric_version, calc_version, updated_at
      )
      SELECT
        'legacy-' || MIN(legacy.rowid),
        legacy.harness_id,
        COALESCE(legacy.provider_id, ''),
        legacy.model_id,
        COALESCE(legacy.thinking_level, ''),
        SUM((legacy.grade - 1) * 2.5),
        COUNT(*),
        0,
        COALESCE(SUM(CASE WHEN legacy.cost_status <> 'unavailable' AND legacy.cost_usd IS NOT NULL
                          THEN legacy.cost_usd ELSE 0 END), 0),
        0, 0, 0, 0,
        '${LEGACY_RUBRIC_VERSION}',
        '${MODEL_RANKING_CALC_VERSION}',
        MAX(legacy.created_at)
      FROM turn_feedback AS legacy
      WHERE legacy.status = 'graded'
        AND legacy.grade IS NOT NULL
        AND legacy.harness_id IS NOT NULL
        AND legacy.model_id IS NOT NULL
      GROUP BY legacy.harness_id, COALESCE(legacy.provider_id, ''), legacy.model_id,
               COALESCE(legacy.thinking_level, '')
    `)
    target.exec('DROP TABLE turn_feedback')
  }

  /**
   * Rows persisted before the legacy `engineeringMode` settings flag was
   * scrubbed still carry it inside their settings JSON. Rewrite affected rows
   * without the flag — the Engineering lifecycle selection is the single
   * source of truth now. Idempotent and safe to re-run. Malformed rows are
   * left untouched; the read-path sanitizer in the thread repository still
   * guards them.
   */
  /**
   * Rebuild missing `main` usage events from the durable agent_messages ledger.
   * `INSERT OR IGNORE` against the `message:<id>` primary key makes this
   * idempotent — rows already recorded by the live recorder are skipped, so
   * only lost turns (mirrored sessions, recorder outages) are inserted.
   */
  migrateThreadSettingsLegacyEngineeringFlag(connection?: DatabaseType): void {
    const target = connection ?? this.requireDb()
    const rows = target
      .prepare('SELECT id, settings FROM threads WHERE settings LIKE \'%"engineeringMode"%\'')
      .all() as Array<{ id: string; settings: string }>
    if (rows.length === 0) return
    const update = target.prepare('UPDATE threads SET settings = ? WHERE id = ?')
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.settings) as Record<string, unknown>
        if (!('engineeringMode' in parsed)) continue
        const { engineeringMode: _legacyEngineeringMode, ...rest } = parsed
        update.run(JSON.stringify(rest), row.id)
      } catch {
        // A malformed settings blob must never abort startup.
      }
    }
  }

  /** Existing databases predate the multi-select lifecycle columns. `CREATE TABLE IF
   *  NOT EXISTS` never alters an existing table, so add the columns when missing. */
  private migrateEngineeringLifecycleColumns(connection: DatabaseType): void {
    const columns = new Set<string>(
      (
        connection.prepare('PRAGMA table_info(engineering_lifecycle)').all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
    )
    if (!columns.has('selected_stages_json')) {
      connection.exec(
        "ALTER TABLE engineering_lifecycle ADD COLUMN selected_stages_json TEXT NOT NULL DEFAULT '[]'"
      )
    }
    if (!columns.has('autopilot')) {
      connection.exec(
        'ALTER TABLE engineering_lifecycle ADD COLUMN autopilot INTEGER NOT NULL DEFAULT 0'
      )
    }
  }

  /** Existing databases predate the append-only usage snapshot fields. */
  private migrateUsageEventColumns(connection: DatabaseType): void {
    const columns = new Set<string>(
      (connection.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const addedTokensTotal = !columns.has('tokens_total')
    const addedDuration = !columns.has('duration_ms')

    if (addedTokensTotal) {
      connection.exec('ALTER TABLE usage_events ADD COLUMN tokens_total INTEGER')
    }
    if (addedDuration) {
      connection.exec(
        'ALTER TABLE usage_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0)'
      )
    }

    if (addedTokensTotal) {
      connection.exec(`
        UPDATE usage_events
        SET tokens_total = COALESCE(
          raw_total,
          COALESCE(tokens_uncached_input, 0) +
            COALESCE(tokens_cached_input, 0) +
            COALESCE(tokens_cache_write, 0) +
            COALESCE(tokens_output, 0) +
            COALESCE(tokens_reasoning, 0)
        )
        WHERE tokens_total IS NULL
      `)
    }

    if (addedDuration) {
      connection.exec(`
        UPDATE usage_events
        SET duration_ms = MAX(
          0,
          COALESCE(
            (
              SELECT completed_at - created_at
              FROM agent_messages
              WHERE agent_messages.id = usage_events.parent_turn_id
            ),
            0
          )
        )
        WHERE duration_ms = 0
      `)
    }
  }

  /**
   * Detach the usage ledger from mutable conversation rows. Older schemas used
   * cascading foreign keys to threads and messages, which erased analytics
   * whenever retention evicted a thread. Rebuild once, snapshot project
   * identity, and retain the text identifiers without lifecycle constraints.
   */
  private async migrateIndependentUsageLedger(): Promise<void> {
    const connection = this.requireDb()
    const columns = new Set<string>(
      (connection.prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    )
    const foreignKeys = connection.prepare('PRAGMA foreign_key_list(usage_events)').all()
    const independent =
      columns.has('project_id') && columns.has('project_name') && foreignKeys.length === 0

    const projectIndex = `CREATE INDEX IF NOT EXISTS idx_usage_events_project
      ON usage_events(project_id, created_at, id)`
    if (independent) {
      const result = await this.executeViaWorker(projectIndex, [])
      if (!result.ok) throw new Error(result.error ?? 'Could not index the usage ledger')
      return
    }

    const projectId = columns.has('project_id')
      ? 'COALESCE(legacy.project_id, threads.project_id)'
      : 'threads.project_id'
    const projectName = columns.has('project_name')
      ? 'COALESCE(legacy.project_name, projects.name)'
      : 'projects.name'

    const statements = [
      {
        sql: 'ALTER TABLE usage_events RENAME TO usage_events_legacy',
        params: []
      },
      {
        sql: `CREATE TABLE usage_events (${USAGE_EVENTS_COLUMNS_SQL})`,
        params: []
      },
      {
        sql: `INSERT INTO usage_events(
          id, thread_id, parent_turn_id, project_id, project_name,
          feature_call_id, attempt, feature,
          harness_id, provider_id, model_id, thinking_level, utility_id,
          raw_provider_usage_json,
          tokens_uncached_input, tokens_cached_input, tokens_cache_write,
          tokens_output, tokens_reasoning, tokens_total, raw_total, total_semantics,
          cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
          success, retry_cause, duration_ms, created_at
        )
        SELECT
          legacy.id, legacy.thread_id, legacy.parent_turn_id, ${projectId}, ${projectName},
          legacy.feature_call_id, legacy.attempt, legacy.feature,
          legacy.harness_id, legacy.provider_id, legacy.model_id, legacy.thinking_level,
          legacy.utility_id, legacy.raw_provider_usage_json,
          legacy.tokens_uncached_input, legacy.tokens_cached_input, legacy.tokens_cache_write,
          legacy.tokens_output, legacy.tokens_reasoning, legacy.tokens_total,
          legacy.raw_total, legacy.total_semantics,
          legacy.cost_usd, legacy.cost_status, legacy.pricing_provenance_json,
          legacy.tool_fee_usd, legacy.success, legacy.retry_cause,
          legacy.duration_ms, legacy.created_at
        FROM usage_events_legacy AS legacy
        LEFT JOIN threads ON threads.id = legacy.thread_id
        LEFT JOIN projects ON projects.id = threads.project_id
        `,
        params: []
      },
      { sql: 'DROP TABLE usage_events_legacy', params: [] },
      ...USAGE_EVENTS_INDEXES_SQL.split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => ({ sql, params: [] })),
      { sql: projectIndex, params: [] }
    ]
    const result = await this.transactionViaWorker(statements)
    if (!result.ok) throw new Error(result.error ?? 'Could not migrate the usage ledger')
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
 * Local fallback for the worker's bounded query: applies the same outer-limit
 * and truncation semantics against a primary connection.
 */
function runLocalBoundedQuery(
  db: Database,
  sql: string,
  params: unknown[],
  maxRows: number
): { ok: boolean; rows: Record<string, unknown>[]; truncated: boolean; error?: string } {
  try {
    const boundedQuery = buildBoundedQuery(sql, maxRows)
    const boundParams = [...params]
    if (boundedQuery.limitParam !== undefined) {
      boundParams.push(boundedQuery.limitParam)
    }
    const rows = db.all<Record<string, unknown>>(boundedQuery.sql, ...boundParams)
    const bounded = Math.max(0, Math.floor(maxRows))
    const truncated = bounded > 0 && rows.length > bounded
    return { ok: true, rows: truncated ? rows.slice(0, bounded) : rows, truncated }
  } catch (error) {
    return { ok: false, rows: [], truncated: false, error: String(error) }
  }
}
