/**
 * Which CodeInOven instance owns each coordinated workflow.
 *
 * A coordinated workflow   the Sr. Engineer coordinator and the worker and
 * auditor threads it owns   is one unit of instance ownership. One process
 * drives it: it holds the harness sessions, it decides when a queued handoff is
 * due, and it runs the Assignment or Achievement loop. A second instance sharing
 * the same config root sees the same threads and the same persisted workflow,
 * but it must never drive them, or two harness runs would work the same tasks.
 *
 * That fact cannot be read from `active_turns` alone. A turn ledger row exists
 * only while a turn is in flight, and a workflow is between turns constantly   it
 * waits for a worker report, a user gate, or a scheduled audit. A peer launching
 * in one of those gaps would see a persisted `running` assignment with no active
 * turn and adopt it. So ownership is recorded durably here, keyed by the
 * coordinator thread exactly as `assignment_workflow` is, and the whole group
 * follows the row.
 *
 * Ownership is never released on the normal path. A dead owner is ignored by
 * {@link InstanceRegistry.isRunOwnerAlive}, the same way a dead turn owner is, so
 * a crash leaves the workflow adoptable without a cleanup pass. A deliberate
 * transfer is the one case that releases it, because the adopter must be able to
 * claim it.
 */

import type { Database } from '../database/database'
import { instanceRegistry } from './instance-registry'
import { Logger } from './logger'

/**
 * Liveness probe, injectable so the claim rule can be exercised without a
 * second real app process. Defaults to the shared instance registry.
 */
export interface WorkflowOwnershipOptions {
  /** Whether the process that recorded ownership is still running. */
  isRunOwnerAlive?: (pid: number) => boolean
}

export class WorkflowOwnershipService {
  private readonly isRunOwnerAlive: (pid: number) => boolean

  constructor(
    private readonly db: Database,
    options: WorkflowOwnershipOptions = {}
  ) {
    this.isRunOwnerAlive =
      options.isRunOwnerAlive ?? ((pid) => instanceRegistry.isRunOwnerAlive(pid))
  }

  /**
   * The process that owns the workflow, or `null` when nobody does. `null` also
   * covers a row whose recorded owner is unusable, which no instance can claim
   * as its own.
   */
  async ownerPid(projectId: string, coordinatorThreadId: string): Promise<number | null> {
    const row = this.db.get<{ owner_pid: number | null }>(
      'SELECT owner_pid FROM workflow_owners WHERE project_id = ? AND coordinator_thread_id = ?',
      projectId,
      coordinatorThreadId
    )
    if (!row) return null
    const owner = Number(row.owner_pid)
    return Number.isInteger(owner) && owner > 0 ? owner : null
  }

  /**
   * Record this process as the workflow's owner unconditionally.
   *
   * Called when this process is demonstrably driving the workflow   it is about
   * to dispatch a turn on one of its threads   so there is nothing to negotiate.
   * Re-claiming a workflow this process already owns is a no-op read.
   */
  async claim(projectId: string, coordinatorThreadId: string): Promise<void> {
    if ((await this.ownerPid(projectId, coordinatorThreadId)) === process.pid) return
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO workflow_owners
             (project_id, coordinator_thread_id, owner_pid, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(projectId, coordinatorThreadId, process.pid, Date.now())
    } catch (error) {
      // Recording ownership is bookkeeping, never a reason to fail the turn that
      // triggered it: the coordinator row can be deleted underneath a racing
      // write. A missing row only costs precision, and the active-turn signal
      // still tells a peer that this workflow is being driven.
      Logger.dev('Workflow ownership could not be recorded:', error)
    }
  }

  /**
   * Take ownership of a workflow no live instance is driving, atomically.
   *
   * Two instances can reconcile the same orphaned workflow in the same moment,
   * and both would then resume one harness session. The claim is a conditional
   * write on the shared row, so exactly one process wins: whoever's observed
   * owner is still current takes it, and every other claimant is told `false`
   * and must leave the workflow alone. Claiming a workflow this process already
   * owns reports `true` without writing.
   */
  async claimIfOwnerGone(projectId: string, coordinatorThreadId: string): Promise<boolean> {
    const observed = await this.ownerPid(projectId, coordinatorThreadId)
    if (observed === process.pid) return true
    // A live peer owns it   adopting here would start a second concurrent run.
    if (observed !== null && this.isRunOwnerAlive(observed)) return false
    try {
      const updated = this.db
        .prepare(
          `UPDATE workflow_owners SET owner_pid = ?, updated_at = ?
           WHERE project_id = ? AND coordinator_thread_id = ? AND owner_pid IS ?`
        )
        .run(process.pid, Date.now(), projectId, coordinatorThreadId, observed)
      if (updated.changes === 1) return true
      // Nothing matched the observed owner: either the row does not exist yet, or
      // a peer claimed it first. Insert-if-absent decides which.
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO workflow_owners
             (project_id, coordinator_thread_id, owner_pid, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(projectId, coordinatorThreadId, process.pid, Date.now())
      return inserted.changes === 1
    } catch (error) {
      // A failed claim must leave the workflow alone, never resume it on a
      // guess: another instance may already be driving it.
      Logger.dev('Workflow ownership claim failed:', error)
      return false
    }
  }

  /**
   * Drop this process's ownership so another instance may claim the workflow.
   * Only a row this process owns is removed, so a stale release can never
   * discard a peer's claim.
   */
  async release(projectId: string, coordinatorThreadId: string): Promise<void> {
    try {
      this.db
        .prepare(
          `DELETE FROM workflow_owners
           WHERE project_id = ? AND coordinator_thread_id = ? AND owner_pid = ?`
        )
        .run(projectId, coordinatorThreadId, process.pid)
    } catch (error) {
      Logger.dev('Workflow ownership release failed:', error)
    }
  }
}
