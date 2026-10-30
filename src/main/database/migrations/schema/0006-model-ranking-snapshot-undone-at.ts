import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Databases created before the undo flag carry a snapshot queue with no
 * `undone_at_ms` column. Add it in place; existing rows read as `null`, which
 * is exactly "not undone". Idempotent and safe to re-run.
 */
export const modelRankingSnapshotUndoneAtMigration: SchemaMigration = {
  id: '0006-model-ranking-snapshot-undone-at',
  summary: 'the snapshot queue gains the timestamp that marks a scored row undone',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'model_ranking_snapshots')
    if (columns.size === 0) return
    addColumn(connection, columns, 'model_ranking_snapshots', 'undone_at_ms', 'INTEGER')
  }
}
