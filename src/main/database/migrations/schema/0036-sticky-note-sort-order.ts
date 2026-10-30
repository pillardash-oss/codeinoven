import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

/**
 * Add the tab-strip order the sticky notes rail reorders by. Databases that
 * predate it read as all-zero, which sorts by `created_at` exactly as before;
 * the backfill seeds each row from that same order so the first drag starts
 * from what the user already sees. Idempotent: the predicate stops matching
 * once the column exists.
 *
 * The index is created here rather than in the schema block: a database that
 * predates the column would fail to create it before this migration added it,
 * so the schema runs first and the index must follow the column.
 */
export const stickyNoteSortOrderMigration: SchemaMigration = {
  id: '0036-sticky-note-sort-order',
  summary: 'sticky notes gain the sort order the rail reorders by, seeded from creation',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'sticky_notes')
    if (columns.size > 0 && !columns.has('sort_order')) {
      connection.exec('ALTER TABLE sticky_notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      connection.exec(`
        UPDATE sticky_notes SET sort_order = (
          SELECT COUNT(*) FROM sticky_notes AS earlier
          WHERE earlier.created_at < sticky_notes.created_at
             OR (earlier.created_at = sticky_notes.created_at AND earlier.rowid < sticky_notes.rowid)
        )
      `)
    }
    connection.exec('CREATE INDEX IF NOT EXISTS idx_sticky_notes_sort ON sticky_notes(sort_order)')
  }
}
