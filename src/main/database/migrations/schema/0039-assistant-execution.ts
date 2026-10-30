import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant execution-target column to databases created before an
 * assistant could name an Oven its runs execute on. Fresh databases already
 * carry it, and the guarded `ALTER TABLE` is idempotent. An existing assistant
 * keeps the column NULL, which means this computer.
 */
export const assistantExecutionMigration: SchemaMigration = {
  id: '0039-assistant-execution',
  summary: 'assistants name the Oven their runs execute on',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'execution', 'TEXT')
  }
}
