import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 12: the model ranking stores are gone.
 *
 * Graded "best model" ranking left the app, so the two tables behind it stop
 * shipping: `model_rankings` held the running per-model score sums, and
 * `model_ranking_snapshots` held the transient grading queue. Neither has a
 * reader or a writer left, and a database that keeps them keeps dead rows
 * forever, so this drops them.
 *
 * Indexes are dropped with their table, so no separate `DROP INDEX` is needed.
 * `model_ranking_snapshots` referenced `threads` with `ON DELETE SET NULL`,
 * which is the child side of the relation and never touched a thread row, so
 * dropping it leaves every other table exactly as it was.
 *
 * Idempotent: both statements are `IF EXISTS`, so a rerun, or a database that
 * never had the tables, writes nothing.
 */
export const versionTwelveMigration: DatabaseMigration = {
  version: 12,
  summary: 'drop the model ranking stores',
  apply(connection: DatabaseType): void {
    connection.exec(`
      DROP TABLE IF EXISTS model_ranking_snapshots;
      DROP TABLE IF EXISTS model_rankings;
    `)
  }
}
