import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing transcript mirrors predate the per-Oven appearance stored beside a turn. */
export const agentMessageOvenAppearanceColumnMigration: SchemaMigration = {
  id: '0020-agent-message-oven-appearance-column',
  summary: 'message mirrors keep the appearance their Oven was drawn with',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'oven_appearance_json', 'TEXT')
  }
}
