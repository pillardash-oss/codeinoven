import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing transcript mirrors predate per-turn Oven attribution. */
export const agentMessageOvenColumnMigration: SchemaMigration = {
  id: '0018-agent-message-oven-column',
  summary: 'message mirrors record which Oven served the turn',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'oven_id', 'TEXT')
  }
}
