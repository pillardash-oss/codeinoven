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

/**
 * Fence tag or leading body line naming a block as a how-to: `how-to`,
 * `howto`, `how_to`, `how to`, each optionally followed by `: <title>` or
 * `- <title>`. A trailing `.md` or other word is rejected.
 */
const HOW_TO_TAG = /^how[ _-]?to(?:[ \t]*[-:][^\n]*)?$/i

/** A leading `how-to` marker line inside a block, e.g. `how-to: Slack digest`. */
const HOW_TO_MARKER_LINE = /^[ \t]*how[-_]?to\b[ \t]*(?:[-:][ \t]*[^\n]*)?$/

/** A fence line: indent, a backtick run of 3+, and an optional tag (no backticks). */
const FENCE_LINE = /^[ \t]*(`{3,})[ \t]*([^`]*)$/

interface FenceLine {
  /** Index of the fence line in the message. */
  index: number
  /** Backtick run length   a closing fence must be at least this long. */
  length: number
  /** Everything after the backticks, trimmed; empty for an untagged fence. */
  tag: string
}

/** Every fence line in the message, in order. */
function collectFences(lines: readonly string[]): FenceLine[] {
  const fences: FenceLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = FENCE_LINE.exec(lines[index] ?? '')
    if (!match) continue
    fences.push({
      index,
      length: (match[1] ?? '').length,
      tag: (match[2] ?? '').trim()
    })
  }
  return fences
}

/** The first non-blank line of a block body, or null when the body is blank. */
function firstNonEmptyLine(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (line.trim() !== '') return line
  }
  return null
}

/** Drop a leading `how-to` marker line so the saved how-to is instructions only. */
function stripHowToMarker(body: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() !== '')
  if (start === -1) return ''
  const content = HOW_TO_MARKER_LINE.test(lines[start])
    ? lines.slice(start + 1)
    : lines.slice(start)
  return content.join('\n').trim()
}

/** Whether a fence opens a how-to block: a `how-to` tag, or a leading marker line. */
function opensHowTo(fence: FenceLine, lines: readonly string[]): boolean {
  if (HOW_TO_TAG.test(fence.tag)) return true
  const head = firstNonEmptyLine(lines.slice(fence.index + 1))
  return head !== null && HOW_TO_MARKER_LINE.test(head)
}

/**
 * The how-to draft inside one assistant message, or null when it holds none.
 *
 * The authoring contract asks for a fence tagged `how-to`, but a model also
 * opens a bare fence and starts the body with a `how-to: <title>` line, so both
 * shapes are accepted. The newest how-to block in the text wins, and a leading
 * marker line is stripped so the saved how-to is instructions only.
 *
 * A how-to is a step-by-step instruction set, so it often carries its own code
 * fences (a command to run, a payload to post). Matching the block to its first
 * closing fence would silently truncate it there, so tagged inner fences are
 * tracked as nesting and only an untagged fence at the outer depth closes the
 * block. Prose written after the block is left out of the saved how-to.
 */
export function extractHowToDraft(text: string): string | null {
  const lines = text.split('\n')
  const fences = collectFences(lines)

  let lastOpening: FenceLine | null = null
  for (const fence of fences) {
    if (opensHowTo(fence, lines)) lastOpening = fence
  }
  if (!lastOpening) return null
  const open = lastOpening

  let depth = 1
  for (const fence of fences) {
    if (fence.index <= open.index) continue
    if (fence.length < open.length) continue
    if (fence.tag !== '') {
      // A tagged fence is an inner opening (a nested example), not the close.
      depth += 1
      continue
    }
    depth -= 1
    if (depth > 0) continue
    const content = stripHowToMarker(lines.slice(open.index + 1, fence.index).join('\n'))
    return content || null
  }
  return null
}

/**
 * The newest how-to draft across assistant messages, newest message first.
 * Messages are given as plain text so this stays free of thread plumbing.
 */
export function latestHowToDraft(assistantTexts: readonly string[]): string | null {
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const draft = extractHowToDraft(assistantTexts[index] ?? '')
    if (draft) return draft
  }
  return null
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
