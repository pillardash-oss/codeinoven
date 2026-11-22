/**
 * Close out the children an orchestration left behind.
 *
 * A coordinator's workers and pawns are threads of their own, but nobody ever
 * sees them as threads: the rail folds them into the coordinator's row and never
 * lists them, so their status exists only to drive that row and to tell the
 * orchestration board what a task is doing. That is fine while the coordinator
 * runs, and it is a leak the moment the coordinator stops: a worker left
 * `working-paused` on a retry that will never be answered, or parked on a gate
 * nobody can open any more, keeps its row in whatever state it had.
 *
 * Those rows are not harmless. The menu bar attention predicate read them as live
 * problems, so the icon carried its exclamation permanently, with no error
 * anywhere on screen and no action that could clear it; a paused child also kept
 * its retry armed, so a completed orchestration could wake a worker on the next
 * quota reset and run a turn no task was waiting for. Both are the same defect:
 * a child outliving the coordinator that owned it.
 *
 * This module is the writer that ends them. {@link settleAbandonedCoordinatorChildren}
 * is idempotent and cheap enough to run on any thread update, so
 * {@link startCoordinatorChildSettleSweep} simply watches the thread corpus and
 * sweeps whenever something changed, and the boot's repair sequence runs one pass
 * for rows stranded by a previous launch. Nothing here is a status the UI has to
 * learn about: an abandoned child settles as `interrupted`, which is what
 * `stopAssignmentThread` and boot recovery already write for work that ended
 * rather than finished, and its read flag is cleared so the coordinator's row
 * stops holding an unread dot for a child the user cannot open.
 */

import { SETTLED_THREAD_STATUSES } from '../../lib/thread-status-policy'
import type { ThreadStatus } from '../../lib/types'
import { Logger } from '../system/logger'
import { subscribeThreadCorpus } from './thread-events'
import type { Database } from '../database/database'
import type { ThreadManager } from '../../lib/engines/thread-manager'

/**
 * The statuses this sweep may rewrite: every state a child can be left parked
 * in when the coordinator that would have resumed it is gone, plus an unread
 * failure, which is already settled but still claims the user's attention.
 *
 * A `planning` or `executing` child is deliberately absent: that run is still
 * producing work, it is the process's reason to stay alive, and it settles
 * itself. `completed`, `failed` (read) and `interrupted` children need nothing.
 */
const ABANDONED_CHILD_STATUSES: readonly ThreadStatus[] = [
  'created',
  'spec',
  'awaiting_approval',
  'working-paused'
]

/** How many children one pass may close out, so a broken sweep stays bounded. */
const MAX_CHILDREN_PER_PASS = 200

/**
 * How long corpus notifications are coalesced before a pass.
 *
 * A settle writes several rows in a row (the coordinator, its `last_activity`
 * trigger, each child), and every write re-announces the coordinator that owns
 * it. Waiting for the burst to finish means one pass sees the final state
 * instead of one pass per write.
 */
const SETTLE_SWEEP_DEBOUNCE_MS = 250

export interface CoordinatorChildSettleHost {
  database: Database
  threadManager: ThreadManager
  /**
   * Drop a child's armed retry and its power-wake window. Injected rather than
   * imported so this module stays free of the scheduler and of the services the
   * event bus pulls in.
   */
  clearRetry: (sessionId: string) => void
}

/** The statuses a coordinator settles into, quoted for the SQL below. */
const SETTLED_SQL = SETTLED_THREAD_STATUSES.map((status) => `'${status}'`).join(', ')
const ABANDONED_SQL = ABANDONED_CHILD_STATUSES.map((status) => `'${status}'`).join(', ')

/**
 * Which children count as stranded.
 *
 * A child is stranded when nothing can resume it and no surface shows it: its
 * coordinator settled, or the coordinator row it points at is gone. The second
 * case is the same defect one step further along (deleting a coordinator takes
 * its children's only route to the user with it), and it costs one `NOT EXISTS`
 * to cover both.
 *
 * `archived = 0` on the child: an archived row is the user's own decision to put
 * it away, and a sweep must not reopen that by writing to it.
 */
