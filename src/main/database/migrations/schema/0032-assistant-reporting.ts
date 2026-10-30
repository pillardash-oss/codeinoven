import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant reporting columns to databases created before an assistant
 * could record where its output goes and how urgent it is. Fresh databases
 * already carry both, and the guarded `ALTER TABLE` is idempotent.
 */
export const assistantReportingMigration: SchemaMigration = {
  id: '0032-assistant-reporting',
  summary: 'assistants gain a delivery target and a priority',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'delivery', 'TEXT')
    addColumn(connection, columns, 'assistants', 'priority', 'TEXT')
  }
}
