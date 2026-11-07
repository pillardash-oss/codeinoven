/**
 * Reconciliation of work left in flight, across app instances.
 *
 * Every CodeInOven process using the same config root shares one thread table,
 * its `active_turns` rows, and the harness session files. That makes "a thread
 * is `planning`/`executing`" an ambiguous signal: the turn may belong to a
 * process that died, or to a sibling that is running it right now. The driver
 * busy probes cannot tell them apart, because a harness owned by another process
 * is invisible to them.
 *
 * This module is the single place that resolves the ambiguity, from two
 * independent signals:
 *
 * - **Turn ownership.** `active_turns.owner_pid` names the process running each
 *   in-flight turn, and {@link instanceRegistry} says which of those processes
 *   are alive. A reconciliation pass adopts exactly the turns whose owner is
 *   gone, whichever reason started it.
 * - **Instance liveness.** Work that carries no turn owner   a scheduled resume,
 *   a queued coordinator handoff, a persisted workflow   is started only by a
 *   process that knows no other instance is driving it, because only then is it
 *   certain nothing else owns that work.
 *
 * A launch next to a live instance touches nothing at all. The earlier policy
 * narrowed a launch to "turns whose owner is gone", on the theory that a live
 * sibling would not adopt work it never noticed. The theory under-rated how
 * easily a live instance looks gone: a heartbeat write that fails while the disk
 * is full, or a pause longer than the staleness window, is enough for a second
 * instance to treat a running turn as an orphan, settle its checkpoint, rewrite
 * its status and start its own run of the same session. The owner then reads that
 * as its own work and the two processes interleave. Ownership of a *live*
 * instance is therefore absolute: a launch that finds one leaves every thread,
 * checkpoint and workflow to it, and this process only shows them.
 *
 * The second half of the story is {@link watchForInstanceTakeOver}: a take-over
 * runs after a sibling has genuinely exited, so it settles what that process left
 * behind. It resumes ordinary conversations and never Engineering work (see
 * {@link startsEngineeringWork}): an Assignment owns worker dispatch, API
 * capability tokens and its coordinator loop, and only the process that was
 * driving it, or a deliberate resume by the user, may continue it.
 */

import { broadcastThreadUpdate } from '../chat/thread-events'
import type { Database } from '../database/database'
import type { Thread } from '../../lib/types'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import type { RestartRecoveryResult } from '../system/restart-recovery-service'
import type { BootstrapState } from './bootstrap-state'

/**
 * How long a take-over waits after a sibling disappears. Long enough to
 * coalesce the burst of registry writes a quitting or crashing instance leaves
 * behind, short enough that its threads resume promptly.
 */
const TAKE_OVER_DEBOUNCE_MS = 2_000

/** Which process stopped, and therefore what this pass is allowed to adopt. */
export type ReconciliationReason = 'launch' | 'take-over'

/**
 * Reconcile interrupted work once.
 *
 * A launch reconciles what a previous process left behind; a take-over
 * reconciles what the sibling that just exited left behind. Both share this one
 * implementation so the two can never drift apart in what they settle, resume,
 * or report.
 */
