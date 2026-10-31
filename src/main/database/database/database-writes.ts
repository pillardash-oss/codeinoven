import { Logger } from '../../system/logger'
import type { DatabaseWorker } from '../database-worker'
import type { HistoryAppendArgs } from '../repositories/history-repo'

/** Everything a batched write needs from the database it belongs to. */
export interface DatabaseWritesHost {
  /** The running maintenance worker, or null when this database has none. */
  getWorker(): DatabaseWorker | null
  /** Primary-connection write, used when the worker is absent or fails. */
  run(sql: string, ...params: unknown[]): void
  /** Primary-connection transaction, used for the same reason. */
  transaction<T>(fn: () => T): T
  /** Atomic history append on the primary connection, allocating its sequence. */
  appendHistory(args: HistoryAppendArgs): { sequence: number }
}

/**
 * Writes that are batched or serialized on the maintenance worker's connection.
 *
 * Every method here answers the same shape whether it ran on the worker or fell
 * back to the primary connection, so a caller never has to know which one served
 * it. The fallback exists for in-memory test databases, which cannot have a
 * second connection, and for a worker that has already stopped.
 */
export class DatabaseWrites {
  private readonly host: DatabaseWritesHost

  constructor(host: DatabaseWritesHost) {
    this.host = host
  }

  /** Single write statement on the worker's connection; primary fallback. */
  async executeViaWorker(
    sql: string,
    params: unknown[],
    options: { allowPrimaryFallback?: boolean } = {}
  ): Promise<{ ok: boolean; error?: string }> {
    const worker = this.host.getWorker()
    if (worker?.isRunning()) {
      const response = await worker.execute(sql, params)
      if (response.ok) return { ok: true }
      if (options.allowPrimaryFallback === false)
        return { ok: false, error: response.error ?? 'Database worker execution failed' }
      if (response.error) {
        Logger.error(
          'Database worker execute failed; falling back to primary connection',
          response.error
        )
      }
    }
    if (options.allowPrimaryFallback === false)
      return { ok: false, error: 'Database worker is unavailable' }
    try {
      this.host.run(sql, ...params)
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
    const worker = this.host.getWorker()
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
      this.host.transaction(() => {
        for (const statement of statements) {
          this.host.run(statement.sql, ...(statement.params ?? []))
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
    role: HistoryAppendArgs['role'],
    content: string,
    metadata: Record<string, unknown> | undefined,
    timestamp: number
  ): Promise<{ ok: boolean; sequence?: number; error?: string }> {
    const worker = this.host.getWorker()
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
      const { sequence } = this.host.appendHistory({
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
}
