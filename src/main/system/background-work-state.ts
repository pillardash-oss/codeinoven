/**
 * Background-mode state predicates: is there work to stay awake for, and does
 * anything need the user?
 *
 * Both are derived from durable state (SQLite and the schedulers) rather than
 * from a renderer, because while the window is closed there is no renderer to
 * ask. The menu bar icon's two states and its tooltip are the only consumers.
 */

import { SCHEDULED_RETRY_WAKE_WINDOW_MS } from '../../lib/provider-issue'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { Database } from '../database/database'
import type { BootstrapState } from '../bootstrap/bootstrap-state'
import { Logger } from './logger'

/**
 * Whether something is running or due soon enough to matter for a tray tooltip
 * or a quit warning. Never the stay-alive decision itself: background mode parks
 * unconditionally, so this only describes what the backend is doing.
 */
export function hasUpcomingWork(state: BootstrapState, database: Database): boolean {
  const now = Date.now()
  try {
    const scheduler = state.routineScheduler
    if (scheduler) {
      if (scheduler.listMissedRuns().length > 0) return true
      const lead = state.backgroundLifecycle?.wakeLeadMs ?? 0
      const due = scheduler.nextDueAt(now)
      if (due !== null && due - now <= Math.max(lead, 60_000)) return true
    }
    if (state.retryScheduler?.hasPendingRetryBefore(now + SCHEDULED_RETRY_WAKE_WINDOW_MS)) {
      return true
    }
    if (database.isOpen() && new ThreadRepo(database).hasActive()) return true
  } catch (error) {
    Logger.error('Upcoming-work check failed', error)
  }
  return false
}

/**
 * The attention predicate: a thread is parked on approval, or an unattended
 * assistant run settled failed and has not been read. Computed from SQLite so
 * the icon is truthful whether the window is open, windowless, or was restarted
 * overnight.
 */
export function computeAttention(database: Database): boolean {
  if (!database.isOpen()) return false
  try {
    const row = database.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM threads
        WHERE read = 0
          AND (status = 'awaiting_approval'
               OR (status = 'failed' AND assistant_task_id IS NOT NULL))`
    )
    return (row?.cnt ?? 0) > 0
  } catch (error) {
    Logger.error('Background attention check failed', error)
    return false
  }
}
