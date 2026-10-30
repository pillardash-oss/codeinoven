import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing databases predate account-scoped native session ownership. */
export const threadAccountColumnMigration: SchemaMigration = {
  id: '0011-thread-account-column',
  summary: 'threads record which provider account owns their native session',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'session_account_id', 'TEXT')
  }
}
