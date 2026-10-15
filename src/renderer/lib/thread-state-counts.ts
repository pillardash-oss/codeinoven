import {
  coordinatorHasActiveDelegates,
  isOrchestrationChildThread,
  threadTracksReadStatus,
  type Thread
} from '$shared/types'
import { settledThreadReadsUnread } from '$shared/thread-status-policy'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadWorkingForIndicator } from '$lib/components/layout/app-header-thread-status'

/**
 * How a group of threads (a project, an assistant) breaks down by the state its
 * sidebar row must surface. Each state carries its own count so the row can
 * show a dot and a number per state, the way a project row shows working.
 */
export interface ThreadStateCounts {
  /** Threads producing live work right now. */
  working: number
  /** Threads that finished and that the user has not opened yet. */
  unread: number
  /** Threads parked on the user (a permission, question, secret, or review). */
  attention: number
  /** Threads parked on a scheduled retry (a rate limit or provider wait). */
  retry: number
  /** Threads that ended in failure. */
  error: number
}

/**
 * The one state a thread reports in a count: the bucket a strip or a rail badge
 * shows, on the same rule everywhere.
 *
 * Working outranks everything, because a thread producing work is doing what the
 * user asked for whatever it parked on before. A failure is its own bucket
 * rather than part of attention: the number beside a red mark is a total, and a
 * failure nobody has opened is still a failure. A scheduled retry is a wait, not
 * work, and `awaiting_approval` is the thread parked on the user. Every other
 * status is settled, and reports only on the unread axis.
 */
export type ThreadStateBucket = 'working' | 'attention' | 'retry' | 'error' | 'settled'

export function emptyThreadStateCounts(): ThreadStateCounts {
  return { working: 0, unread: 0, attention: 0, retry: 0, error: 0 }
}

/**
 * Where one thread reports right now.
 *
 * Working reads the one live-working rule (`isThreadLiveWorking`, which keeps a
 * thread parked on the user out of the working count however busy its bound
 * session still looks), plus the parked-retry window, so a thread whose
 * auto-retry is hours away stops reading as work in progress. A coordinator
 * whose workers are running is working too: its own harness turn is idle
 * between handoffs, and the row that stands for the delegated work must say so.
 */
export function threadStateBucket(thread: Thread, now = Date.now()): ThreadStateBucket {
  if (
    threadWorkingForIndicator(thread, now) ||
    coordinatorHasActiveDelegates(thread, scopeState.allScopeThreads)
  ) {
    return 'working'
  }
  if (thread.status === 'working-paused') return 'retry'
  if (thread.status === 'failed') return 'error'
  if (thread.status === 'awaiting_approval') return 'attention'
  return 'settled'
}

/** Fold one thread into a group's counts, on the one bucket rule. */
function addThreadStateCount(counts: ThreadStateCounts, thread: Thread, now: number): void {
  switch (threadStateBucket(thread, now)) {
    case 'working':
      counts.working += 1
      break
    case 'attention':
      counts.attention += 1
      break
    case 'retry':
      counts.retry += 1
      break
    case 'error':
      counts.error += 1
      break
    case 'settled':
      break
  }
  // Unread is a separate axis on purpose (a thread can be unread and parked at
  // once), and it is the one unread rule the rail and the strips share: only a
  // completed run nobody has opened is unread, never a failure, a parked card,
  // a ready spec or a run still in flight (see `canMarkThreadUnread`).
  if (settledThreadReadsUnread(thread, thread.read)) counts.unread += 1
}

/**
 * Count threads by the state a sidebar row reports. Working, attention, retry,
 * and error are mutually exclusive: a thread lands in exactly one of them, so a
 * thread is never double-counted. Unread is the separate axis described above.
 *
 * Error counts every failed thread, read or not. Working reads the same rule the
 * rail's badge does, so a row's badge can never disagree with the rail, and
 * retry is the `working-paused` status, the same threads the rail counts as
 * "waiting to retry"; without it an assistant parked on a provider retry wore no
 * indicator at all.
 *
 * For a figure that has to agree with the rail across every project at once, use
 * {@link countThreadStatesByProject}: it counts the one in-memory thread list
 * the rail counts (see its doc for why the per-list version cannot).
 */
export function countThreadStates(threads: Iterable<Thread>, now = Date.now()): ThreadStateCounts {
  const counts = emptyThreadStateCounts()
  for (const thread of threads) addThreadStateCount(counts, thread, now)
  return counts
}

/**
 * Count threads per project, in one pass, for the sidebar's project rows.
 *
 * The rows used to count the folder's own loaded list, and that list is a
 * bounded recent slice: a thread the app knows about (one merged from a board
 * hydration, or one a `thread:updated` broadcast introduced) but that the slice
 * never carried was invisible to the strip, so a project's working figure sat
 * stale until the folder was expanded far enough to page the thread in. The rail
 * counted it the whole time, which is exactly the disagreement the rows cannot
 * afford: the same cheap pass over `scopeState.allScopeThreads` now feeds both.
 *
 * Archived rows and orchestration children are skipped (a child never has a row
 * of its own), and an unread child holds its coordinator's row open exactly as
 * the row badges do (see `coordinatorHasUnreadWorkers`), so no group is ever
 * counted twice.
 */
export function countThreadStatesByProject(
  threads: readonly Thread[],
  now = Date.now()
): Map<string, ThreadStateCounts> {
  return countThreadStatesByGroup(threads, (thread) => thread.projectId, now)
}

/**
 * {@link countThreadStatesByProject} generically: any key a surface groups its
 * rows by (a project id, a thread family). One pass builds every group's counts,
 * and a second short pass folds the unread children in, so the whole sidebar
 * costs two walks of the list however many projects it shows.
 */
export function countThreadStatesByGroup<K>(
  threads: readonly Thread[],
  groupOf: (thread: Thread) => K,
  now = Date.now()
): Map<K, ThreadStateCounts> {
  const groups = new Map<K, ThreadStateCounts>()
  // Coordinators an unread worker holds open. A child's own read state is the
  // coordinator's rule rather than the rail's (see `coordinatorHasUnreadWorkers`):
  // a worker the user never opened holds the row that stands for it open,
  // whatever its outcome. Collected first because a child can appear before or
  // after the row it belongs to.
  const coordinatorsHeldUnread = new Set<string>()
  for (const thread of threads) {
    if (thread.archived) continue
    if (isOrchestrationChildThread(thread)) {
      if (
        thread.coordinatorThreadId !== undefined &&
        threadTracksReadStatus(thread) &&
        !thread.read
      ) {
        coordinatorsHeldUnread.add(thread.coordinatorThreadId)
      }
      continue
    }
    const key = groupOf(thread)
    const counts = groups.get(key) ?? emptyThreadStateCounts()
    addThreadStateCount(counts, thread, now)
    groups.set(key, counts)
  }
  if (coordinatorsHeldUnread.size === 0) return groups
  for (const thread of threads) {
    if (thread.archived || isOrchestrationChildThread(thread)) continue
    if (!coordinatorsHeldUnread.has(thread.id)) continue
    // A coordinator that is unread in its own right already holds the dot: the
    // child only decides whether the row counts once, never twice.
    if (settledThreadReadsUnread(thread, thread.read)) continue
    const counts = groups.get(groupOf(thread))
    if (counts) counts.unread += 1
  }
  return groups
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
