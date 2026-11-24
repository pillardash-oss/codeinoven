import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 13: a covering index for a project's scope membership.
 *
 * Every board read checks for threads whose scope no longer exists. Without
 * this index that probe walked the project's thread rows through the listing
 * index and read each full row (context usage JSON included) just to compare
 * `scope_bucket_id`, which held the main thread for about 20 ms per board on a
 * project with a few hundred threads. `(project_id, scope_bucket_id)` answers
 * it from the index alone.
 *
 * Idempotent: `IF NOT EXISTS`, so a rerun writes nothing.
 */
export const versionThirteenMigration: DatabaseMigration = {
  version: 13,
  summary: 'index thread scope membership per project',
  apply(connection: DatabaseType): void {
    connection.exec(
      'CREATE INDEX IF NOT EXISTS idx_threads_project_scope ON threads(project_id, scope_bucket_id);'
    )
  }
}
