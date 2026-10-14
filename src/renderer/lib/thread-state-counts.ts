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
  /** Threads that ended in failure. */
  error: number
}

export interface CountThreadStatesOptions {
  /**
   * Also count unread threads. Off by default: a project row reports working,
   * attention, and error only, while a routine row also wears the green unread
   * count its inline dot used to show.
   */
  includeUnread?: boolean
}

export function emptyThreadStateCounts(): ThreadStateCounts {
  return { working: 0, unread: 0, attention: 0, error: 0 }
}

/**
 * Count threads by the state a sidebar row reports. Working, attention, and
 * error are mutually exclusive: a live-working thread is never counted as
 * attention, so those three never double-count the same thread. Unread is a
 * separate axis (a thread can be unread and parked at once), so it is counted
 * on its own and only when the caller asks for it.
 *
 * Working reads the one live-working rule, so a row's badge can never disagree
 * with the thread rows it summarizes.
 */
export function countThreadStates(
  threads: Iterable<Thread>,
  options: CountThreadStatesOptions = {}
): ThreadStateCounts {
  const counts = emptyThreadStateCounts()
  for (const thread of threads) {
    if (threadHasVisibleWork(thread)) counts.working += 1
    else if (thread.status === 'failed') counts.error += 1
    else if (thread.status === 'awaiting_approval') counts.attention += 1
    if (options.includeUnread && !thread.read) counts.unread += 1
  }
  return counts
}

/** Whether a breakdown has anything to show, so a row can skip the cluster. */
export function hasThreadStateCounts(counts: ThreadStateCounts): boolean {
  return (
    counts.working > 0 || counts.unread > 0 || counts.attention > 0 || counts.error > 0
  )
}
