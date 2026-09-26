import type { RoutinePriority, Thread, ThreadStatus } from './types'
import { isAssistantSetupThread, isAssistantThread } from './types'
import { routinePriorityLabel } from './routine-reporting'
import { formatDateTime } from './date-time-format'

/**
 * The durable copy of an assistant run's report.
 *
 * A routine's report is delivered into its run thread, and a thread is capped
 * and evicted, so a report that only ever existed in the transcript is lost.
 * Every assistant task turn that ends with a report therefore also lands one
 * Markdown file under `reports/` in the routine's own workspace
 * (`assistant-cwd/<routineId>/reports/`), which the Workspace files panel
 * mounts. The in-app notification is unchanged: the run still reports in its
 * thread, and the file is the copy that outlives it.
 *
 * Pure and dependency-free (apart from the date and priority labels), so the
 * main-process writer and its tests read the same rules.
 */

/** Subdirectory of an assistant workspace that holds the durable run reports. */
export const ASSISTANT_REPORTS_DIRECTORY = 'reports'

/**
 * Whether a settled turn is one whose report is copied to disk.
 *
 * The routine's Getting started thread authors the how-to; it is an interview,
 * not a run, so nothing about it is a report. Every other assistant-space turn
 * (a scheduled run, a manual run, or the user's own follow-up on a task) leaves
 * a report behind.
 */
export function isAssistantReportThread(thread: Thread): boolean {
  return isAssistantThread(thread) && !isAssistantSetupThread(thread)
}

/**
 * Whether a settled status is terminal enough to publish a report.
 *
 * `completed` and `failed` are the outcomes that end a run. A non-terminal
 * settle (`awaiting_approval`, `working-paused`) still has a run in flight and
 * will settle again, and `interrupted` is the user stopping the run on purpose,
 * so neither writes a report.
 */
export function assistantReportIsTerminal(status: ThreadStatus): boolean {
  return status === 'completed' || status === 'failed'
}

/** Title-cased label of a report's final status. */
export function assistantReportStatusLabel(status: ThreadStatus): string {
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return status
}

/**
 * Deterministic, filesystem-safe, sortable file name for one report:
 * `YYYY-MM-DD-HHmmss-<thread>.md` in the machine's local time.
 *
 * The short thread suffix keeps two runs that settle in the same second   two
 * tasks of one routine, say   from overwriting each other's report.
 */
export function assistantReportFileName(at: number, threadId: string): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
  const clock = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
  return `${stamp}-${clock}-${threadId.slice(0, 6)}.md`
}

export interface AssistantReportDocumentInput {
  /** The task the run belongs to; the report's heading when there is no routine. */
  taskTitle: string
  /** The routine's name, when the task is grouped. */
  routineName?: string
  /** The turn's final answer, verbatim. */
  report: string
  /** How the turn settled. */
  status: ThreadStatus
  /** When the report was written. */
  at: number
  /** The routine's agreed urgency default, when it has one. */
  priority?: RoutinePriority
}

/**
 * The full Markdown document for one report: a small metadata header a reader
 * can scan in the files panel, then the run's final answer verbatim. The header
 * is plain Markdown (no front matter), so the file reads as one document in the
 * app's own preview.
 */
export function buildAssistantReportDocument(input: AssistantReportDocumentInput): string {
  const taskTitle = input.taskTitle.trim()
  const routineName = input.routineName?.trim()
  const heading = routineName || taskTitle || 'Assistant report'

  const meta = [
    `- Run: ${formatDateTime(input.at)}`,
    `- Status: ${assistantReportStatusLabel(input.status)}`
  ]
  if (routineName && routineName !== taskTitle && taskTitle) {
    meta.push(`- Task: ${taskTitle}`)
  }
  if (input.priority) meta.push(`- Agreed urgency: ${routinePriorityLabel(input.priority)}`)

  return [`# Report: ${heading}`, '', ...meta, '', '---', '', input.report.trim(), ''].join('\n')
}
