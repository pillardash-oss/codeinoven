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
import { instanceHandoffBus } from './instance-handoff-bus'
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
 * Why this process still has to outlive its window, or null when it does not.
 *
 * Residency is a question about durable state, not about the window: with the
 * window closed there is no renderer to keep alive, so the only thing that can
 * justify the process is work it still has to do or to hold. The reasons are
 * ordered by how soon they need it:
 *
 *   - `update-pending`: a downloaded update is waiting to install, and the
 *     install is a real quit that must not be left unapplied;
 *   - `thread-running`: a run is in flight and an exit would interrupt it;
 *   - `handoff-pending`: another instance is being asked to release a run and has
 *     not answered, so an exit loses that transfer;
 *   - `retry-pending`: a provider retry falls due inside the wake window, so the
 *     run it belongs to is waiting on this process;
 *   - `run-due`: a slot is due now, or was missed, and must be fired or recorded;
 *   - `heartbeat-armed`: a heartbeat is enabled with times to fire. Like a
 *     routine it only pings while the app is running, so the clock is the reason
 *     the process exists;
 *   - `schedule-armed`: a task is on the clock and will come due later. Nothing
 *     needs the process this second, but the clock is the whole reason a menu bar
 *     process exists: dropping it would turn a scheduled run into a late one that
 *     only fires if the app happens to be launched again before the slot matters;
 *   - `unreadable`: the check itself failed. Kept resident on purpose, because a
 *     failed read is not evidence that nothing is pending.
 */
export type ResidencyReason =
  | 'update-pending'
  | 'thread-running'
  | 'handoff-pending'
  | 'retry-pending'
  | 'run-due'
  | 'heartbeat-armed'
  | 'schedule-armed'
  | 'unreadable'

/**
 * Whether the process has something to preserve, and what it is.
 *
 * The counterpart of {@link hasUpcomingWork}, which describes what the backend is
 * *doing* for the menu bar tooltip: this one decides whether the process may exit
 * at all. It deliberately reads the same durable state and adds the schedule
 * itself, because a parked process is a scheduler before it is anything else.
 *
 * Read at every close decision and again while parked, so it must stay cheap; see
 * `BackgroundLifecycleService.evaluateResidency` for why it is never consulted at
 * all while a window is on screen.
 */
export function residencyReason(
  state: BootstrapState,
  database: Database
): ResidencyReason | null {
  try {
    if (state.quitForUpdate) return 'update-pending'
    if (database.isOpen() && new ThreadRepo(database).hasActive()) return 'thread-running'
    if (instanceHandoffBus.hasPendingHandoff()) return 'handoff-pending'
    const now = Date.now()
    if (state.retryScheduler?.hasPendingRetryBefore(now + SCHEDULED_RETRY_WAKE_WINDOW_MS)) {
      return 'retry-pending'
    }
    const scheduler = state.routineScheduler
    if (scheduler) {
      if (scheduler.listMissedRuns().length > 0) return 'run-due'
      const lead = state.backgroundLifecycle?.wakeLeadMs ?? 0
      const due = scheduler.nextDueAt(now)
      if (due !== null && due - now <= Math.max(lead, 60_000)) return 'run-due'
      // The long-horizon case: nothing is due now, but the clock is still armed.
      if (scheduler.hasTaskOnTheClock()) return 'schedule-armed'
    }
    if (state.heartbeatScheduler?.hasHeartbeatOnTheClock()) return 'heartbeat-armed'
  } catch (error) {
    Logger.error('Background residency check failed', error)
    return 'unreadable'
  }
  return null
}

/**
 * The attention predicate: does any thread currently hold a problem the user
 * has not seen?
 *
 * The menu bar icon mirrors the thread's own error card, so the user learns a
 * run broke without opening the app. Three conditions light it:
 *
 *   - a thread parked on the user (`awaiting_approval`): a permission, question,
 *     or secret card, or a reviewable artifact, that cannot proceed on its own.
 *     This is live state, so it is deliberately *not* gated on `read`: opening
 *     or reading the thread answers nothing, and the light must stay until the
 *     status itself changes (the user answers, or the turn resumes);
 *   - a thread that settled `failed`, until the user reads it   a failure is a
 *     past event the user acknowledges by reading it, not a state they are
 *     being asked to act on right now;
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
        WHERE status IN ('working-paused', 'awaiting_approval')
           OR (read = 0 AND status = 'failed')`
    )
    return (row?.cnt ?? 0) > 0
  } catch (error) {
    Logger.error('Background attention check failed', error)
    return false
  }
}
