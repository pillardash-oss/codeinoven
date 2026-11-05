import type { ScopeBoard } from '../types'
import type { Thread } from '../types'
import { ScopeSwapRefusal, scopeSwapRefusal } from '../thread-scope-swap'

export interface ScopeSwapGuardInput {
  /** The thread as it is stored now, before the move. */
  thread: Pick<Thread, 'projectId' | 'scopeBucketId' | 'status'>
  /** The scope the write would move the thread to. */
  targetBucketId: string
  /** Reads the project's scope board; the caller passes its own reader. */
  boardFor: (projectId: string) => Promise<ScopeBoard>
}

/**
 * Enforce the scope-swap rule from {@link scopeSwapRefusal} behind every scope
 * write, not only the UI that asked for it: the composer, the scope board's drag
 * and drop, the "Change Scope" dialog and the agent-facing scope tool all reach
 * the same thread writer, so none of them can bypass it.
 *
 * Thrown as a `ScopeSwapRefusal`, which the `thread:moveScope` transport turns
 * into data (see that channel's contract) so an expected refusal never reaches
 * a log.
 */
export async function assertScopeSwapAllowed(input: ScopeSwapGuardInput): Promise<void> {
  const board = await input.boardFor(input.thread.projectId)
  const refusal = scopeSwapRefusal({
    thread: input.thread,
    targetBucketId: input.targetBucketId,
    buckets: board.buckets
  })
  if (refusal) throw new ScopeSwapRefusal(refusal)
}
