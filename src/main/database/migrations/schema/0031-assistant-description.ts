import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant description column to databases created before an assistant
 * could carry the user's own note about what it is for. Fresh databases
 * already carry it, and the guarded `ALTER TABLE` is idempotent.
 */
export const assistantDescriptionMigration: SchemaMigration = {
  id: '0031-assistant-description',
  summary: 'assistants gain the description their owner writes',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'description', 'TEXT')
  }
}
