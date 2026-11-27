import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'

/**
 * Schema version 16: no orchestration child carries an unread mark.
 *
 * A worker, auditor or pawn settles its own run like any thread, so it used to
 * leave `read = 0` behind when it finished. A non-reporting worker held its
 * coordinator's row open through that flag, which is how finishing a worker put
 * an unread dot on an Assignment thread and on the rail.
 *
 * Children no longer track a read state at all (`threadTracksReadStatus`), and
 * the settle paths stop writing one. This repair clears the flag already stored
 * on those rows, so the immunity an unread row carries (automatic cleanup skips
 * it) expires with the behaviour that set it.
 *
 * Scoped by the child role columns rather than by title: a row that is not an
 * orchestration child is untouched whatever it is called.
 */
export const versionSixteenMigration: DatabaseMigration = {
  version: 16,
  summary: 'clear the unread mark orchestration children never show',
  apply(connection: DatabaseType): void {
    connection.exec(`
      UPDATE threads
         SET read = 1
       WHERE read = 0
         AND (
           achievement_role = 'auditor'
           OR assignment_role = 'worker'
           OR assignment_id IS NOT NULL
           OR coordinator_thread_id IS NOT NULL
         )
    `)
  }
}
