import type { Thread, ThreadStatus } from '../../lib/types'
import type { Database } from '../database/database'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { CheckpointManager } from '../storage/checkpoint-manager'

const RECOVERABLE_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

export type RecoveryOperation = 'checkpoint' | 'thread' | 'claim'

/**
 * Which stopped process this pass is allowed to clean up after.
 *
 * - `restart`: nothing else is running, so every thread left in an active status
 *   belongs to a process that is gone. This is the classic restart contract and
 *   the default.
 * - `take-over`: a sibling instance may own in-flight work, so only the turns
 *   whose recorded owner is gone are adoptable. A turn with no owner record
 *   cannot be told apart from one a live process is starting right now, and is
 *   left alone. Both the take-over pass and a launch that finds a live sibling
 *   use this scope.
 */
export type RestartRecoveryScope = 'restart' | 'take-over'

export interface RestartRecoveryOptions {
  scope?: RestartRecoveryScope
  /**
   * Whether the process that recorded a turn as in flight is still running,
   * consulted for the `take-over` scope. A turn whose owner is alive is never
   * settled here, whichever instance asks.
   */
  isRunOwnerAlive?: (pid: number) => boolean
  /**
   * Atomically take ownership of a turn before it is settled, returning whether
   * this process won it.
   *
   * Two instances can reconcile the same orphaned turn at the same moment, and
   * both would then resume one harness session. The claim makes adoption
   * exactly-once: a process that loses it must leave the turn alone. Omitted
   * means no claim is made, which is only safe when a single instance can run
   * this pass (a plain restart with no sibling).
   */
  claimTurn?: (projectId: string, threadId: string, ownerPid: number) => Promise<boolean>
}

export interface RestartRecoveryFailure {
  projectId: string
  threadId: string
  operation: RecoveryOperation
  message: string
}

export interface RestartRecoveryResult {
  inspected: number
  /** Threads whose interrupted turns should be re-run on restart. */
  recovered: Thread[]
  /** Threads whose turns demonstrably completed before the stop   not resumed. */
  completed: Thread[]
  failures: RestartRecoveryFailure[]
}

/**
 * Reconciles work that was left in-flight when the previous app process stopped.
 *
 * Recovery is deliberately bounded to statuses that represent active work.
 * Each persistence operation is attempted independently so one corrupt checkpoint
 * cannot prevent the affected thread, or other threads, from being made visible
 * as interrupted.
 *
 * Recovery distinguishes a turn that actually stopped before the harness finished
 * from a false positive   a turn whose terminal assistant answer was already
 * persisted before the app quit. In the latter case the checkpoint is finalized
 * as `completed` (full diff, no interruption error) and the thread is not resumed,
 * so no premature partial file-changes card or "stopped before completion" message
 * surfaces while the work was actually done.
 *
 * A process that is running while a sibling exits passes `scope: 'take-over'`,
 * which adopts only the turns the departed process owned (see
 * {@link RestartRecoveryScope}).
 */
export class RestartRecoveryService {
  private readonly threads: ThreadRepo
  private readonly checkpoints: CheckpointManager
  private readonly db: Database

  constructor(db: Database, checkpoints = new CheckpointManager(db)) {
    this.threads = new ThreadRepo(db)
    this.checkpoints = checkpoints
    this.db = db
  }

