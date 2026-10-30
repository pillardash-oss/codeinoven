import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'

/** Remove the obsolete required name column while preserving saved SVGs. */
export const customIconLibraryMigration: SchemaMigration = {
  id: '0037-custom-icon-library',
  summary: 'the custom icon library drops its obsolete required name column',
  apply(connection: DatabaseType): void {
    const columns = connection.prepare('PRAGMA table_info(custom_icons)').all() as Array<{
      name: string
      notnull: number
    }>
    if (!columns.some((column) => column.name === 'name' && column.notnull === 1)) return

    connection.exec(`
      CREATE TABLE custom_icons_without_name (
        id TEXT PRIMARY KEY NOT NULL,
        svg TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO custom_icons_without_name(id, svg, created_at)
        SELECT id, svg, created_at FROM custom_icons;
      DROP TABLE custom_icons;
      ALTER TABLE custom_icons_without_name RENAME TO custom_icons;
    `)
  }
}
