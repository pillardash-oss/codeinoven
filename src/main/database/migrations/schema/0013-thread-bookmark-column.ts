import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Existing databases predate the bookmark marker on a thread row. */
export const threadBookmarkColumnMigration: SchemaMigration = {
  id: '0013-thread-bookmark-column',
  summary: 'threads gain the bookmarked marker',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'bookmarked', 'INTEGER NOT NULL DEFAULT 0')
  }
}
