import type { Database } from '../database'
import type { HistoryEntry, HistoryRole } from '../../../lib/types'

interface HistoryRow {
  id: string
  thread_id: string
  role: string
  content: string
  metadata: string | null
  sequence: number
  timestamp: number
}

function rowToEntry(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    role: row.role as HistoryRole,
    content: row.content,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    timestamp: row.timestamp
  }
}

export class HistoryRepo {
  constructor(private db: Database) {}

  insert(
    id: string,
    threadId: string,
    role: HistoryRole,
    content: string,
    metadata: Record<string, unknown> | undefined,
    sequence: number,
    timestamp: number
  ): void {
    this.db.run(
      `INSERT INTO history_entries(id, thread_id, role, content, metadata, "sequence", timestamp)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      id,
      threadId,
      role,
      content,
      metadata ? JSON.stringify(metadata) : null,
      sequence,
      timestamp
    )
  }

  load(threadId: string, limit?: number): HistoryEntry[] {
    if (limit !== undefined && limit > 0) {
      const rows = this.db.all<HistoryRow>(
        `SELECT * FROM history_entries WHERE thread_id = ?
         ORDER BY "sequence" ASC
         LIMIT ?`,
        threadId,
        limit
      )
      return rows.map(rowToEntry)
    }
    const rows = this.db.all<HistoryRow>(
      'SELECT * FROM history_entries WHERE thread_id = ? ORDER BY "sequence" ASC',
      threadId
    )
    return rows.map(rowToEntry)
  }

  loadRecent(threadId: string, count: number): HistoryEntry[] {
    const rows = this.db.all<HistoryRow>(
      `SELECT * FROM history_entries WHERE thread_id = ?
       ORDER BY "sequence" DESC
       LIMIT ?`,
      threadId,
      count
    )
    return rows.reverse().map(rowToEntry)
  }

  count(threadId: string): number {
    const row = this.db.get<{ cnt: number }>(
      'SELECT count(*) as cnt FROM history_entries WHERE thread_id = ?',
      threadId
    )
    return row?.cnt ?? 0
  }

  /** Get the maximum sequence number for a thread. */
  maxSequence(threadId: string): number {
    const row = this.db.get<{ seq: number | null }>(
      'SELECT max("sequence") as seq FROM history_entries WHERE thread_id = ?',
      threadId
    )
    return row?.seq ?? 0
  }

  /** Delete all entries from the given sequence onward. */
  truncateFromSequence(threadId: string, sequence: number): void {
    this.db.run(
      'DELETE FROM history_entries WHERE thread_id = ? AND "sequence" >= ?',
      threadId,
      sequence
    )
  }

  /** Full-text search across history entries. */
  search(query: string, projectId?: string, limit = 20): HistoryEntry[] {
    if (projectId) {
      const rows = this.db.all<HistoryRow>(
        `SELECT he.* FROM history_entries he
         JOIN threads t ON t.id = he.thread_id
         JOIN history_fts fts ON he.rowid = fts.rowid
         WHERE t.project_id = ? AND history_fts MATCH ?
         ORDER BY he."sequence" DESC
         LIMIT ?`,
        projectId,
        query,
        limit
      )
      return rows.map(rowToEntry)
    }
    const rows = this.db.all<HistoryRow>(
      `SELECT he.* FROM history_entries he
       JOIN history_fts fts ON he.rowid = fts.rowid
       WHERE history_fts MATCH ?
       ORDER BY he."sequence" DESC
       LIMIT ?`,
      query,
      limit
    )
    return rows.map(rowToEntry)
  }
}
