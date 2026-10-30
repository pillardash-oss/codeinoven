import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing transcript mirrors predate the display label of the Oven that served them. */
export const agentMessageOvenLabelColumnMigration: SchemaMigration = {
  id: '0019-agent-message-oven-label-column',
  summary: 'message mirrors record the display label of their Oven',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'oven_label', 'TEXT')
  }
}
