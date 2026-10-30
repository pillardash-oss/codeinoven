import type { Database as DatabaseType } from 'better-sqlite3'
import { USAGE_EVENT_FEATURES } from '../../../../lib/types/usage'
import { Logger } from '../../../system/logger'
import { USAGE_EVENTS_COLUMNS_SQL, USAGE_EVENTS_INDEXES_SQL } from '../../schema'
import type { LedgerMigration, LedgerMigrationHost } from '../migration'
import { parseColumnNames, tableColumns, tableSql } from '../migration-helpers'

/**
 * Rebuild the usage ledger when its CHECK constraint predates a feature value
 * CodeInOven now records (sub-agent and ephemeral work). The CHECK is part of
 * the table SQL, so SQLite rejects a new value inside an old constraint; the
 * ledger write catches and dev-logs that rejection, which would silently drop
 * the row. Detecting the missing value in the stored SQL and rebuilding the
 * table keeps every recorded turn admissible.
 */
export const usageEventFeaturesMigration: LedgerMigration = {
  id: 'ledger-0002-usage-event-features',
  summary: 'the usage ledger CHECK accepts every feature value this build records',
  async apply(host: LedgerMigrationHost, connection: DatabaseType): Promise<void> {
    const stored = tableSql(connection, 'usage_events')
    if (!stored) return
    const missing = USAGE_EVENT_FEATURES.filter((feature) => !stored.includes(`'${feature}'`))
    if (missing.length === 0) return

    const legacyColumns = tableColumns(connection, 'usage_events')
    const targetColumns = parseColumnNames(USAGE_EVENTS_COLUMNS_SQL)
    const carried = targetColumns.filter((column) => legacyColumns.has(column) && column !== 'id')
    const columnList = ['id', ...carried].join(', ')
    const projectIndex = `CREATE INDEX IF NOT EXISTS idx_usage_events_project
      ON usage_events(project_id, created_at, id)`
    const result = await host.transaction([
      { sql: 'ALTER TABLE usage_events RENAME TO usage_events_feature_legacy', params: [] },
      { sql: `CREATE TABLE usage_events (${USAGE_EVENTS_COLUMNS_SQL})`, params: [] },
      {
        sql: `INSERT INTO usage_events(${columnList})
        SELECT ${columnList}
        FROM usage_events_feature_legacy`,
        params: []
      },
      { sql: 'DROP TABLE usage_events_feature_legacy', params: [] },
      ...USAGE_EVENTS_INDEXES_SQL.split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => ({ sql, params: [] })),
      { sql: projectIndex, params: [] }
    ])
    if (!result.ok) {
      throw new Error(result.error ?? 'Could not migrate the usage event feature values')
    }
    Logger.info('Usage ledger rebuilt for new feature values', {
      features: missing.join(',')
    })
  }
}
