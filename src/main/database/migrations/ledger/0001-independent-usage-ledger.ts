import type { Database as DatabaseType } from 'better-sqlite3'
import { USAGE_EVENTS_COLUMNS_SQL, USAGE_EVENTS_INDEXES_SQL } from '../../schema'
import type { LedgerMigration, LedgerMigrationHost } from '../migration'
import { tableColumns } from '../migration-helpers'

/** Index the analytics reads use once the ledger carries its own project identity. */
const PROJECT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_usage_events_project
      ON usage_events(project_id, created_at, id)`

/**
 * Detach the usage ledger from mutable conversation rows. Older schemas used
 * cascading foreign keys to threads and messages, which erased analytics
 * whenever retention evicted a thread. Rebuild once, snapshot project
 * identity, and retain the text identifiers without lifecycle constraints.
 */
export const independentUsageLedgerMigration: LedgerMigration = {
  id: 'ledger-0001-independent-usage-ledger',
  summary: 'the usage ledger is rebuilt with its own project identity and no cascading keys',
  async apply(host: LedgerMigrationHost, connection: DatabaseType): Promise<void> {
    const columns = tableColumns(connection, 'usage_events')
    const foreignKeys = connection.prepare('PRAGMA foreign_key_list(usage_events)').all()
    const independent =
      columns.has('project_id') && columns.has('project_name') && foreignKeys.length === 0

    if (independent) {
      const result = await host.execute(PROJECT_INDEX_SQL, [])
      if (!result.ok) throw new Error(result.error ?? 'Could not index the usage ledger')
      return
    }

    const projectId = columns.has('project_id')
      ? 'COALESCE(legacy.project_id, threads.project_id)'
      : 'threads.project_id'
    const projectName = columns.has('project_name')
      ? 'COALESCE(legacy.project_name, projects.name)'
      : 'projects.name'

    const statements = [
      {
        sql: 'ALTER TABLE usage_events RENAME TO usage_events_legacy',
        params: []
      },
      {
        sql: `CREATE TABLE usage_events (${USAGE_EVENTS_COLUMNS_SQL})`,
        params: []
      },
      {
        sql: `INSERT INTO usage_events(
          id, thread_id, parent_turn_id, project_id, project_name,
          feature_call_id, attempt, feature,
          harness_id, account_id, provider_id, model_id, thinking_level, utility_id,
          raw_provider_usage_json,
          tokens_uncached_input, tokens_cached_input, tokens_cache_write,
          tokens_output, tokens_reasoning, tokens_total, raw_total, total_semantics,
          cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
          success, retry_cause, duration_ms, created_at
        )
        SELECT
          legacy.id, legacy.thread_id, legacy.parent_turn_id, ${projectId}, ${projectName},
          legacy.feature_call_id, legacy.attempt, legacy.feature,
          legacy.harness_id, legacy.account_id, legacy.provider_id, legacy.model_id, legacy.thinking_level,
          legacy.utility_id, legacy.raw_provider_usage_json,
          legacy.tokens_uncached_input, legacy.tokens_cached_input, legacy.tokens_cache_write,
          legacy.tokens_output, legacy.tokens_reasoning, legacy.tokens_total,
          legacy.raw_total, legacy.total_semantics,
          legacy.cost_usd, legacy.cost_status, legacy.pricing_provenance_json,
          legacy.tool_fee_usd, legacy.success, legacy.retry_cause,
          legacy.duration_ms, legacy.created_at
        FROM usage_events_legacy AS legacy
        LEFT JOIN threads ON threads.id = legacy.thread_id
        LEFT JOIN projects ON projects.id = threads.project_id
        `,
        params: []
      },
      { sql: 'DROP TABLE usage_events_legacy', params: [] },
      ...USAGE_EVENTS_INDEXES_SQL.split(';')
        .map((sql) => sql.trim())
        .filter(Boolean)
        .map((sql) => ({ sql, params: [] })),
      { sql: PROJECT_INDEX_SQL, params: [] }
    ]
    const result = await host.transaction(statements)
    if (!result.ok) throw new Error(result.error ?? 'Could not migrate the usage ledger')
  }
}
