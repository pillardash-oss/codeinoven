import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Databases created before claim-token tagging carry a `claim_token`-less
 * snapshot queue. Add the column in place (nullable, no backfill needed:
 * unclaimed rows are NULL by definition). Idempotent and safe to re-run.
 */
export const modelRankingSnapshotClaimTokenMigration: SchemaMigration = {
  id: '0004-model-ranking-snapshot-claim-token',
  summary: 'the snapshot queue gains the claim token that tags a claimed row',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'model_ranking_snapshots')
    if (columns.size === 0) return
    addColumn(connection, columns, 'model_ranking_snapshots', 'claim_token', 'TEXT')
  }
}
