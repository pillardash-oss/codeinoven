import type { Database as DatabaseType } from 'better-sqlite3'
import type { DatabaseMigration } from './migration'
import { workerReportsToCoordinator } from '../../../lib/types'
import type { ThreadSettings } from '../../../lib/types'

/**
 * Schema version 16: only the worker the user works with directly carries unread.
 *
 * A worker settles its own run like any thread, so it used to leave `read = 0`
 * behind when it finished. On a reporting worker that was wrong twice over: the
 * task went back to the Sr. Engineer, so the Assignment lifecycle (reported,
 * auditing, rework) is the indicator, and the flag then held the coordinator's
 * row open as an unread dot nobody asked for.
 *
 * A worker the user switched reporting off for is the exception: the user works
 * with that one directly, so its finished work is theirs to read. It keeps its
 * unread mark, and it rolls up onto the Sr. Engineer's row.
 *
 * Reporting workers, auditors and pawns no longer track a read state at all
 * (`threadTracksReadStatus`), and the settle paths stop writing one. This repair
 * clears the flag already stored on those rows, so the immunity an unread row
 * carries (automatic cleanup skips it) expires with the behaviour that set it.
 *
 * Read row by row: whether a worker reports lives in its settings JSON, and the
 * row-level predicate is the shared one rather than a SQL approximation of it.
 */
export const versionSixteenMigration: DatabaseMigration = {
  version: 16,
  summary: 'clear the unread mark every silent orchestration child left behind',
  apply(connection: DatabaseType): void {
    const rows = connection
      .prepare(
        `SELECT id, settings, assignment_role, achievement_role, assignment_id, coordinator_thread_id
           FROM threads
          WHERE read = 0`
      )
      .all() as Array<{
      id: string
      settings: string | null
      assignment_role: string | null
      achievement_role: string | null
      assignment_id: string | null
      coordinator_thread_id: string | null
    }>
    if (rows.length === 0) return
    const clear = connection.prepare('UPDATE threads SET read = 1 WHERE id = ?')
    const repair = connection.transaction((): void => {
      for (const row of rows) {
        const isChild =
          row.achievement_role === 'auditor' ||
          row.assignment_role === 'worker' ||
          row.assignment_id !== null ||
          row.coordinator_thread_id !== null
        if (!isChild) continue
        if (row.assignment_role === 'worker') {
          let settings: ThreadSettings | undefined
          try {
            settings = row.settings ? (JSON.parse(row.settings) as ThreadSettings) : undefined
          } catch {
            // Unreadable settings keep the worker in the set that publishes: a
            // row we cannot read is left exactly as it is rather than guessed at.
            continue
          }
          if (!workerReportsToCoordinator(settings)) continue
        }
        clear.run(row.id)
      }
    })
    repair()
  }
}
