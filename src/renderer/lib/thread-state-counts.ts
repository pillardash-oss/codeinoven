import type { Thread } from '$shared/types'
import { threadHasVisibleWork } from './components/workspace/workspace-thread-helpers'

/**
 * How a group of threads (a project, a routine) breaks down by the state its
 * sidebar row must surface.
 *
 * A thread lands in exactly one bucket: a live-working thread is never counted
 * as attention, so the totals can never double-count the same thread.
 */
export interface ThreadStateCounts {
  /** Threads producing live work right now. */
  working: number
  /** Threads parked on the user (a permission, question, secret, or review). */
  attention: number
  /** Threads that ended in failure. */
  error: number
}

export function emptyThreadStateCounts(): ThreadStateCounts {
  return { working: 0, attention: 0, error: 0 }
}

/**
 * Count threads by the state a sidebar row reports. It reads the one
 * live-working rule (`threadHasVisibleWork`), so a row's badge can never
 * disagree with the thread rows it summarizes: a thread parked on the user is
 * attention, never working, and a failed thread is an error.
 */
export function countThreadStates(threads: Iterable<Thread>): ThreadStateCounts {
  const counts = emptyThreadStateCounts()
  for (const thread of threads) {
    if (threadHasVisibleWork(thread)) counts.working += 1
    else if (thread.status === 'failed') counts.error += 1
    else if (thread.status === 'awaiting_approval') counts.attention += 1
  }
  return counts
}

/** Whether a breakdown has anything to show, so a row can skip the cluster. */
export function hasThreadStateCounts(counts: ThreadStateCounts): boolean {
  return counts.working > 0 || counts.attention > 0 || counts.error > 0
}