export async function reconcileInterruptedWork(
  state: BootstrapState,
  database: Database,
  reason: ReconciliationReason
): Promise<void> {
  // A second instance never touches the work of one that is running.
  //
  // A launch next to a live sibling cannot tell a live turn from an orphan by
  // status alone, and a harness owned by another process is invisible here, so
  // the old policy narrowed to "turns whose owner is gone". That reading is too
  // weak in practice: a sibling that is only briefly unresponsive, or that lost
  // a heartbeat while the disk was full, looks dead, and this pass then settles
  // its checkpoints, overwrites its statuses and starts its turns from a second
  // process. The owner reads those as its own runs and the two interleave on one
  // harness session. Ownership is the only safe rule for a *launch*: if another
  // instance is live, its threads are its own, whatever their status says.
  if (reason === 'launch' && instanceRegistry.hasOtherLiveInstance()) {
    Logger.info('Restart recovery left the live instance its own work', { pid: process.pid })
    return
  }

  // A take-over still adopts what a departed sibling left behind, because nobody
  // runs it any more. It never adopts the sibling's Engineering work (see
  // `startsEngineeringWork` below): that is a coordinator/worker graph with its
  // own loop, API capabilities and worker dispatch, and handing it to a different
  // process is how a running Assignment gets stopped from underneath its owner.
  const adoptOnlyOrphans = reason === 'take-over'
  const { RestartRecoveryService } = await import('../system/restart-recovery-service')
  const service = new RestartRecoveryService(database)
  // The durable marker a deliberate shutdown left behind turns an orphaned turn
  // into a clean app-closed stop instead of a crash failure. A launch consumes
  // it once it has been read, so a later crash cannot inherit a stale verdict.
  const cleanShutdown = state.cleanShutdownStore
  // A take-over pass fires the moment a sibling exits, which is long after this
  // process read the file at its own launch, and the marker that sibling leaves
  // is written at its shutdown. Re-read before judging whose orphans were
  // stopped on purpose, or a deliberate close is reported as a crash.
  await cleanShutdown?.reload()
  const recovery = await service.recover({
    scope: adoptOnlyOrphans ? 'take-over' : 'restart',
    isRunOwnerAlive: (pid) => instanceRegistry.isRunOwnerAlive(pid),
    // Two instances can reconcile the same orphan at the same moment, and only
    // one of them may resume its harness session. The claim decides which.
    claimTurn: (projectId, threadId, ownerPid) => service.claimTurn(projectId, threadId, ownerPid),
    isDeliberateStop: (ownerPid) => cleanShutdown?.isDeliberateStop(ownerPid) ?? false
  })

  if (reason === 'launch') {
    await cleanShutdown?.consume()
  }

  reportRecovered(recovery)

  // Engineering work belongs to the process that owns it. A take-over settles
  // the departed sibling's Engineering threads as interrupted and stops there:
  // resuming an Assignment from another process races its worker dispatch, its
  // API capability tokens and its coordinator loop, and the user can resume it
  // deliberately from the thread. Ordinary conversations still recover, so a
  // crash does not leave them stuck.
  const resumable =
    reason === 'take-over'
      ? recovery.recovered.filter((thread) => {
          if (!startsEngineeringWork(thread)) return true
          Logger.info('Engineering thread left stopped for its owner or the user', {
            projectId: thread.projectId,
            threadId: thread.id
          })
          return false
        })
      : recovery.recovered

  if (reason === 'take-over') {
    // A queued coordinator handoff is Engineering work for the same reason, so a
    // take-over leaves the departed instance's queue to the user rather than
    // restarting it in a process the Assignment never belonged to.
    Logger.info('Coordinator handoff queues left for the user after a take-over', {
      pid: process.pid
    })
  }
  // Work that carries no turn owner is started only by a process that knows no
  // sibling is running, so a second window can never resume what the first one
  // is already driving. Each entry point enforces that on its own, and it covers
  // the persisted workflows (Assignment coordination, specification and
  // Brainstorm generation, Achievement loops), so a take-over never runs them
  // either: they are Engineering work and they stay with the instance they
  // belong to until the user resumes them.
  if (reason === 'launch') {
    await state.chatEngine?.resumePendingWork()
  }
  // Threads whose owner is gone are the exception: nobody is running them, so
  // resuming them here cannot collide with another instance.
  if (resumable.length > 0) {
    await state.chatEngine?.resumeRecoveredThreads(resumable)
  }
  // A remote Oven turn never stopped: its Oven kept running it while this app was
  // closed, so there is nothing to resume   only a binding to reattach. Reattach
  // it now so the turn streams into the transcript as soon as the transport is
  // back, whether or not the user opens the thread first.
  if (recovery.remote.length > 0) {
    await state.chatEngine?.resumeRecoveredThreads(recovery.remote)
  }
}

/**
 * Watch the live-instance set and take over the work of an instance that exits.
 *
 * Only a sibling that disappears matters: a newly opened instance never
 * invalidates work the running process owns, and every pass re-checks turn
 * ownership before touching a turn. A clean quit removes its registry entry
 * immediately; a crash is noticed once its heartbeat goes stale.
 *
 * The trigger is a *specific* pid leaving the live set, never "no siblings are
 * left". Waiting for the last sibling to go let a race cancel the take-over
 * entirely: when a new instance registered before this process noticed the
 * crash, the set changed from `{crashed, self}` to `{replacement, self}` in one
 * step, the last-sibling condition never held, and the departed work stayed
 * stuck on `working` until a human sent a prompt. Ownership plus the exactly-once
 * claim on `active_turns` is what keeps several survivors from adopting the same
 * turn.
 */
