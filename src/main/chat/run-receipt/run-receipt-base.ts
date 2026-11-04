import type { RunBaseRecord, Thread } from '../../../lib/types'

/**
 * The commit a run started from.
 *
 * A receipt answers "what did this run do", and that question has no meaning
 * without a starting point. The base is therefore recorded once, when the run
 * begins, and never re-derived at settle time: re-deriving it after the fact
 * would describe whatever the checkout looks like now, which is exactly the
 * claim a receipt exists to prevent.
 *
 * A run with no recorded base is not guessed at either. It reports `no-base`,
 * because borrowing today's HEAD would silently attribute the whole checkout's
 * history to a run that may have started anywhere.
 */

/** The narrow port this unit needs: read a thread, write its base once. */
export interface RunBaseStore {
  getThread(projectId: string, threadId: string): Promise<Thread | null>
  setRunBase(projectId: string, threadId: string, base: RunBaseRecord): Promise<void>
}

export class RunBaseRecorder {
  constructor(private readonly store: RunBaseStore) {}

  /**
   * Record `sha` as the run's base, unless one is already recorded.
   *
   * A resumed run keeps its original base: the work it already did happened
   * after that commit, so moving the base on resume would erase it from the
   * receipt.
   */
  async record(
    projectId: string,
    threadId: string,
    sha: string,
    scope: { projectId: string; scopeBucketId: string }
  ): Promise<RunBaseRecord | null> {
    const trimmed = sha.trim()
    if (!trimmed) return null
    const thread = await this.store.getThread(projectId, threadId)
    if (!thread) return null
    if (thread.runBase) return thread.runBase
    const base: RunBaseRecord = {
      sha: trimmed,
      projectId: scope.projectId,
      scopeBucketId: scope.scopeBucketId,
      recordedAt: Date.now()
    }
    await this.store.setRunBase(projectId, threadId, base)
    return base
  }

  /** The base a receipt should range from, or null when none was recorded. */
  async read(thread: Thread | null): Promise<RunBaseRecord | null> {
    return thread?.runBase ?? null
  }
}
