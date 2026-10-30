import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing databases predate the in-flight turn owner recorded for cross-instance recovery. */
export const activeTurnOwnerColumnMigration: SchemaMigration = {
  id: '0023-active-turn-owner-column',
  summary: 'active turns record the process id that owns them',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'active_turns')
    if (columns.size === 0) return
    addColumn(connection, columns, 'active_turns', 'owner_pid', 'INTEGER')
  }
}
