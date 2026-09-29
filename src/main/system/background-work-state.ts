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
 * The attention predicate: does any thread currently hold a problem the user
 * has not seen?
 *
 * The menu bar icon mirrors the thread's own error card, so the user learns a
 * run broke without opening the app. Three conditions light it:
 *
 *   - a thread parked on an approval gate, which cannot proceed on its own;
 *   - a thread that settled `failed`, until the user reads it;
 *   - a thread paused on a provider issue (`working-paused`), which carries the
 *     visible error card   a usage reset, a connection interruption, a
 *     provider outage. It is deliberately not gated on `read`: the run is
 *     blocked until it recovers, and the icon returns to normal when the
 *     status does (a fired retry, a manual retry, or a new turn).
 *
 * Computed from SQLite, never from a renderer, so the icon is truthful whether
 * the window is open, windowless, or was restarted overnight. The provider
 * issue records the retry scheduler holds live on a thread that is also
 * `working-paused`, so the durable thread status is the single source of truth.
 */
export function computeAttention(database: Database): boolean {
  if (!database.isOpen()) return false
  try {
    const row = database.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM threads
        WHERE status = 'working-paused'
           OR (read = 0 AND status IN ('awaiting_approval', 'failed'))`
    )
    return (row?.cnt ?? 0) > 0
  } catch (error) {
    Logger.error('Background attention check failed', error)
    return false
  }
}
