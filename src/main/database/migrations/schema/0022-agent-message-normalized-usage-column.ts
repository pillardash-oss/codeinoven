import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Message mirrors predate the canonical usage payload. Without the column a
 * reloaded message loses the provider's own categories and raw evidence, so
 * sub-agent turns (and any reconciliation after a restart) would have to be
 * recorded from the aggregate alone.
 */
export const agentMessageNormalizedUsageColumnMigration: SchemaMigration = {
  id: '0022-agent-message-normalized-usage-column',
  summary: 'message mirrors keep the canonical normalized usage payload',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'normalized_usage_json', 'TEXT')
  }
}
