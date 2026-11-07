import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 5: ghost Engineering markers are cleared.
 *
 * `threads.engineering` is the durable marker the sidebar and Toolbox read
 * without a lifecycle round trip, and it used to be set by lifecycle
 * inheritance even when the source thread had nothing to hand over: no stage
 * selected and no run ever started. Those threads read as Engineering while
 * every switch sat off, and the turn pipeline ran their messages as plain
 * conversations, so the marker promised a planning workflow that did not exist.
 *
 * The marker is genuine exactly when the thread's lifecycle row proves
 * engagement, so a thread whose row selects nothing and never started is
 * cleared back to neutral. One `UPDATE` with an indexed `NOT IN`, idempotent on
 * re-run because it only ever narrows the set.
 */
export const versionFiveMigration: DatabaseMigration = {
  version: 5,
  summary: 'ghost engineering markers are cleared from threads that never engaged',
  apply(connection: DatabaseType): void {
    connection.exec(`
UPDATE threads
   SET engineering = 0
 WHERE engineering = 1
   AND id NOT IN (
     SELECT thread_id FROM engineering_lifecycle
      WHERE selection != 'none' OR started_at IS NOT NULL
   );
`)
  }
}
