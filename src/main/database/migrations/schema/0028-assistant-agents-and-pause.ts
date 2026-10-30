import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant model-set and pause columns to databases created before an
 * assistant could carry a primary/fallback model set or be paused. Fresh
 * databases already carry both, and the guarded `ALTER TABLE` is idempotent.
 */
export const assistantAgentsAndPauseMigration: SchemaMigration = {
  id: '0028-assistant-agents-and-pause',
  summary: 'assistants gain their model set and pause switch',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'agents', 'TEXT')
    addColumn(connection, columns, 'assistants', 'paused', 'INTEGER NOT NULL DEFAULT 0')
  }
}
