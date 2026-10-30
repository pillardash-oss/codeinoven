import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Databases created before sticky notes could hold an image below their text. */
export const stickyNoteImagePathMigration: SchemaMigration = {
  id: '0035-sticky-note-image-path',
  summary: 'sticky notes gain the path of the image attached to them',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'sticky_notes')
    if (columns.size === 0) return
    addColumn(connection, columns, 'sticky_notes', 'image_path', 'TEXT')
  }
}
