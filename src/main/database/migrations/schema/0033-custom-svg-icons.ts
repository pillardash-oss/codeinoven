import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/** Databases created before projects and assistants could carry a custom SVG icon. */
export const customSvgIconsMigration: SchemaMigration = {
  id: '0033-custom-svg-icons',
  summary: 'projects and assistants gain their custom SVG icon',
  apply(connection: DatabaseType): void {
    for (const table of ['projects', 'assistants'] as const) {
      const columns = tableColumns(connection, table)
      addColumn(connection, columns, table, 'custom_svg', 'TEXT')
    }
  }
}
