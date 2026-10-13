import type { Database as DatabaseType } from 'better-sqlite3'

/** `db_meta` key: '1' once existing folders' creators are backfilled. */
export const DESIGN_ORIGINS_BACKFILL_KEY = 'design_origins_backfilled'

/**
 * Give folders written before origin recording existed a creator.
 *
 * Origin recording starts at the release that added it, so a folder already on
 * disk has no `design_origins` row. The nearest record the app kept is
 * `thread_designs`, where a thread's row names the folder it was showing when the
 * row was last written. The earliest such row for a folder is the thread that
 * created it, whenever that thread has not since moved to another folder; a folder
 * whose creator already moved on is left with no origin rather than a wrong one,
 * because a wrong creator would send the user to a thread that never wrote the
 * design.
 *
 * Runs once: the `db_meta` marker keeps the grouped scan off every later startup.
 * Idempotent even without the marker, because the insert ignores folders that
 * already have an origin.
 */
export function backfillDesignOrigins(connection: DatabaseType): void {
  const meta = connection.prepare('SELECT value FROM db_meta WHERE key = ?').get(
    DESIGN_ORIGINS_BACKFILL_KEY
  ) as { value: string } | undefined
  if (meta?.value === '1') return
  connection.exec(`
    INSERT OR IGNORE INTO design_origins (project_id, directory, thread_id, created_at)
    SELECT folders.project_id,
           folders.directory,
           (SELECT pick.thread_id
              FROM thread_designs AS pick
             WHERE pick.project_id = folders.project_id
               AND pick.directory = folders.directory
             ORDER BY pick.updated_at ASC, pick.thread_id ASC
             LIMIT 1),
           folders.first_at
      FROM (SELECT project_id, directory, MIN(updated_at) AS first_at
              FROM thread_designs
             GROUP BY project_id, directory) AS folders
  `)
  connection
    .prepare('INSERT OR REPLACE INTO db_meta(key, value) VALUES(?, ?)')
    .run(DESIGN_ORIGINS_BACKFILL_KEY, '1')
}
