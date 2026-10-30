import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { performance } from 'node:perf_hooks'
import DatabaseConstructor from 'better-sqlite3'
import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { Logger } from '../../system/logger'
import { reportSlowMainThreadOperation } from './database-slow-operations'

/**
 * The primary SQLite connection and the synchronous statement API on it.
 *
 * Owns nothing but the connection: the schema, the maintenance worker and the
 * lifecycle stay outside, so a caller that only needs `run`/`get`/`all` never
 * pulls the rest of the database layer into its graph.
 *
 * - WAL journal mode for concurrent reads
 * - busy_timeout to prevent SQLITE_BUSY
 * - Lazy open: the constructor only records the path
 */
export class DatabaseConnection {
  private db: DatabaseType | null = null
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** The file this connection opens, or `:memory:` in tests. */
  filePath(): string {
    return this.path
  }

  /**
   * Open the connection and configure it for bounded latency and WAL
   * concurrency.
   *
   * On a fresh install the config root does not exist yet and
   * `storage.initialize()` runs concurrently with this call, so the parent
   * directory is created first: otherwise SQLite aborts with "cannot open
   * database because the directory does not exist".
   */
  open(): void {
    if (this.db) return
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseConstructor(this.path)
    this.configure()
  }

  /** Close the connection and release the handle. */
  close(): void {
    if (!this.db) return
    this.db.close()
    this.db = null
  }

  /** Whether the connection is currently open. */
  isOpen(): boolean {
    return this.db !== null
  }

  /** The raw better-sqlite3 handle, for the callers that need the advanced API. */
  raw(): DatabaseType {
    return this.requireDb()
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
      reportSlowMainThreadOperation('run', startedAt, sql)
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
      reportSlowMainThreadOperation('get', startedAt, sql)
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
      reportSlowMainThreadOperation('all', startedAt, sql)
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
      reportSlowMainThreadOperation('transaction', startedAt)
    }
  }

  /** Check if a table exists in the schema. */
  tableExists(name: string): boolean {
    const row = this.get<{ cnt: number }>(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?",
      name
    )
    return (row?.cnt ?? 0) > 0
  }

  private requireDb(): DatabaseType {
    if (!this.db) {
      throw new Error('Database not initialised. Call init() first.')
    }
    return this.db
  }

  /** Configure each primary connection for bounded latency and WAL concurrency. */
  private configure(): void {
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
}
