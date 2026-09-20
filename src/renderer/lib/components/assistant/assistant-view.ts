import { describeRelativeTime, type MissedRun, type Thread } from '$shared/types'

/**
 * Pure presentation logic for Assistant View, kept out of the components so the
 * row/tab rules can be unit-tested without a DOM.
 */

/** The Missed runs tab only exists when at least one run was missed. */
export function missedTabVisible(runs: readonly MissedRun[]): boolean {
  return runs.length > 0
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
