import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing message mirrors predate account-container attribution. */
export const agentMessageAccountColumnsMigration: SchemaMigration = {
  id: '0017-agent-message-account-columns',
  summary: 'message mirrors record the provider account that produced them',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'agent_messages')
    addColumn(connection, columns, 'agent_messages', 'account_id', 'TEXT')
    addColumn(connection, columns, 'agent_messages', 'account_label', 'TEXT')
  }
}
