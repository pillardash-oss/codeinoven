import type { Database } from '../../database/database'
import { CheckpointManager } from '../checkpoint-manager'
import { Logger } from '../../system/logger'

/**
 * Checkpoint work that runs once the window has painted.
 *
 * Every pass here reads `turn_checkpoints`, whose rows carry the full file-change
 * JSON of a turn: on a long-lived install that is hundreds of megabytes. The
 * database worker runs one job at a time, so a pass that parses all of it holds
 * every read queued behind it, such as the scope board the user just opened.
 * This module keeps those passes cheap: the one hot lookup gets an index, and
 * the one-time repairs stop scanning once they have nothing left to repair.
 */

/**
 * The checkpoint lookups that run on every launch or every turn completion,
 * each with the index that lets it read a handful of rows instead of parsing
 * every checkpoint:
 *
 * - restart recovery finds turns still marked active;
 * - a finishing turn finds the files other threads in its project completed
 *   since it started.
 */
const CHECKPOINT_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_active_created
     ON turn_checkpoints(json_extract(data, '$.createdAt'))
     WHERE json_extract(data, '$.status') = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_turn_checkpoints_project_completed
     ON turn_checkpoints(project_id, json_extract(data, '$.completedAt'))`
] as const

/**
 * Build the checkpoint indexes on the worker, never in the startup schema: the
 * first build parses every checkpoint once, which on a large install takes
 * seconds, and the schema runs on the Electron main thread. Every later launch
 * finds them in place and pays nothing.
 */
export async function prepareCheckpointIndexes(database: Database): Promise<void> {
  for (const sql of CHECKPOINT_INDEXES) {
    const result = await database.executeViaWorker(sql, [], { allowPrimaryFallback: false })
    if (!result.ok) Logger.error('Checkpoint index could not be built (non-fatal)', result.error)
  }
}

interface OneTimeRepair {
  /** Settings key recording that the pass has nothing left to do. Bump the
   *  version suffix when a pass changes, so it runs again over old data. */
  key: string
  run: (manager: CheckpointManager) => Promise<number>
  repairedMessage: (count: number) => string
  failureMessage: string
}

/**
 * Legacy repairs for checkpoints written by older builds. New turns never
 * produce these defects, so once a pass reports zero candidates it is recorded
 * as done and skipped on later launches instead of rescanning every checkpoint.
 * The order is fixed and the passes never overlap: each writes the same tables.
 */
const ONE_TIME_REPAIRS: readonly OneTimeRepair[] = [
  {
    // File-change cards whose line counts were recorded as truncated by the
    // previous whole-file gating (large files with small edits showed +0 −0).
    key: 'maintenance.checkpoint.line-stats.v1',
    run: (manager) => manager.repairTruncatedLineStats(),
    repairedMessage: (count) => `Restored line counts for ${count} file-change checkpoints`,
    failureMessage: 'Line-stats repair failed (non-fatal):'
  },
  {
    // Cards misattributed to hidden internal prompts by turns that ran before
    // internal attribution existed.
    key: 'maintenance.checkpoint.internal-attribution.v1',
    run: (manager) => manager.repairMisattributedInternalCheckpoints(),
    repairedMessage: (count) => `Reattributed ${count} internal-turn file-change checkpoints`,
    failureMessage: 'Internal-attribution repair failed (non-fatal):'
  },
  {
    // Cards that only hold another turn's abandoned work.
    key: 'maintenance.checkpoint.unproven-overlap.v1',
    run: (manager) => manager.dropUnprovenOverlappingChanges(),
    repairedMessage: (count) => `Cleared ${count} file-change checkpoints of unproven work`,
    failureMessage: 'Unproven-change repair failed (non-fatal):'
  },
  {
    // Cards that listed the app's scratch folder or build output as the work.
    key: 'maintenance.checkpoint.excluded-paths.v1',
    run: (manager) => manager.dropExcludedPathChanges(),
    repairedMessage: (count) => `Dropped scratch paths from ${count} file-change checkpoints`,
    failureMessage: 'Excluded-path repair failed (non-fatal):'
  },
  {
    // Cards that recorded nothing while the turn did write files.
    key: 'maintenance.checkpoint.evidence-dropped.v1',
    run: (manager) => manager.repairEvidenceDroppedCheckpoints(),
    repairedMessage: (count) => `Restored files for ${count} empty file-change checkpoints`,
    failureMessage: 'Evidence repair failed (non-fatal):'
  }
]

async function isDone(database: Database, key: string): Promise<boolean> {
  const result = await database.queryViaWorker('SELECT value FROM settings WHERE key = ?', [key], 1)
  return result.ok && result.rows[0]?.['value'] === 'done'
}

async function markDone(database: Database, key: string): Promise<void> {
  const result = await database.executeViaWorker(
    `INSERT INTO settings(key, value) VALUES(?, 'done')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key],
    { allowPrimaryFallback: false }
  )
  if (!result.ok) Logger.error('Checkpoint repair marker could not be saved', result.error)
}

