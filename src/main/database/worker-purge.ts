import type { Database } from './database'

/**
 * Rows removed per worker statement while purging a large table.
 *
 * A user-requested "clean slate" can span tens of thousands of `usage_events`
 * rows. Deleting them in one statement would hold the worker's write
 * transaction for the whole purge and starve the maintenance loop, so the purge
 * walks the table in bounded batches instead and lets the worker serve other
 * requests between them.
 */
const PURGE_BATCH_SIZE = 2_000

/**
 * Batch ceiling for one purge. The loop already stops as soon as a batch makes
 * no progress, so this is a second, hard bound: a pathological purge terminates
 * instead of spinning forever.
 */
const PURGE_MAX_BATCHES = 1_000

/** Outcome of a batched purge: rows actually removed, or the first failure. */
export interface RowsPurged {
  ok: boolean
  /** Rows removed before the purge finished or failed. */
  deleted: number
  error?: string
}

/**
 * Delete every row matching `where` in bounded batches on the maintenance
 * worker connection, so a large purge never blocks the Electron main thread.
 *
 * `table` and `where` are repository-authored SQL fragments, never user input;
 * caller values travel as bound `params`. Both are interpolated because a
 * prepared statement cannot parameterize an identifier or a filter clause.
 *
 * The progress check re-counts after every batch, so the reported `deleted`
 * total is the real difference and a batch that changes nothing ends the loop.
 */
export async function purgeRowsViaWorker(
  db: Database,
  table: string,
  where: string,
  params: readonly unknown[]
): Promise<RowsPurged> {
  const before = await countRows(db, table, where, params)
  if (!before.ok) return { ok: false, deleted: 0, ...(before.error ? { error: before.error } : {}) }
  let remaining = before.count
  for (let batch = 0; batch < PURGE_MAX_BATCHES && remaining > 0; batch += 1) {
    const result = await db.executeViaWorker(
      `DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table} WHERE ${where} LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [...params]
    )
    if (!result.ok) {
      return {
        ok: false,
        deleted: before.count - remaining,
        ...(result.error ? { error: result.error } : {})
      }
    }
    const after = await countRows(db, table, where, params)
    if (!after.ok) {
      return {
        ok: false,
        deleted: before.count - remaining,
        ...(after.error ? { error: after.error } : {})
      }
    }
    // No progress means the remaining rows are unreachable by this filter;
    // stop rather than issue the same statement forever.
    if (after.count >= remaining) {
      return {
        ok: false,
        deleted: before.count - remaining,
        error: `${table} purge removed no rows in its last batch`
      }
    }
    remaining = after.count
  }
  return { ok: true, deleted: before.count - remaining }
}

/** Count matching rows on the worker connection, with the shared primary fallback. */
async function countRows(
  db: Database,
  table: string,
  where: string,
  params: readonly unknown[]
): Promise<{ ok: boolean; count: number; error?: string }> {
  const result = await db.queryViaWorker(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`,
    [...params],
    1
  )
  if (!result.ok) return { ok: false, count: 0, ...(result.error ? { error: result.error } : {}) }
  const value = result.rows[0]?.['count']
  return { ok: true, count: typeof value === 'number' ? value : 0 }
}
