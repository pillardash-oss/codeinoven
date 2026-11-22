/**
 * Background-mode state predicates: is there work to stay awake for, and does
 * anything need the user?
 *
 * Both are derived from durable state (SQLite and the schedulers) rather than
 * from a renderer, because while the window is closed there is no renderer to
 * ask. The menu bar icon's states and its tooltip are the only consumers.
 *
 * The residency predicates' thread reads stay on the primary connection on
 * purpose. Residency is synchronous by contract: the close decision and the
 * parked drain tick ask synchronously, and the answer decides whether a run may
 * be interrupted, so it cannot lag behind by the round trip of a worker read. A
 * cached value fed by an async read would be exactly that lag, and a cache that
 * is a moment behind a run that just started is a process that exits mid-turn.
 * The two predicates the tray can await, `computeAttention` and
 * `countWorkingThreads` below, read their rows on the database worker instead:
 * they refresh on every thread update, which is an interaction path, and must
 * never hold the main thread on SQLite.
 */

import { SETTLED_THREAD_STATUSES } from '../../lib/thread-status-policy'
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
    const scheduler = state.assistantScheduler
    if (scheduler) {
      if (scheduler.listMissedRuns().length > 0) return true
      const lead = state.backgroundLifecycle?.wakeLeadMs ?? 0
      const due = scheduler.nextDueAt(now)
      if (due !== null && due - now <= Math.max(lead, 60_000)) return true
    }
    // A thread's own wake is work the app still owes, even though it belongs to a
    // conversation rather than to an assistant task.
    const followUp = state.followUpService?.nextDueAt() ?? null
    if (followUp !== null && followUp - now <= 60_000) return true
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
 *     assistant it only pings while the app is running, so the clock is the reason
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
export function residencyReason(state: BootstrapState, database: Database): ResidencyReason | null {
  try {
    if (state.quitForUpdate) return 'update-pending'
    if (database.isOpen() && new ThreadRepo(database).hasActive()) return 'thread-running'
    if (instanceHandoffBus.hasPendingHandoff()) return 'handoff-pending'
    const now = Date.now()
    if (state.retryScheduler?.hasPendingRetryBefore(now + SCHEDULED_RETRY_WAKE_WINDOW_MS)) {
      return 'retry-pending'
    }
    const scheduler = state.assistantScheduler
    if (scheduler) {
      if (scheduler.listMissedRuns().length > 0) return 'run-due'
      const lead = state.backgroundLifecycle?.wakeLeadMs ?? 0
      const due = scheduler.nextDueAt(now)
      if (due !== null && due - now <= Math.max(lead, 60_000)) return 'run-due'
      // The long-horizon case: nothing is due now, but the clock is still armed.
      if (scheduler.hasTaskOnTheClock()) return 'schedule-armed'
    }
    if (state.heartbeatScheduler?.hasHeartbeatOnTheClock()) return 'heartbeat-armed'
    // A pending follow-up is a thread wake the user agreed to, so the process has
    // to outlive its window for it exactly as it does for a scheduled run.
    const followUpDue = state.followUpService?.nextDueAt() ?? null
    if (followUpDue !== null) {
      const lead = state.backgroundLifecycle?.wakeLeadMs ?? 0
      return followUpDue - now <= Math.max(lead, 60_000) ? 'run-due' : 'schedule-armed'
    }
  } catch (error) {
    Logger.error('Background residency check failed', error)
    return 'unreadable'
  }
  return null
}

/**
 * The WHERE fragment keeping only threads a list can actually show the user.
 *
 * Two kinds of row are hidden by the rail today, and both of them must be hidden
 * from the attention predicate for the same reason: a problem the user cannot
 * open is not a problem the icon may pester them about.
 *
 *   - `archived = 0` on the row itself: an archived thread is one the user put
 *     away, so a failure or a gate inside it is not an open question any more.
 *   - an orchestration child (a worker, an auditor, or anything spawned under a
 *     coordinator   the same shape `isOrchestrationChildThread` recognises on the
 *     renderer) whose coordinator has already settled. The rail folds children
 *     into the coordinator's own row and never lists them; once that coordinator
 *     is `completed`, `failed` or `interrupted`, there is no surface left that
 *     shows the child, no retry that can resume it and no way to clear it.
 *
 * A child whose coordinator is still live *is* counted: it is reachable through
 * the orchestration board of a run the user is watching, and its gate or its
 * failure is something they can still answer.
 *
 * Written in SQL rather than applied to the rows afterwards because the predicate
 * is `LIMIT 1`   the first reachable problem has to be the one the query finds.
 */
function reachableThreadSql(alias: string): string {
  const settled = SETTLED_THREAD_STATUSES.map((status) => `'${status}'`).join(', ')
  return `(
    NOT (
      ${alias}.assignment_role IS NOT 'coordinator'
      AND ${alias}.achievement_role IS NOT 'coordinator'
      AND (
        ${alias}.achievement_role IS 'auditor'
        OR ${alias}.assignment_role IS 'worker'
        OR ${alias}.assignment_id IS NOT NULL
        OR ${alias}.coordinator_thread_id IS NOT NULL
      )
    )
    OR EXISTS (
      SELECT 1 FROM threads coordinator
       WHERE coordinator.id = ${alias}.coordinator_thread_id
         AND coordinator.archived = 0
         AND coordinator.status NOT IN (${settled})
    )
  )`
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
 *
 * The read runs on the database worker: the tray refreshes it on every thread
 * update, which is an interaction path, and even a COUNT over `threads` holds
 * the whole main process for as long as the OS takes to serve it.
 *
 * A problem only counts while the user can *reach* the thread that carries it
 * (see {@link reachableThreadSql}). The icon is a prompt to go and answer
 * something, so a row hidden from every list would turn it into a light that
 * never goes out and that no action can clear   which is exactly what a stale
 * orchestration child does: a worker left `working-paused` or parked on a gate
 * after its coordinator already settled is never listed, never openable and
 * never markable, so counting it was a permanent exclamation with no error
 * anywhere on screen.
 */
export async function computeAttention(database: Database): Promise<boolean> {
  if (!database.isOpen()) return false
  try {
    const result = await database.queryViaWorker(
      `SELECT 1 AS attention FROM threads t
        WHERE t.archived = 0
          AND (t.status IN ('working-paused', 'awaiting_approval')
               OR (t.read = 0 AND t.status = 'failed'))
          AND ${reachableThreadSql('t')}
        LIMIT 1`,
      [],
      1
    )
    if (!result.ok) return false
    return result.rows.length > 0
  } catch (error) {
    Logger.error('Background attention check failed', error)
    return false
  }
}

/**
 * How many threads are producing work right now: the figure the menu bar icon
 * carries while anything is running.
 *
 * Deliberately the same set as the residency `thread-running` reason and
 * {@link ThreadRepo.countActiveViaWorker}: a harness is mid-turn (`planning` or
 * `executing`). A thread parked on the user, waiting on a provider retry, or
 * settled is not working, however much of the user's attention it wants, which
 * is why the figure never counts them.
 */
export async function countWorkingThreads(database: Database): Promise<number> {
  if (!database.isOpen()) return 0
  try {
    return await new ThreadRepo(database).countActiveViaWorker()
  } catch (error) {
    Logger.error('Working-thread count failed', error)
    return 0
  }
}
