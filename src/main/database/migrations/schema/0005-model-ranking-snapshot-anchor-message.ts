import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Databases created before the anchor tag carry an `anchor_message_id`-less
 * snapshot queue. Add the column in place and point each still-open row at
 * the same visible user message the capture path would resolve today: the
 * thread's most recent user-origin message. Without the backfill a queued row
 * would treat its next turn as a follow-up and keep the pre-fix behaviour for
 * one more exchange. Rows whose thread is gone (or that are already closed)
 * keep a null anchor, which reads as "unknown". Idempotent and safe to
 * re-run.
 */
export const modelRankingSnapshotAnchorMessageMigration: SchemaMigration = {
  id: '0005-model-ranking-snapshot-anchor-message',
  summary: 'the snapshot queue gains the anchor message each open row was captured against',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'model_ranking_snapshots')
    if (columns.size === 0 || columns.has('anchor_message_id')) return
    addColumn(connection, columns, 'model_ranking_snapshots', 'anchor_message_id', 'TEXT')
    connection
      .prepare(
        `UPDATE model_ranking_snapshots
         SET anchor_message_id = (
           SELECT candidate.id FROM agent_messages candidate
           WHERE candidate.thread_id = model_ranking_snapshots.thread_id
             AND candidate.role = 'user' AND candidate.origin = 'user'
           ORDER BY candidate.created_at DESC, candidate.id DESC
           LIMIT 1
         )
         WHERE closed_at_ms IS NULL`
      )
      .run()
  }
}
