import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant pin columns to databases created before assistants could be
 * pinned, then backfill a pin timestamp for any pinned row (matching the
 * thread pin behaviour). Fresh databases already carry both columns, and the
 * guarded `ALTER TABLE` makes this idempotent.
 */
export const assistantPinnedMigration: SchemaMigration = {
  id: '0027-assistant-pinned',
  summary: 'assistants gain the pin switch and its timestamp',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    addColumn(connection, columns, 'assistants', 'pinned_at', 'INTEGER')
    connection
      .prepare(
        `UPDATE assistants
            SET pinned_at = COALESCE(updated_at, created_at)
          WHERE pinned = 1 AND pinned_at IS NULL`
      )
      .run()
  }
}
