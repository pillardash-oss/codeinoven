import { UTILITY_DIAGNOSTICS_TOOL_NAME } from '../../../lib/gateway-tools'
import type { ForkOrigin } from '../../../lib/engines/thread-manager-fork'

/**
 * The slice of the database this note needs: one bounded read.
 */
export interface ForkNoticeQuery {
  queryViaWorker(
    sql: string,
    params: unknown[],
    maxRows: number
  ): Promise<{ ok: boolean; rows: Record<string, unknown>[] }>
}

/**
 * The note the app prepends to the first turn of a forked thread.
 *
 * A fork keeps no copy of the parent's transcript: the parent thread holds the
 * history up to the fork point, and this thread starts empty. The agent still has
 * to be told that, or it answers from the recap alone and its first reply reads
 * as if the work started here. Naming the parent thread lets the agent go and
 * read the rest when the recap or its own history is not enough, and tells it
 * what to do when that thread is gone.
 */
export function forkParentNotice(parentThreadId: string): string {
  return [
    `This thread was forked from thread ${parentThreadId}: the work done before the fork lives in that thread, not in this one.`,
    `Read it yourself instead of guessing or asking the user to repeat it: ${UTILITY_DIAGNOSTICS_TOOL_NAME} with action read_messages and thread_id "${parentThreadId}" for the thread this came from, or this thread's own id for what happened here since.`,
    'If that thread no longer exists, work with the context you already have instead of asking the user to repeat it.'
  ].join('\n')
}

/**
 * The fork note this turn must carry, or null.
 *
 * Only the fork's first turn is a turn about a fork: once the forked thread has
 * an assistant reply of its own, its conversation has started and the note is
 * history the transcript already holds. A turn that failed before the harness
 * answered persists the user's message but no reply, which is exactly the case
 * that needs the note again, so the test is on an assistant message newer than
 * the fork rather than on the user's.
 */
export async function firstTurnForkNotice(
  database: ForkNoticeQuery,
  threadId: string,
  origin: ForkOrigin
): Promise<string | null> {
  const answered = await database.queryViaWorker(
    `SELECT id FROM agent_messages
     WHERE thread_id = ? AND role = 'assistant' AND created_at >= ?
     LIMIT 1`,
    [threadId, origin.forkedAt],
    1
  )
  // A read that failed is not proof the fork already answered; staying silent
  // would repeat the exact bug this note exists to fix, so send it.
  if (answered.ok && answered.rows.length > 0) return null
  return forkParentNotice(origin.parentThreadId)
}