export function watchForInstanceTakeOver(state: BootstrapState, database: Database): () => void {
  let knownPids = new Set(instanceRegistry.liveInstancePids() ?? [process.pid])
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = instanceRegistry.onLiveInstanceSetChanged(() => {
    const pids = instanceRegistry.liveInstancePids()
    // An unreadable registry is not evidence that a sibling exited.
    if (!pids) return
    const current = new Set(pids)
    const lostSibling = [...knownPids].some((pid) => pid !== process.pid && !current.has(pid))
    knownPids = current
    if (!lostSibling || state.quitCleanupStarted) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void reconcileInterruptedWork(state, database, 'take-over').catch((error) =>
        Logger.error('Instance take-over recovery failed (non-fatal):', error)
      )
    }, TAKE_OVER_DEBOUNCE_MS)
    timer.unref?.()
  })

  return () => {
    if (timer) clearTimeout(timer)
    stop()
  }
}

/**
 * Whether a thread is driving Engineering work.
 *
 * These are the threads whose resumption starts something other than a
 * conversation: an Assignment coordinator dispatching worker threads and holding
 * its own API capabilities, an Assignment worker, an auditor, an Achievement
 * loop. Only the process that owns the group may drive it, and a take-over   a
 * different process adopting a sibling's leftovers   is exactly the case that
 * must not.
 */
function startsEngineeringWork(thread: Thread): boolean {
  return (
    thread.engineering === true ||
    thread.independentAudit === true ||
    thread.independentAuditInitialized === true ||
    thread.coordinatorThreadId !== undefined ||
    thread.assignmentId !== undefined ||
    thread.assignmentRole !== undefined ||
    thread.achievementRole !== undefined ||
    thread.auditState !== undefined ||
    thread.auditorThreadId !== undefined
  )
}

/** Push corrected thread snapshots so sidebar indicators stop showing stale work. */
function reportRecovered(recovery: RestartRecoveryResult): void {
  if (recovery.recovered.length > 0) {
    Logger.info('Recovered interrupted threads', {
      inspected: recovery.inspected,
      recovered: recovery.recovered.map((thread) => ({
        projectId: thread.projectId,
        threadId: thread.id
      }))
    })
    // The renderer's thread list was hydrated before recovery ran, so its
    // in-memory rows still hold the stale planning/executing status. Push the
    // corrected snapshots so sidebar indicators flip to "interrupted"
    // immediately instead of lingering on "working" until the thread is
    // reopened. `interrupted` is not a notifiable status, so this cannot fire
    // spurious OS notifications.
    for (const thread of recovery.recovered) {
      broadcastThreadUpdate(thread)
    }
  }
  // Threads whose turns demonstrably completed before the stop are finalized as
  // `completed`, never resumed. Broadcast their corrected status too so the
  // sidebar doesn't linger on the stale "working" indicator.
  if (recovery.completed.length > 0) {
    Logger.info('Finalized completed interrupted threads', {
      inspected: recovery.inspected,
      completed: recovery.completed.map((thread) => ({
        projectId: thread.projectId,
        threadId: thread.id
      }))
    })
    for (const thread of recovery.completed) {
      broadcastThreadUpdate(thread)
    }
  }
  if (recovery.stopped.length > 0) {
    Logger.info('Settled deliberately stopped threads after a clean app close', {
      inspected: recovery.inspected,
      stopped: recovery.stopped.map((thread) => ({
        projectId: thread.projectId,
        threadId: thread.id
      }))
    })
  }
  // Remote Oven turns are neither settled nor broadcast: their row already reads
  // `executing`, which is true   the Oven is still working   so the sidebar is
  // correct as hydrated and needs no correction.
  if (recovery.remote.length > 0) {
    Logger.info('Reattached remote Oven turns still running on their Oven', {
      inspected: recovery.inspected,
      remote: recovery.remote.map((thread) => ({
        projectId: thread.projectId,
        threadId: thread.id
      }))
    })
  }
  if (recovery.failures.length > 0) {
    Logger.error('Restart recovery completed with failures', recovery.failures)
  }
}
