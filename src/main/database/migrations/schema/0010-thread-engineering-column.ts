import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

/**
 * Existing databases predate the durable Engineering marker on a thread. The
 * marker is set the first time a thread engages the Engineering lifecycle and
 * never cleared, so the row can draw its Engineering indicator without a
 * lifecycle round trip. Threads that already engaged engineering are
 * backfilled from the persisted lifecycle (`selection` moved off `none`, or a
 * run was ever started). `SELECT`-based, so it costs one grouped pass and is
 * idempotent on re-run.
 */
export const threadEngineeringColumnMigration: SchemaMigration = {
  id: '0010-thread-engineering-column',
  summary: 'threads gain the durable engineering marker, backfilled from the lifecycle',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    if (columns.has('engineering')) return
    connection.exec('ALTER TABLE threads ADD COLUMN engineering INTEGER NOT NULL DEFAULT 0')
    connection.exec(
      `UPDATE threads
          SET engineering = 1
        WHERE id IN (
          SELECT thread_id FROM engineering_lifecycle
           WHERE selection != 'none' OR started_at IS NOT NULL
        )`
    )
  }
}