  async recover(options: RestartRecoveryOptions = {}): Promise<RestartRecoveryResult> {
    const allThreads = await this.threads.listAllViaWorker()
    const activeTurnOwners = await this.activeTurnOwners()
    const recovered: Thread[] = []
    const completed: Thread[] = []
    const failures: RestartRecoveryFailure[] = []

    for (const thread of allThreads) {
      const hasActiveTurn = activeTurnOwners.has(thread.id)
      const completedWithOrphanCheckpoint = thread.status === 'completed' && hasActiveTurn
      if (!RECOVERABLE_STATUSES.has(thread.status) && !completedWithOrphanCheckpoint) continue
      const ownerPid = activeTurnOwners.get(thread.id)
      if (options.scope === 'take-over') {
        // Only a turn a departed process was running can be adopted here. A turn
        // with no owner record is either a legacy row or one this process is
        // starting right now, and nothing can tell those apart.
        if (typeof ownerPid !== 'number') continue
        if (options.isRunOwnerAlive?.(ownerPid) === true) continue
      }

      // Adoption is exactly-once: a sibling may be reconciling the same orphaned
      // turn right now, and only one of us may resume its harness session.
      if (typeof ownerPid === 'number' && options.claimTurn) {
        const claimed = await options
          .claimTurn(thread.projectId, thread.id, ownerPid)
          .catch((error: unknown) => {
            failures.push(this.failure(thread, 'claim', error))
            return null
          })
        if (claimed !== true) continue
      }

      if (completedWithOrphanCheckpoint || (await this.turnDemonstrablyCompleted(thread))) {
        try {
          await this.checkpoints.markActiveCompleted(thread.projectId, thread.id)
        } catch (error) {
          failures.push(this.failure(thread, 'checkpoint', error))
        }
        try {
          this.threads.setStatus(thread.id, 'completed', Date.now())
          completed.push({
            ...thread,
            status: 'completed' as ThreadStatus,
            updatedAt: Date.now(),
            lastActivity: Date.now()
          })
        } catch (error) {
          failures.push(this.failure(thread, 'thread', error))
        }
        continue
      }

      try {
        await this.checkpoints.markActiveInterrupted(thread.projectId, thread.id)
      } catch (error) {
        failures.push(this.failure(thread, 'checkpoint', error))
      }

      try {
        this.threads.setStatus(thread.id, 'interrupted', Date.now())
        recovered.push({
          ...thread,
          status: 'interrupted' as ThreadStatus,
          updatedAt: Date.now(),
          lastActivity: Date.now()
        })
      } catch (error) {
        failures.push(this.failure(thread, 'thread', error))
      }
    }

    return {
      inspected: allThreads.length,
      recovered,
      completed,
      failures
    }
  }

  /**
   * Claim one orphaned turn for this process, for {@link RestartRecoveryOptions.claimTurn}.
   */
  async claimTurn(projectId: string, threadId: string, ownerPid: number): Promise<boolean> {
    return this.checkpoints.claimActiveTurnOwner(projectId, threadId, ownerPid)
  }

  /**
   * The process that recorded each in-flight turn, keyed by thread. A thread
   * with no row, or a row written before `owner_pid` existed, maps to `null`.
   */
  private async activeTurnOwners(): Promise<Map<string, number | null>> {
    const result = await this.db.queryViaWorker(
      'SELECT thread_id, owner_pid FROM active_turns',
      [],
      100_000
    )
    if (!result.ok) {
      throw new Error(result.error ?? 'active checkpoint recovery query failed')
    }
    const owners = new Map<string, number | null>()
    for (const row of result.rows) {
      const owner = row['owner_pid']
      const pid = typeof owner === 'number' ? owner : Number(owner)
      owners.set(String(row['thread_id']), Number.isInteger(pid) && pid > 0 ? pid : null)
    }
    return owners
  }

  /**
   * Whether the thread's in-flight turn demonstrably finished before the app
   * stopped, judged from the persisted transcript. Mirrors the in-session
   * `missingFinalResponse` contract: the assistant produced a terminal answer
   * (non-empty text or structured output) for the latest user message and did
   * not end on an error.
   */
  private async turnDemonstrablyCompleted(thread: Thread): Promise<boolean> {
    const result = await this.db.queryViaWorker(
      `WITH latest_user AS (
         SELECT created_at, id
         FROM agent_messages
         WHERE thread_id = ? AND role = 'user'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       SELECT assistant.role, assistant.error, assistant.parts, assistant.structured_output
       FROM agent_messages AS assistant
       LEFT JOIN latest_user ON 1 = 1
       WHERE assistant.thread_id = ?
         AND assistant.role = 'assistant'
         AND (
           latest_user.id IS NULL
           OR assistant.created_at > latest_user.created_at
           OR (assistant.created_at = latest_user.created_at AND assistant.id > latest_user.id)
         )
       ORDER BY assistant.created_at DESC, assistant.id DESC`,
      [thread.id, thread.id],
      1
    )
    if (!result.ok) {
      throw new Error(result.error ?? 'agent message recovery query failed')
    }
    const turnAssistant = result.rows[0] as
      | {
          role: string
          error: string | null
          parts: string
          structured_output: string | null
        }
      | undefined
    if (!turnAssistant) return false
    if (turnAssistant.error) return false
    if (turnAssistant.structured_output != null) return true
    try {
      const parts = JSON.parse(turnAssistant.parts) as Array<{ type?: string; text?: string }>
      return parts.some((part) => part.type === 'text' && (part.text ?? '').trim().length > 0)
    } catch {
      return false
    }
  }

  private failure(
    thread: Thread,
    operation: RecoveryOperation,
    error: unknown
  ): RestartRecoveryFailure {
    return {
      projectId: thread.projectId,
      threadId: thread.id,
      operation,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
