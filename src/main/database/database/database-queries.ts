import { Logger } from '../../system/logger'
import type { DatabaseWorker } from '../database-worker'
import type { AgentMessage, UserMessageSummary } from '../../../lib/types'
import {
  mapMessageRows,
  mapUserMessageRows,
  type ProviderDeltaSyncResult
} from '../repositories/agent-message-repo'
import { raceWorkerQuery, runLocalBoundedQuery } from './database-sql-fallbacks'

/** Everything a worker-backed read needs from the database it belongs to. */
export interface DatabaseQueriesHost {
  /** The running maintenance worker, or null when this database has none. */
  getWorker(): DatabaseWorker | null
  /** Primary-connection read, used only when no worker is available. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[]
  /** Delta sync on the primary connection, used only when no worker is available. */
  syncProviderDeltas(
    threadId: string,
    sessionId: string,
    messages: AgentMessage[]
  ): ProviderDeltaSyncResult
}

/**
 * Reads and transcript work issued to the maintenance worker's connection.
 *
 * The worker serializes every request with its maintenance passes through one
 * single-flight queue, which is what keeps a multi-hundred-megabyte scan off the
 * main thread. Each method falls back to the primary connection only when the
 * worker is unavailable (an in-memory test database) or has failed, and reports
 * the same shape either way.
 */
export class DatabaseQueries {
  private readonly host: DatabaseQueriesHost

  constructor(host: DatabaseQueriesHost) {
    this.host = host
  }

  /**
   * Bounded read executed on the worker's connection. `maxRows` (>0) bounds the
   * response; caller-owned LIMIT clauses are preserved inside an outer bound.
   *
   * `deadlineMs` is for the reads an interactive surface is waiting on. A
   * checkpoint, an integrity check or an FTS optimize ahead of an interactive
   * read can hold the queue for as long as it takes, so past the deadline the
   * caller is told the read timed out (`timedOut`) instead of being left
   * pending: the request keeps running on the worker, but the caller can answer
   * with what it already has. A deadline never falls back to the primary
   * connection, because answering "slowly" on the main thread is exactly the
   * freeze the deadline exists to prevent.
   */
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
    const worker = this.host.getWorker()
    if (worker?.isRunning()) {
      const response = await raceWorkerQuery(worker.query(sql, params, maxRows), options.deadlineMs)
      if (response === null)
        return {
          ok: false,
          rows: [],
          truncated: false,
          error: `Database worker query exceeded ${options.deadlineMs} ms`,
          timedOut: true
        }
      if (response.ok) {
        return { ok: true, rows: response.rows ?? [], truncated: response.truncated ?? false }
      }
      if (options.allowPrimaryFallback === false)
        return {
          ok: false,
          rows: [],
          truncated: false,
          error: response.error ?? 'Database worker query failed'
        }
      if (response.error) {
        Logger.error(
          'Database worker query failed; falling back to primary connection',
          response.error
        )
      }
    }
    if (options.allowPrimaryFallback === false)
      return { ok: false, rows: [], truncated: false, error: 'Database worker is unavailable' }
    return runLocalBoundedQuery(this.host, sql, params, maxRows)
  }

  /**
   * Bounded read decoded straight to `AgentMessage[]` on the worker's
   * connection: the `parts` JSON is parsed and capped there, so a
   * multi-megabyte tool-output string never crosses into the main process.
   * Falls back to decoding on the primary connection (main thread) only when
   * the worker itself is unavailable.
   */
  async queryMessagesViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number,
    includeTransport = false
  ): Promise<{ ok: boolean; messages: AgentMessage[]; truncated: boolean; error?: string }> {
    const worker = this.host.getWorker()
    if (worker?.isRunning()) {
      const response = await worker.queryMessages(sql, params, maxRows, includeTransport)
      if (response.ok) {
        return {
          ok: true,
          messages: response.messages ?? [],
          truncated: response.truncated ?? false
        }
      }
      if (response.error) {
        Logger.error(
          'Database worker query-messages failed; falling back to primary connection',
          response.error
        )
      }
    }
    const local = runLocalBoundedQuery(this.host, sql, params, maxRows)
    if (!local.ok) return { ok: false, messages: [], truncated: false, error: local.error }
    return {
      ok: true,
      messages: mapMessageRows(local.rows, includeTransport),
      truncated: local.truncated
    }
  }

  /** Bounded read decoded straight to `UserMessageSummary[]` on the worker's connection. */
  async queryUserMessagesViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<{ ok: boolean; messages: UserMessageSummary[]; truncated: boolean; error?: string }> {
    const worker = this.host.getWorker()
    if (worker?.isRunning()) {
      const response = await worker.queryUserMessages(sql, params, maxRows)
      if (response.ok) {
        return {
          ok: true,
          messages: response.messages ?? [],
          truncated: response.truncated ?? false
        }
      }
      if (response.error) {
        Logger.error(
          'Database worker query-user-messages failed; falling back to primary connection',
          response.error
        )
      }
    }
    const local = runLocalBoundedQuery(this.host, sql, params, maxRows)
    if (!local.ok) return { ok: false, messages: [], truncated: false, error: local.error }
    return { ok: true, messages: mapUserMessageRows(local.rows), truncated: local.truncated }
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
    const worker = this.host.getWorker()
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
    return this.host.syncProviderDeltas(threadId, sessionId, messages)
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
    const worker = this.host.getWorker()
    if (!worker?.isRunning()) {
      return { ok: false, error: 'no maintenance worker' }
    }
    const response = await worker.exportTranscript(threadId, includeTrace, destinationPath)
    if (response.ok) return { ok: true, path: response.path }
    return { ok: false, error: response.error ?? 'transcript export failed' }
  }
}
