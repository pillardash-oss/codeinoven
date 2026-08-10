import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { performance } from 'node:perf_hooks'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from '../logger'
import {
  SCHEMA_SQL,
  PROJECT_FTS_SQL,
  THREADS_SQL,
  HISTORY_SQL,
  HISTORY_FTS_SQL,
  AGENT_MESSAGES_SQL,
  AGENT_MESSAGES_FTS_SQL,
  AGENT_MESSAGES_FTS_TRIGGERS_SQL,
  MISC_TABLES_SQL,
  PERSISTENCE_SQL,
  HARNESS_USAGE_SQL
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
  partsToSearchText,
  hashPersistedRow,
  type ProviderDeltaSyncResult
} from './repositories/agent-message-repo'
import { runHistoryAppend } from './repositories/history-repo'
import type { AgentMessage } from '../../lib/types'

const SCHEMA_VERSION_KEY = 'schema_version'
const CURRENT_SCHEMA_VERSION = 6
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

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')

    // The app has never shipped, so there is no legacy data to migrate. The full
    // DDL is applied idempotently on a fresh database.
    this.applySchema()
    this.ensureAssignmentStoppedSchema()
    this.ensureThreadWorkflowSchema()
    this.ensureThreadPinnedAtSchema()
    this.backfillAssignmentThreadLineage()
    this.ensureThreadSearchSchema()
    this.ensureAgentMessageCreditsSchema()
    this.ensureHarnessUsageSchema()
    this.ensureProjectDeploymentsSchema()
    this.setSchemaVersion(CURRENT_SCHEMA_VERSION)

    this.startMaintenanceWorker()

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
      this.reportSlowMainThreadOperation('run', startedAt)
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
      this.reportSlowMainThreadOperation('get', startedAt)
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
      this.reportSlowMainThreadOperation('all', startedAt)
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

  /** Log only operation class and duration; SQL text and user data are omitted. */
  private reportSlowMainThreadOperation(operation: string, startedAt: number): void {
    const durationMs = performance.now() - startedAt
    if (durationMs < MAIN_THREAD_DATABASE_WARNING_MS) return
    Logger.info('Slow synchronous SQLite operation on Electron main', {
      operation,
      durationMs: this.roundDuration(durationMs)
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

  private applySchema(): void {
    this.db?.exec(SCHEMA_SQL)
    this.db?.exec(PROJECT_FTS_SQL)
    this.db?.exec(THREADS_SQL)
    this.db?.exec(HISTORY_SQL)
    this.db?.exec(HISTORY_FTS_SQL)
    this.db?.exec(AGENT_MESSAGES_SQL)
    this.db?.exec(MISC_TABLES_SQL)
    this.db?.exec(PERSISTENCE_SQL)
    this.db?.exec(HARNESS_USAGE_SQL)
  }

  private ensureThreadWorkflowSchema(): void {
    const columns = this.all<{ name: string }>('PRAGMA table_info(threads)')
    const names = new Set(columns.map((column) => column.name))
    if (!names.has('achievement_role')) {
      this.db?.exec(
        "ALTER TABLE threads ADD COLUMN achievement_role TEXT CHECK(achievement_role IN ('coordinator','auditor'))"
      )
    }
    if (!names.has('auditor_thread_id')) {
      this.db?.exec('ALTER TABLE threads ADD COLUMN auditor_thread_id TEXT')
    }
    if (!names.has('context_usage')) {
      this.db?.exec('ALTER TABLE threads ADD COLUMN context_usage TEXT')
    }
  }

  /**
   * Add the `pinned_at` timestamp used to order pinned threads (newest pinned
   * first) and backfill existing pinned rows from their last activity so they
   * sort deterministically before the user next reorders them.
   */
  private ensureThreadPinnedAtSchema(): void {
    const columns = this.all<{ name: string }>('PRAGMA table_info(threads)')
    const names = new Set(columns.map((column) => column.name))
    if (!names.has('pinned_at')) {
      this.db?.exec('ALTER TABLE threads ADD COLUMN pinned_at INTEGER')
    }
    this.db?.exec(
      'UPDATE threads SET pinned_at = last_activity WHERE pinned = 1 AND pinned_at IS NULL'
    )
  }

  /** Expand pre-existing Assignment status constraints with the terminal stopped state. */
  private ensureAssignmentStoppedSchema(): void {
    const workflowSql = this.get<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='assignment_workflow'"
    )?.sql
    if (!workflowSql || workflowSql.includes("'stopped'")) return

    this.db?.exec(`
      DROP INDEX IF EXISTS idx_assignment_versions_coordinator;

      ALTER TABLE assignment_versions RENAME TO assignment_versions_before_stopped;
      CREATE TABLE assignment_versions (
        assignment_id         TEXT NOT NULL,
        version               INTEGER NOT NULL,
        project_id            TEXT NOT NULL,
        coordinator_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        spec_id               TEXT NOT NULL,
        spec_version          INTEGER NOT NULL,
        status                TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed','stopped')),
        data                  TEXT NOT NULL,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (assignment_id, version)
      );
      INSERT INTO assignment_versions SELECT * FROM assignment_versions_before_stopped;
      DROP TABLE assignment_versions_before_stopped;
      CREATE INDEX idx_assignment_versions_coordinator
        ON assignment_versions(project_id, coordinator_thread_id);

      ALTER TABLE assignment_workflow RENAME TO assignment_workflow_before_stopped;
      CREATE TABLE assignment_workflow (
        project_id            TEXT NOT NULL,
        coordinator_thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        assignment_id         TEXT NOT NULL,
        active_version        INTEGER NOT NULL,
        approved_version      INTEGER,
        status                TEXT NOT NULL CHECK(status IN ('draft','approved','running','attention','completed','failed','stopped')),
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (project_id, coordinator_thread_id)
      );
      INSERT INTO assignment_workflow SELECT * FROM assignment_workflow_before_stopped;
      DROP TABLE assignment_workflow_before_stopped;
    `)
  }

  /**
   * Older Assignment retries cleared every orchestration field from retired
   * workers, which made those children indistinguishable from public threads.
   * Successful assign-task operations retain the authoritative worker and
   * coordinator IDs, so restore only that durable lineage. Current workers
   * and coordinator threads are left untouched.
   */
  private backfillAssignmentThreadLineage(): void {
    const result = this.db
      ?.prepare(
        `WITH worker_lineage AS (
          SELECT
            json_extract(result, '$.thread.id') AS thread_id,
            json_extract(result, '$.assignment.coordinatorThreadId') AS coordinator_thread_id
          FROM assignment_operations
          WHERE tool_name = 'assign_task'
            AND result != 'null'
            AND json_extract(result, '$.task.owner') = 'worker'
        )
        UPDATE threads
        SET coordinator_thread_id = (
          SELECT worker_lineage.coordinator_thread_id
          FROM worker_lineage
          WHERE worker_lineage.thread_id = threads.id
          LIMIT 1
        )
        WHERE coordinator_thread_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM worker_lineage
            WHERE worker_lineage.thread_id = threads.id
              AND worker_lineage.coordinator_thread_id IS NOT NULL
          )`
      )
      .run()
    if (result && result.changes > 0) {
      Logger.info('Backfilled Assignment worker coordinator lineage', {
        count: result.changes
      })
    }
  }

  private ensureAgentMessageCreditsSchema(): void {
    const columns = this.all<{ name: string }>('PRAGMA table_info(agent_messages)')
    const hasContentHash = columns.some((column) => column.name === 'content_hash')
    if (!hasContentHash) {
      this.db?.exec('ALTER TABLE agent_messages ADD COLUMN content_hash TEXT')
    }
    if (!columns.some((column) => column.name === 'usage_credits_json')) {
      this.db?.exec('ALTER TABLE agent_messages ADD COLUMN usage_credits_json TEXT')
    }
    if (!columns.some((column) => column.name === 'context_window')) {
      this.db?.exec('ALTER TABLE agent_messages ADD COLUMN context_window INTEGER')
    }
    if (!columns.some((column) => column.name === 'context_used')) {
      this.db?.exec('ALTER TABLE agent_messages ADD COLUMN context_used INTEGER')
    }

    // Backfill content_hash once so the delta-sync equality check never treats
    // every pre-upgrade row as changed on the first sync. Rows added later are
    // hashed by the upsert/delta paths directly.
    if (hasContentHash) {
      const backfilled =
        this.get<{ value: string }>(
          "SELECT value FROM db_meta WHERE key = 'content_hash_backfilled'"
        )?.value === '1'
      if (!backfilled) {
        const rows = this.all<{
          rowid: number
          role: string
          origin: string
          visibility: string
          parts: string
          search_text: string
          transport_parts: string | null
          transport_origin: string | null
          model_id: string | null
          provider_id: string | null
          harness_id: string | null
          references_json: string | null
          project_references_json: string | null
          created_at: number
          completed_at: number | null
          cost: number | null
          tokens_json: string | null
          rate_limits_json: string | null
          usage_credits_json: string | null
          context_window: number | null
          context_used: number | null
          error: string | null
          structured_output: string | null
        }>(
          'SELECT rowid, role, origin, visibility, parts, search_text, transport_parts, transport_origin, model_id, provider_id, harness_id, references_json, project_references_json, created_at, completed_at, cost, tokens_json, rate_limits_json, usage_credits_json, context_window, context_used, error, structured_output FROM agent_messages WHERE content_hash IS NULL'
        )
        if (rows.length > 0) {
          const update = this.prepare('UPDATE agent_messages SET content_hash = ? WHERE rowid = ?')
          this.transaction(() => {
            for (const row of rows) {
              update.run(hashPersistedRow(row), row.rowid)
            }
          })
        }
        this.run(
          "INSERT OR REPLACE INTO db_meta(key, value) VALUES('content_hash_backfilled', '1')"
        )
      }
    }
  }

  /** Fresh DBs already carry the harness_usage table; older dev DBs add it now. */
  private ensureHarnessUsageSchema(): void {
    if (!this.tableExists('harness_usage')) {
      this.db?.exec(HARNESS_USAGE_SQL)
    }
    // The one-time harness_usage backfill feature was fully removed. Purge the
    // dead backfill gate so no stale metadata lingers for a feature that no
    // longer exists. Idempotent no-op when the key is absent.
    this.run("DELETE FROM db_meta WHERE key = 'harness_usage_backfilled'")
  }

  /**
   * Idempotent guard for the `projects.has_deployments` flag introduced after
   * the base schema shipped. New columns are non-null with a default so the
   * flag can be written independently of a full project upsert.
   */
  private ensureProjectDeploymentsSchema(): void {
    const columns = this.all<{ name: string }>('PRAGMA table_info(projects)')
    if (!columns.some((column) => column.name === 'has_deployments')) {
      this.db?.exec('ALTER TABLE projects ADD COLUMN has_deployments INTEGER NOT NULL DEFAULT 0')
    }
  }

  /**
   * Idempotent guard for thread full-text search. Fresh databases already carry
   * the `search_text` column (schema.ts); databases created by earlier dev
   * builds lack it, so add it first. The FTS table is created before backfilling,
   * but its sync triggers are added only afterwards — an update trigger firing
   * on a row that is not yet in the index corrupts the external-content table.
   *
   * The backfill pass re-reads every `parts` blob and rewrites `search_text`,
   * so it is gated behind a `db_meta` flag: it runs once when the column is
   * first introduced (or to repair rows left empty by a legacy build) and is
   * skipped on every subsequent launch. Afterwards the upsert path keeps the
   * column populated, so a full-table pass would be pure O(total-db) waste.
   */
  private ensureThreadSearchSchema(): void {
    const columns = this.all<{ name: string }>('PRAGMA table_info(agent_messages)')
    const columnAdded = !columns.some((column) => column.name === 'search_text')
    if (columnAdded) {
      this.db?.exec("ALTER TABLE agent_messages ADD COLUMN search_text TEXT NOT NULL DEFAULT ''")
    }

    const ftsExisted = this.tableExists('agent_messages_fts')
    this.db?.exec(AGENT_MESSAGES_FTS_SQL)

    const backfilled =
      this.get<{ value: string }>("SELECT value FROM db_meta WHERE key = 'search_text_backfilled'")
        ?.value === '1'
    if (!backfilled) {
      const rows = this.all<{ rowid: number; parts: string }>(
        columnAdded
          ? 'SELECT rowid, parts FROM agent_messages'
          : "SELECT rowid, parts FROM agent_messages WHERE search_text = ''"
      )
      if (rows.length > 0) {
        this.transaction(() => {
          for (const row of rows) {
            let parts: unknown[] = []
            try {
              const parsed: unknown = JSON.parse(row.parts)
              if (Array.isArray(parsed)) parts = parsed
            } catch {
              parts = []
            }
            const text = partsToSearchText(parts as Parameters<typeof partsToSearchText>[0])
            if (text) {
              this.run('UPDATE agent_messages SET search_text = ? WHERE rowid = ?', text, row.rowid)
            }
          }
        })
      }
      this.run("INSERT OR REPLACE INTO db_meta(key, value) VALUES('search_text_backfilled', '1')")
    }

    // Rebuild the external-content index only when it was just created or the
    // backfill repopulated search_text. Afterwards the sync triggers keep it in
    // lockstep, so skipping the rebuild on steady-state launches avoids a
    // full-table pass (O(total-db)) that grows with the database.
    if (!ftsExisted || !backfilled) {
      this.db?.exec("INSERT INTO agent_messages_fts(agent_messages_fts) VALUES('rebuild')")
    }
    this.db?.exec(AGENT_MESSAGES_FTS_TRIGGERS_SQL)
  }

  private setSchemaVersion(version: number): void {
    this.run(
      'INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)',
      SCHEMA_VERSION_KEY,
      String(version)
    )
  }
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
