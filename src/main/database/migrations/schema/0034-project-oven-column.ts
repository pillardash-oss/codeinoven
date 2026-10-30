import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * A project created for a remote Oven records that Oven's registry id, so its
 * chats can seed their own Oven binding. Databases from before Oven projects
 * have no such column and read back as unbound, which is the local default.
 */
export const projectOvenColumnMigration: SchemaMigration = {
  id: '0034-project-oven-column',
  summary: 'projects record the remote Oven they were created for',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'projects')
    if (columns.size === 0) return
    addColumn(connection, columns, 'projects', 'oven_id', 'TEXT')
  }
}
