import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Existing databases predate persisted draft state: a drafting flag that keeps
 * threads being composed or dictated inside bounded listing slices, plus a
 * dedicated column holding the committed draft content.
 */
export const threadDraftColumnsMigration: SchemaMigration = {
  id: '0012-thread-draft-columns',
  summary: 'threads persist their draft flag and committed draft content',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    addColumn(connection, columns, 'threads', 'drafting', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(connection, columns, 'threads', 'draft_json', 'TEXT')
  }
}
