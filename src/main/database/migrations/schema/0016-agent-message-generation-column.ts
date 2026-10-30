import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate the per-message generation duration used by
 * tokens-per-second rates. Nullable: messages persisted before the column have
 * no generation window recorded and fall back to wall-clock rates.
 */
export const agentMessageGenerationColumnMigration: SchemaMigration = {
  id: '0016-agent-message-generation-column',
  summary: 'message mirrors record how long a response took to generate',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'generation_ms', 'INTEGER')
  }
}
