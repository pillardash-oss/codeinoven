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
  MISC_TABLES_SQL
} from './schema'
import { partsToSearchText } from './repositories/agent-message-repo'

const SCHEMA_VERSION_KEY = 'schema_version'
const CURRENT_SCHEMA_VERSION = 5

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

  constructor(path?: string) {
    this.path = path ?? getConfigRoot() + '/codeinoven.db'
  }

  /** Initialise the database: open connection, apply schema, set WAL mode. */
  async init(): Promise<void> {
    if (this.db) return

    this.db = new DatabaseConstructor(this.path)

    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('foreign_keys = ON')

    // The app has never shipped, so there is no legacy data to migrate. The full
    // DDL is applied idempotently on a fresh database.
    this.applySchema()
    this.ensureThreadWorkflowSchema()
    this.ensureThreadSearchSchema()
    this.setSchemaVersion(CURRENT_SCHEMA_VERSION)

    Logger.info('SQLite database initialised', { path: this.path })
  }

  /** Close the database connection. */
  close(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
    Logger.info('SQLite database closed')
  }

  /** Whether the database connection is currently open. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** Execute a write query (INSERT/UPDATE/DELETE) with optional params. */
  run(sql: string, ...params: unknown[]): void {
    try {
      this.requireDb()
        .prepare(sql)
        .run(...params)
    } catch (error) {
      Logger.error('Database.run failed', { sql, error: String(error) })
      throw error
    }
  }

  /** Fetch a single row as an object. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    try {
      return this.requireDb()
        .prepare(sql)
        .get(...params) as T | undefined
    } catch (error) {
      Logger.error('Database.get failed', { sql, error: String(error) })
      throw error
    }
  }

  /** Fetch all rows as an array of objects. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    try {
      return this.requireDb()
        .prepare(sql)
        .all(...params) as T[]
    } catch (error) {
      Logger.error('Database.all failed', { sql, error: String(error) })
      throw error
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
    try {
      return this.requireDb().transaction(fn)()
    } catch (error) {
      Logger.error('Database.transaction failed', { error: String(error) })
      throw error
    }
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
