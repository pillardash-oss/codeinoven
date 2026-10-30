import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { addColumn, tableColumns } from '../migration-helpers'

/**
 * Add the assistant schedule-anchor column to databases created before the
 * scheduler could tell a real missed fire from a slot that predates the
 * schedule. Fresh databases already carry it, and the guarded `ALTER TABLE`
 * is idempotent.
 *
 * The backfill stamps each scheduled assistant from its knowledge write time,
 * which is when the authoring flow set the schedule alongside the knowledge,
 * falling back to the assistant's creation. Without it an existing schedule
 * would look active since the epoch, and a slot that came due before the
 * assistant existed would read as missed.
 */
export const assistantScheduleAnchorMigration: SchemaMigration = {
  id: '0038-assistant-schedule-anchor',
  summary: 'scheduled assistants record when their schedule last changed',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'assistants')
    addColumn(connection, columns, 'assistants', 'schedule_updated_at', 'INTEGER')
    connection
      .prepare(
        `UPDATE assistants
            SET schedule_updated_at = COALESCE(knowledge_updated_at, created_at)
          WHERE schedule IS NOT NULL AND schedule_updated_at IS NULL`
      )
      .run()
  }
}
