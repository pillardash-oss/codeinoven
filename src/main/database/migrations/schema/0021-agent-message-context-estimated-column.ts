import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing message mirrors predate estimated-occupancy provenance; without the
 * flag a reloaded estimate masquerades as a provider-reported reading.
 */
export const agentMessageContextEstimatedColumnMigration: SchemaMigration = {
  id: '0021-agent-message-context-estimated-column',
  summary: 'message mirrors mark a context reading that was estimated, not reported',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'context_estimated', 'INTEGER')
  }
}
