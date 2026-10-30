import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate the multi-select lifecycle columns.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so the columns
 * are added when missing.
 */
export const engineeringLifecycleColumnsMigration: SchemaMigration = {
  id: '0007-engineering-lifecycle-columns',
  summary: 'the engineering lifecycle gains its selected stages and autopilot switch',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'engineering_lifecycle')
    addColumn(
      connection,
      columns,
      'engineering_lifecycle',
      'selected_stages_json',
      "TEXT NOT NULL DEFAULT '[]'"
    )
    addColumn(
      connection,
      columns,
      'engineering_lifecycle',
      'autopilot',
      'INTEGER NOT NULL DEFAULT 0'
    )
  }
}
