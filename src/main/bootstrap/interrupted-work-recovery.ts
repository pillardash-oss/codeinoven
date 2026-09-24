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
 * A launch deliberately does *not* skip reconciliation when a sibling is live.
 * Doing so assumed the sibling would adopt the crashed work, but a sibling only
 * adopts what it notices: it can miss the crash entirely (a new instance that
 * registers before the survivor sees the death permanently cancels its take-over
 * pass), and it may not own the work at all. The observed result was crashed
 * threads stuck on `planning`/`executing`   a sidebar still showing "working"
 * with no live stream   until the user sent a prompt by hand. Ownership is the
 * precise signal, so a launch with a live sibling narrows to the orphaned turns
 * instead of settling or skipping everything.
 *
 * The second half of the story is {@link watchForInstanceTakeOver}: the shutdown
 * pipeline deliberately leaves a sibling's harness processes and in-flight turns
 * alone ("a surviving instance can continue them"), so this is the listener that
 * actually continues them once the sibling is gone.
 */

import { broadcastThreadUpdate } from '../chat/thread-events'
import type { Database } from '../database/database'
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
  // A launch that finds a sibling running cannot settle every active row: the
  // sibling's live turn and an orphan look identical by status alone, and a
  // harness owned by another process is invisible to this one's busy probes.
  // Ownership resolves that, so the pass narrows to the turns whose owning
  // process is gone rather than skipping reconciliation altogether. Settling a
  // live turn would finalize its checkpoint, overwrite the shared status, and
  // send a hidden `Continue` that starts a second concurrent harness run for a
  // session already at work.
  const adoptOnlyOrphans = reason === 'take-over' || instanceRegistry.hasOtherLiveInstance()
  if (reason === 'launch' && adoptOnlyOrphans) {
    Logger.info('Restart recovery adopting only turns whose owner is gone', {
      pid: process.pid
    })
  }

  const { RestartRecoveryService } = await import('../system/restart-recovery-service')
  const service = new RestartRecoveryService(database)
  const recovery = await service.recover({
    scope: adoptOnlyOrphans ? 'take-over' : 'restart',
    isRunOwnerAlive: (pid) => instanceRegistry.isRunOwnerAlive(pid),
    // Two instances can reconcile the same orphan at the same moment, and only
    // one of them may resume its harness session. The claim decides which.
    claimTurn: (projectId, threadId, ownerPid) => service.claimTurn(projectId, threadId, ownerPid)
  })

  reportRecovered(recovery)

  if (reason === 'take-over') {
    // The launch pass restored the queues it could claim; a take-over adopts the
    // ones the departed instance left behind.
    await state.chatEngine?.restoreCoordinatorHandoffQueues()
  }
  // Work that carries no turn owner is started only by a process that knows no
  // sibling is running, so a second window can never resume what the first one
  // is already driving. Each entry point enforces that on its own.
  await state.chatEngine?.resumePendingWork()
  // Threads whose owner is gone are the exception: nobody is running them, so
  // resuming them here cannot collide with another instance.
  if (recovery.recovered.length > 0) {
    await state.chatEngine?.resumeRecoveredThreads(recovery.recovered)
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
  if (recovery.failures.length > 0) {
    Logger.error('Restart recovery completed with failures', recovery.failures)
  }
}
