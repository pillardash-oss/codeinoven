import type { Thread, ThreadStatus } from '../lib/types'
import type { Database } from './database/database'
import { ThreadRepo } from './database/repositories/thread-repo'
import { CheckpointManager } from './checkpoint-manager'

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
  recovered: Thread[]
  failures: RestartRecoveryFailure[]
}

/**
 * Reconciles work that was left in-flight when the previous app process stopped.
 *
 * Recovery is deliberately bounded to statuses that represent active work.
 * Each persistence operation is attempted independently so one corrupt checkpoint
 * cannot prevent the affected thread, or other threads, from being made visible
 * as interrupted.
 */
export class RestartRecoveryService {
  private readonly threads: ThreadRepo
  private readonly checkpoints: CheckpointManager

  constructor(db: Database, checkpoints = new CheckpointManager(db)) {
    this.threads = new ThreadRepo(db)
    this.checkpoints = checkpoints
  }

  async recover(): Promise<RestartRecoveryResult> {
    const allThreads = this.threads.listAll()
    const recovered: Thread[] = []
    const failures: RestartRecoveryFailure[] = []

    for (const thread of allThreads) {
      if (!RECOVERABLE_STATUSES.has(thread.status)) continue

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
      failures
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