/** Run each legacy repair that has not yet finished, in order. */
export async function runOneTimeCheckpointRepairs(database: Database): Promise<void> {
  const manager = new CheckpointManager(database)
  for (const repair of ONE_TIME_REPAIRS) {
    try {
      if (await isDone(database, repair.key)) continue
      const repaired = await repair.run(manager)
      if (repaired > 0) {
        Logger.info(repair.repairedMessage(repaired))
      } else {
        await markDone(database, repair.key)
      }
    } catch (error) {
      Logger.error(repair.failureMessage, error)
    }
  }
}

/** Wall-clock ceiling for one launch's trimming, so a large backlog drains in
 *  the background without ever holding the app. */
const HISTORICAL_MAP_LAUNCH_BUDGET_MS = 60_000

/** Passes one launch may run; each rewrites a bounded batch. */
const HISTORICAL_MAP_MAX_PASSES = 40

/** Pages one reclaim step hands back, and how many steps one launch runs. */
const RECLAIM_PAGES_PER_STEP = 2_048
const RECLAIM_MAX_STEPS = 60
const RECLAIM_STEP_GAP_MS = 150

/**
 * Shrink the checkpoint table without holding the launch.
 *
 * Each pass rewrites a bounded batch and yields between passes, so the database
 * worker stays free for the reads the window needs. A large backlog used to
 * drain over many launches, which left the table hundreds of megabytes and every
 * read on it seconds slow until it caught up, so one launch now drains it inside
 * a time budget instead.
 */
export async function trimHistoricalCheckpointMapsOnLaunch(database: Database): Promise<number> {
  const manager = new CheckpointManager(database)
  let total = 0
  const startedAt = Date.now()
  for (let pass = 0; pass < HISTORICAL_MAP_MAX_PASSES; pass += 1) {
    const trimmed = await manager.trimHistoricalCheckpointMaps()
    total += trimmed
    if (trimmed === 0) break
    if (Date.now() - startedAt >= HISTORICAL_MAP_LAUNCH_BUDGET_MS) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  if (total > 0) {
    Logger.info('Trimmed historical checkpoint maps', { rows: total })
    // The rows are small now, but the pages they used are still in the file. The
    // reclaim is bounded and off the main thread, and whatever is left over is
    // picked up by the next launch.
    await reclaimFreedPages(database)
  }
  return total
}

/** Hand the pages the trim freed back to the filesystem, a bounded step at a time. */
async function reclaimFreedPages(database: Database): Promise<void> {
  let reclaimed = 0
  for (let step = 0; step < RECLAIM_MAX_STEPS; step += 1) {
    const result = await database.incrementalVacuum(RECLAIM_PAGES_PER_STEP)
    if (!result.ok) {
      Logger.dev('Database space reclaim stopped early', { error: result.error ?? '' })
      break
    }
    const freed = result.freedPages ?? 0
    reclaimed += freed
    if (freed === 0) break
    await new Promise((resolve) => setTimeout(resolve, RECLAIM_STEP_GAP_MS))
  }
  if (reclaimed > 0)
    Logger.info('Reclaimed database pages left by trimmed checkpoints', { reclaimed })
}
