import type { Thread, ThreadStatus } from '../../lib/types'
import type { Database } from '../database/database'
import { ThreadRepo } from '../database/repositories/thread-repo'
import { CheckpointManager } from '../storage/checkpoint-manager'

const RECOVERABLE_STATUSES = new Set<ThreadStatus>(['planning', 'executing'])

export type RecoveryOperation = 'checkpoint' | 'thread'

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
  /** Threads whose turns demonstrably completed before the stop — not resumed. */
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
 * from a false positive — a turn whose terminal assistant answer was already
 * persisted before the app quit. In the latter case the checkpoint is finalized
 * as `completed` (full diff, no interruption error) and the thread is not resumed,
 * so no premature partial file-changes card or "stopped before completion" message
 * surfaces while the work was actually done.
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

  async recover(): Promise<RestartRecoveryResult> {
    const allThreads = await this.threads.listAllViaWorker()
    const recovered: Thread[] = []
    const completed: Thread[] = []
    const failures: RestartRecoveryFailure[] = []

    for (const thread of allThreads) {
      if (!RECOVERABLE_STATUSES.has(thread.status)) continue

      if (await this.turnDemonstrablyCompleted(thread)) {
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
