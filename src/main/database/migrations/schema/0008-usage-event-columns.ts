import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate the append-only usage snapshot fields.
 *
 * `tokens_total` and `duration_ms` are added and then backfilled, because a
 * zero in either column reads as a real measurement: the total is the sum of
 * the categories when the provider did not report one, and the duration is the
 * turn's own completion window.
 */
export const usageEventColumnsMigration: SchemaMigration = {
  id: '0008-usage-event-columns',
  summary: 'the usage ledger gains account attribution, token totals and turn duration',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'usage_events')
    const addedTokensTotal = !columns.has('tokens_total')
    const addedDuration = !columns.has('duration_ms')

    addColumn(connection, columns, 'usage_events', 'account_id', 'TEXT')

    if (addedTokensTotal) {
      connection.exec('ALTER TABLE usage_events ADD COLUMN tokens_total INTEGER')
    }
    if (addedDuration) {
      connection.exec(
        'ALTER TABLE usage_events ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(duration_ms >= 0)'
      )
    }

    if (addedTokensTotal) {
      connection.exec(`
        UPDATE usage_events
        SET tokens_total = COALESCE(
          raw_total,
          COALESCE(tokens_uncached_input, 0) +
            COALESCE(tokens_cached_input, 0) +
            COALESCE(tokens_cache_write, 0) +
            COALESCE(tokens_output, 0) +
            COALESCE(tokens_reasoning, 0)
        )
        WHERE tokens_total IS NULL
      `)
    }

    if (addedDuration) {
      connection.exec(`
        UPDATE usage_events
        SET duration_ms = MAX(
          0,
          COALESCE(
            (
              SELECT completed_at - created_at
              FROM agent_messages
              WHERE agent_messages.id = usage_events.parent_turn_id
            ),
            0
          )
        )
        WHERE duration_ms = 0
      `)
    }
  }
}
