import { describeRelativeTime, type MissedRun, type Thread } from '$shared/types'
import { threadStatusPolicy } from '$shared/thread-status-policy'

/**
 * Pure presentation logic for Assistant View, kept out of the components so the
 * row/tab rules can be unit-tested without a DOM.
 */

/** The Missed runs tab only exists when at least one run was missed. */
export function missedTabVisible(runs: readonly MissedRun[]): boolean {
  return runs.length > 0
}

/** Group key for missed runs whose task belongs to no routine. */
export const UNGROUPED_MISSED_RUNS = '__ungrouped__'

/** One routine's pending missed runs. */
export interface MissedRunGroup {
  /** Routine id, or `UNGROUPED_MISSED_RUNS` for routine-less tasks. */
  key: string
  /** Routine name, or the neutral label used for routine-less tasks. */
  label: string
  runs: MissedRun[]
}

/**
 * Missed runs are surfaced per routine: one group per owning routine, plus a
 * single group for routine-less tasks. Group order follows first appearance,
 * which is the store's due-time order.
 */
export function groupMissedRunsByRoutine(
  runs: readonly MissedRun[],
  routineNameById: ReadonlyMap<string, string>
): MissedRunGroup[] {
  const groups = new Map<string, MissedRunGroup>()
  for (const run of runs) {
    const key = run.routineId ?? UNGROUPED_MISSED_RUNS
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        label: run.routineId
          ? (routineNameById.get(run.routineId) ?? 'Routine')
          : 'Tasks without a routine',
        runs: []
      }
      groups.set(key, group)
    }
    group.runs.push(run)
  }
  return [...groups.values()]
}

/** Whether a task row shows the missed badge. */
export function taskHasMissed(runs: readonly MissedRun[]): boolean {
  return runs.length > 0
}

/**
 * Line 2 of a task row: the next intended run for a scheduled task, else the
 * last run, else "Not scheduled".
 */
export function taskRunLine(
  task: Pick<Thread, 'lastRunAt'>,
  nextRunAt: number | null,
  now: number
): string {
  if (nextRunAt !== null) return `Next run ${describeRelativeTime(nextRunAt, now)}`
  if (task.lastRunAt !== undefined) return `Last run ${describeRelativeTime(task.lastRunAt, now)}`
  return 'Not scheduled'
}

/**
 * The task row icon key: a custom icon when the task carries one, otherwise the
 * BotMessageSquare fallback.
 */
export function taskRowIconKey(task: Pick<Thread, 'assistantIconType'>): 'custom' | 'bot' {
  return task.assistantIconType ? 'custom' : 'bot'
}

/** Overall state passed to the shared thread hover popover. */
export type TaskPopoverState =
  | 'unread'
  | 'temporary-unread'
  | 'read'
  | 'todo'
  | 'completed'
  | 'working'
  | 'working-paused'
  | 'spec'
  | 'approval'
  | 'error'
  | 'scheduled'

/**
 * Assistant tasks reuse the regular thread hover popover, which takes an
 * overall state rather than a status. The mapping mirrors the thread row's own
 * badge priority: unread wins, then the status policy's tone.
 */
export function taskPopoverState(task: Pick<Thread, 'status' | 'read'>): TaskPopoverState {
  if (!task.read) return 'unread'
  switch (threadStatusPolicy(task.status).tone) {
    case 'working':
      return 'working'
    case 'working-paused':
      return 'working-paused'
    case 'attention':
      return 'approval'
    case 'spec':
      return 'spec'
    case 'error':
      return 'error'
    case 'done':
      return 'completed'
    default:
      return 'todo'
  }
}
