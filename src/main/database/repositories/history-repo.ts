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

// ── Shared SQL builders and row mapping (main + worker) ───────────────────

/** Map raw `history_entries` rows to history entries. */
export function mapHistoryRows(rows: unknown[]): HistoryEntry[] {
  return rows.map((row) => rowToEntry(row as HistoryRow))
}

/** INSERT statement for one history entry. */
export function insertHistoryStatement(
  id: string,
  threadId: string,
  role: HistoryRole,
  content: string,
  metadata: Record<string, unknown> | undefined,
  sequence: number,
  timestamp: number
): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO history_entries(id, thread_id, role, content, metadata, "sequence", timestamp)
       VALUES(?,?,?,?,?,?,?)`,
    params: [id, threadId, role, content, metadata ? JSON.stringify(metadata) : null, sequence, timestamp]
  }
}

/** DELETE statement for a truncation from a sequence onward. */
export function truncateHistoryStatement(threadId: string, sequence: number): { sql: string; params: unknown[] } {
  return {
    sql: 'DELETE FROM history_entries WHERE thread_id = ? AND "sequence" >= ?',
    params: [threadId, sequence]
  }
}

/** Bounded history load (ascending sequence). */
export function buildHistoryLoadSql(
  threadId: string,
  limit?: number
): { sql: string; params: unknown[]; maxRows: number } {
  return {
    sql: `SELECT * FROM history_entries WHERE thread_id = ? ORDER BY "sequence" ASC`,
    params: [threadId],
    maxRows: limit !== undefined && limit > 0 ? Math.min(limit, 5000) : 1000
  }
}

/** Bounded recent-history load (descending sequence). */
export function buildHistoryRecentSql(threadId: string, count: number): { sql: string; params: unknown[]; maxRows: number } {
  return {
    sql: `SELECT * FROM history_entries WHERE thread_id = ? ORDER BY "sequence" DESC`,
    params: [threadId],
    maxRows: Math.max(1, Math.min(count, 5000))
  }
}

/** Bounded history FTS search. */
export function buildHistorySearchSql(
  query: string,
  projectId?: string,
  limit = 20
): { sql: string; params: unknown[]; maxRows: number } {
  const maxRows = Math.max(1, Math.min(limit, 200))
  if (projectId) {
    return {
      sql: `SELECT he.* FROM history_entries he
        JOIN threads t ON t.id = he.thread_id
        JOIN history_fts fts ON he.rowid = fts.rowid
        WHERE t.project_id = ? AND history_fts MATCH ?
        ORDER BY he."sequence" DESC`,
      params: [projectId, query],
      maxRows
    }
  }
  return {
    sql: `SELECT he.* FROM history_entries he
      JOIN history_fts fts ON he.rowid = fts.rowid
      WHERE history_fts MATCH ?
      ORDER BY he."sequence" DESC`,
    params: [query],
    maxRows
  }
}
