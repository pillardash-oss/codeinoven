import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant schedule-enable column to databases created before an
 * assistant could be unscheduled. On by default, so every existing assistant
 * keeps firing. Fresh databases already carry it, and the guarded
 * `ALTER TABLE` is idempotent.
 */
export const assistantScheduledMigration: SchemaMigration = {
  id: '0040-assistant-scheduled',
  summary: 'assistants gain the switch that takes them off the clock',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'scheduled', 'INTEGER NOT NULL DEFAULT 1')
  }
}
