import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'

/**
 * Historical rows reached `pinned = 1` with a NULL `pinned_at`: the thread
 * upsert pins through a conflict path that never refreshes the pin timestamp,
 * and Assignment activation used to pin its coordinator without one. A NULL
 * pin time sorts last in the Pinned slice, so backfill it from the row's last
 * write. Idempotent: the predicate stops matching once every pinned row has a
 * timestamp. Databases without the column are left untouched.
 */
export const threadPinnedAtMigration: SchemaMigration = {
  id: '0026-thread-pinned-at',
  summary: 'pinned threads without a pin timestamp are stamped from their last write',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'threads')
    if (!columns.has('pinned_at')) return
    connection
      .prepare(
        `UPDATE threads
            SET pinned_at = COALESCE(updated_at, last_activity, created_at)
          WHERE pinned = 1 AND pinned_at IS NULL`
      )
      .run()
  }
}
