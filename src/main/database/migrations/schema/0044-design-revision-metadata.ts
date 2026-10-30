import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Keep changed screens and named checkpoint steps beside revision metadata.
 *
 * These columns arrived after the revisions table. Existing rows keep their
 * content and timeline position, while unlabeled revisions use their usual cause.
 */
export const designRevisionMetadataMigration: SchemaMigration = {
  id: '0044-design-revision-metadata',
  summary: 'design revisions keep their changed paths and checkpoint label',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'design_revisions')
    if (columns.size === 0) return
    for (const column of ['changed_paths', 'label', 'checkpoint_entry']) {
      addColumn(connection, columns, 'design_revisions', column, 'TEXT')
    }
  }
}
