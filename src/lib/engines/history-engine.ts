import { generateId } from '../utils'
import type { HistoryEntry, HistoryRole } from '../types'
import type { Database } from '../../main/database/database'
import {
  HistoryRepo,
  buildHistoryLoadSql,
  buildHistorySearchSql,
  insertHistoryStatement,
  mapHistoryRows,
  truncateHistoryStatement
} from '../../main/database/repositories/history-repo'

/**
 * History engine. All reads (including the history FTS search) and writes are
 * routed through the typed serialized worker API with bounded responses; the
 * `HistoryRepo` on the primary connection is the fallback.
 */
export class HistoryEngine {
  private repo: HistoryRepo

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
    const sequence = (await this.maxSequence(projectId, threadId)) + 1
    const entry: HistoryEntry = {
      id: generateId(),
      role,
      content,
      metadata,
      timestamp: Date.now()
    }
    const statement = insertHistoryStatement(
      entry.id,
      threadId,
      role,
      content,
      metadata,
      sequence,
      entry.timestamp
    )
    const outcome = await this.db.executeViaWorker(statement.sql, statement.params)
    if (!outcome.ok) {
      this.repo.insert(entry.id, threadId, role, content, metadata, sequence, entry.timestamp)
    }
    return entry
  }

  async load(projectId: string, threadId: string, limit?: number): Promise<HistoryEntry[]> {
    const built = buildHistoryLoadSql(threadId, limit)
    const result = await this.db.queryViaWorker(built.sql, built.params, built.maxRows)
    if (result.ok) return mapHistoryRows(result.rows)
    return this.repo.load(threadId, limit)
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

  private async maxSequence(projectId: string, threadId: string): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT max("sequence") AS seq FROM history_entries WHERE thread_id = ?',
      [threadId],
      1
    )
    if (result.ok && result.rows.length > 0) {
      const seq = result.rows[0].seq
      return seq === null || seq === undefined ? 0 : Number(seq)
    }
    return this.repo.maxSequence(threadId)
  }
}