const STRANDED_CHILD_FILTER = `t.archived = 0
      AND t.coordinator_thread_id IS NOT NULL
      AND (
        t.status IN (${ABANDONED_SQL})
        OR (t.status = 'failed' AND t.read = 0)
      )
      AND NOT EXISTS (
        SELECT 1 FROM threads coordinator
         WHERE coordinator.id = t.coordinator_thread_id
           AND coordinator.status NOT IN (${SETTLED_SQL})
      )`

interface StrandedChildRow {
  id: string
  projectId: string
  sessionId: string | null
  status: ThreadStatus
}

/**
 * Close out every stranded child, and report how many were written.
 *
 * Idempotent: a second pass over the same database reads no candidates, which is
 * what makes it safe to run on every thread update as well as at boot.
 */
export async function settleAbandonedCoordinatorChildren(
  host: CoordinatorChildSettleHost
): Promise<number> {
  if (!host.database.isOpen()) return 0
  const candidates = await readStrandedChildren(host.database)
  if (candidates.length === 0) return 0

  let settled = 0
  for (const child of candidates) {
    try {
      // An already-settled failure keeps its status and only loses the read flag
      // that made it look like an unanswered question.
      await host.threadManager.setStatus(
        child.projectId,
        child.id,
        child.status === 'failed' ? 'failed' : 'interrupted',
        { read: true, notify: false, touchActivity: false }
      )
      if (child.sessionId) host.clearRetry(child.sessionId)
      settled += 1
    } catch (error) {
      // A child deleted between the read and the write is already gone, which is
      // the outcome this pass wanted; anything else is logged and left for the
      // next sweep rather than failing the caller.
      Logger.dev('Abandoned orchestration child could not be settled:', {
        threadId: child.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  if (settled > 0) {
    Logger.info('Closed out orchestration children left by a settled coordinator', { settled })
  }
  return settled
}

async function readStrandedChildren(database: Database): Promise<StrandedChildRow[]> {
  try {
    const result = await database.queryViaWorker(
      `SELECT t.id, t.project_id, t.session_id, t.status
         FROM threads t
        WHERE ${STRANDED_CHILD_FILTER}
        LIMIT ${MAX_CHILDREN_PER_PASS}`,
      [],
      MAX_CHILDREN_PER_PASS
    )
    if (!result.ok) return []
    return result.rows.map((row) => ({
      id: String(row['id']),
      projectId: String(row['project_id']),
      sessionId:
        row['session_id'] === null || row['session_id'] === undefined
          ? null
          : String(row['session_id']),
      status: String(row['status']) as ThreadStatus
    }))
  } catch (error) {
    Logger.error('Stranded orchestration child read failed', error)
    return []
  }
}

/**
 * Sweep whenever the thread corpus changes, coalescing bursts.
 *
 * A coordinator settles through one of several paths (a turn going idle, a
 * harness error, a loop ending, a stop the user asked for, a restart recovery),
 * and every one of them ends in a persisted thread update. Watching the corpus
 * rather than hooking each path means a new settle path cannot forget to close
 * its children, and the pass is a single indexed read when there is nothing to
 * do.
 *
 * Returns the unsubscribe, so a stopped service leaves no listener behind.
 */
export function startCoordinatorChildSettleSweep(host: CoordinatorChildSettleHost): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let rerun = false

  const pass = async (): Promise<void> => {
    running = true
    try {
      do {
        rerun = false
        await settleAbandonedCoordinatorChildren(host)
      } while (rerun)
    } catch (error) {
      Logger.error('Orchestration child settle sweep failed', error)
    } finally {
      running = false
    }
  }

  const schedule = (): void => {
    // A pass that writes rows is itself a corpus change, so a request that
    // arrives mid-pass asks for exactly one more pass rather than a burst of
    // them: the second one reads nothing and stops.
    if (running) {
      rerun = true
      return
    }
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void pass()
    }, SETTLE_SWEEP_DEBOUNCE_MS)
  }

  const unsubscribe = subscribeThreadCorpus({
    updated: schedule,
    deleted: schedule,
    draftUpdated: () => {}
  })

  return () => {
    unsubscribe()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}
