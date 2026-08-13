import { generateId } from '../utils'
import type { HistoryEntry, HistoryRole } from '../types'
import type { Database } from '../../main/database/database'
import {
  HistoryRepo,
  buildHistoryLoadPageSql,
  buildHistoryLoadSql,
  buildHistorySearchSql,
  mapHistoryRows,
  runHistoryAppend,
  truncateHistoryStatement
} from '../../main/database/repositories/history-repo'

/**
 * History engine. All reads (including the history FTS search) and writes are
 * routed through the typed serialized worker API with bounded responses; the
 * `HistoryRepo` on the primary connection is the fallback.
 *
 * - `append` allocates the next sequence and inserts in ONE atomic worker
 *   transaction (`history-append`), so concurrent appends can never allocate
 *   the same sequence.
 * - `load` without an explicit limit cursor-pages through the worker in
 *   bounded chunks, so the full-load API never silently truncates.
 */
export class HistoryEngine {
  private repo: HistoryRepo

  /** Bounded page size for cursor-paged history reads. */
  private static readonly HISTORY_PAGE_SIZE = 1000
  private static readonly MAX_HISTORY_PAGES = 100_000

  constructor(private readonly db: Database) {
    this.repo = new HistoryRepo(db)
  }

  async append(
    projectId: string,
    threadId: string,
    role: HistoryRole,
    content: string,
    metadata?: HistoryEntry['metadata']
  ): Promise<HistoryEntry> {
    const entry: HistoryEntry = {
      id: generateId(),
      role,
      content,
      metadata,
      timestamp: Date.now()
    }
    const outcome = await this.db.appendHistoryViaWorker(
      entry.id,
      threadId,
      role,
      content,
      metadata,
      entry.timestamp
    )
    if (!outcome.ok) {
      // Atomic fallback on the primary connection (still one transaction).
      runHistoryAppend(this.db, {
        id: entry.id,
        threadId,
        role,
        content,
        metadata,
        timestamp: entry.timestamp
      })
    }
    return entry
  }

  async load(projectId: string, threadId: string, limit?: number): Promise<HistoryEntry[]> {
    if (limit !== undefined && limit > 0) {
      const built = buildHistoryLoadSql(threadId, limit)
      const result = await this.db.queryViaWorker(built.sql, built.params, built.maxRows)
      if (result.ok) return mapHistoryRows(result.rows)
      return this.repo.load(threadId, limit)
    }
    // Full load: cursor-page through the worker in bounded chunks so the
    // response is complete while each worker query stays bounded.
    const page = await this.pagedHistoryRows(threadId)
    if (!page.ok) return this.repo.load(threadId)
    return mapHistoryRows(page.rows)
  }

  async count(projectId: string, threadId: string): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT count(*) AS c FROM history_entries WHERE thread_id = ?',
      [threadId],
      1
    )
    if (result.ok && result.rows.length > 0) return Number(result.rows[0].c)
    return this.repo.count(threadId)
  }

  async truncate(projectId: string, threadId: string, sequence: number): Promise<void> {
    const statement = truncateHistoryStatement(threadId, sequence)
    const outcome = await this.db.executeViaWorker(statement.sql, statement.params)
    if (!outcome.ok) {
      this.repo.truncateFromSequence(threadId, sequence)
    }
  }

  async search(query: string, projectId?: string, limit = 20): Promise<HistoryEntry[]> {
    const built = buildHistorySearchSql(query, projectId, limit)
    const result = await this.db.queryViaWorker(built.sql, built.params, built.maxRows)
    if (result.ok) return mapHistoryRows(result.rows)
    return this.repo.search(query, projectId, limit)
  }

  /**
   * Read the full history by cursor-paging through the worker in bounded
   * chunks (ascending sequence). Returns `ok: false` when the worker path is
   * unavailable so the caller can fall back to the repo.
   */
  private async pagedHistoryRows(
    threadId: string
  ): Promise<{ ok: true; rows: unknown[] } | { ok: false }> {
    const rows: unknown[] = []
    let afterSequence: number | undefined
    for (let page = 0; page < HistoryEngine.MAX_HISTORY_PAGES; page++) {
      const built = buildHistoryLoadPageSql(threadId, afterSequence)
      const result = await this.db.queryViaWorker(built.sql, built.params, HistoryEngine.HISTORY_PAGE_SIZE)
      if (!result.ok) return { ok: false }
      rows.push(...result.rows)
      if (!result.truncated || result.rows.length === 0) break
      if (result.rows.length < HistoryEngine.HISTORY_PAGE_SIZE) break
      const last = result.rows[result.rows.length - 1] as { sequence: number }
      afterSequence = Number(last.sequence)
    }
    return { ok: true, rows }
  }
}
