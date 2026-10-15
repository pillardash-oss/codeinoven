import type { Thread } from '$shared/types'
import { threadHasVisibleWork } from './components/workspace/workspace-thread-helpers'

/**
 * How a group of threads (a project, a routine) breaks down by the state its
 * sidebar row must surface. Each state carries its own count so the row can
 * show a dot and a number per state, the way a project row shows working.
 */
export interface ThreadStateCounts {
  /** Threads producing live work right now. */
  working: number
  /** Threads the user has not read yet. */
  unread: number
  /** Threads parked on the user (a permission, question, secret, or review). */
  attention: number
  /** Threads parked on a scheduled retry (a rate limit or provider wait). */
  retry: number
  /** Threads that ended in failure. */
  error: number
}

export function emptyThreadStateCounts(): ThreadStateCounts {
  return { working: 0, unread: 0, attention: 0, retry: 0, error: 0 }
}

/**
 * Count threads by the state a sidebar row reports. Working, attention, retry,
 * and error are mutually exclusive: a thread lands in exactly one of them, so a
 * thread is never double-counted. Unread is a separate axis (a thread can be
 * unread and parked at once), so it is counted on its own, and every row that
 * renders the strip shows it on the same terms as working.
 *
 * Working reads the one live-working rule, so a row's badge can never disagree
 * with the thread rows it summarizes. Retry is the `working-paused` status, the
 * same threads the rail counts as "waiting to retry"; without it a routine
 * parked on a provider retry wore no indicator at all.
 */
export function countThreadStates(threads: Iterable<Thread>): ThreadStateCounts {
  const counts = emptyThreadStateCounts()
  for (const thread of threads) {
    if (threadHasVisibleWork(thread)) counts.working += 1
    // A settled thread the user has not read reads as unread, so it leaves the
    // error axis for the unread one, matching its row badge.
    else if (thread.status === 'failed' && thread.read) counts.error += 1
    else if (thread.status === 'awaiting_approval') counts.attention += 1
    else if (thread.status === 'working-paused') counts.retry += 1
    if (!thread.read) counts.unread += 1
  }
  return counts
}

/** Whether a breakdown has anything to show, so a row can skip the cluster. */
export function hasThreadStateCounts(counts: ThreadStateCounts): boolean {
  return (
    counts.working > 0 ||
    counts.unread > 0 ||
    counts.attention > 0 ||
    counts.retry > 0 ||
    counts.error > 0
  )
}
