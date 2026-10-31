import { assistantResultText } from './assistant-result'
import type { AssistantPriority, ResolvedUtility, Thread, ThreadStatus } from './types'
import { isAssistantSetupThread, isAssistantThread } from './types'
import { assistantPriorityLabel } from './assistant-reporting'
import { formatDateTime } from './date-time-format'

/**
 * The durable copy of an assistant run's report.
 *
 * An assistant's report is delivered into its run thread, and a thread is capped
 * and evicted, so a report that only ever existed in the transcript is lost.
 * A run that produced a report therefore also lands one Markdown file under
 * `reports/` in the assistant's own workspace
 * (`assistant-cwd/<assistantId>/reports/`), which the Workspace files panel
 * mounts.
 *
 * Deciding what a report is belongs to the run, never to the app. Most turns are
 * not reports (a question, a check-in, a status line, an acknowledgement, an
 * ordinary reply), and wrapping one in a report document invents a deliverable
 * nobody wrote. So the run declares a report through the capability below, and
 * the app only files what it declared.
 *
 * Pure and dependency-free (apart from the date and priority labels), so the
 * main-process writer and its tests read the same rules.
 */

/** Subdirectory of an assistant workspace that holds the durable run reports. */
export const ASSISTANT_REPORTS_DIRECTORY = 'reports'

/** The app-owned capability a run declares its report through. */
export const ASSISTANT_REPORT_UTILITY_ID = 'cio:assistant-report'

/** Ceiling for the title a run gives its own report. */
export const ASSISTANT_REPORT_TITLE_LIMIT = 120

/** Ceiling for a report body the run writes instead of filing its answer. */
export const ASSISTANT_REPORT_BODY_LIMIT = 200_000

/**
 * The report capability, bound to the live run turn   it is never installed
 * globally and never appears in the thread's utility bank, exactly like the
 * Getting started checkpoint.
 *
 * The run is the only party that knows whether it just produced a report, so the
 * capability asks for the decision and nothing else: the title, and optionally a
 * body when the report is more than the answer the user is about to read. The app
 * owns the path, the file name and the metadata header, so no run has to know how
 * the workspace is laid out, and no run can file a report somewhere the Workspace
 * files panel does not mount.
 */
export function assistantReportUtility(
  harnessId: string,
  projectId: string,
  threadId: string
): ResolvedUtility {
  const binding = { harnessId, strategy: 'skill' as const }
  return {
    binding,
    utility: {
      id: ASSISTANT_REPORT_UTILITY_ID,
      kind: 'skill',
      name: 'Run report',
      description:
        'File this run\u2019s output as a report the user can read again after the thread is gone.',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'thread', projectId, threadId },
      config: {
        instructions:
          'Use save_report with { title } only when this turn produced a report: a digest, findings, an analysis, or a finished draft the user will want to read again. Never use it for a question, a check-in, a status line, an acknowledgement, or an ordinary reply. The application writes the file when the turn settles, so do not describe the file path or tell the user a report was saved.'
      },
      credentials: [],
      harnessBindings: [binding],
      appOwned: true,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

export const ASSISTANT_REPORT_OPERATIONS = [
  {
    name: 'save_report',
    description:
      'Declare this turn\u2019s output as a report, and only when it genuinely is one: a digest, findings, an analysis, or a finished draft the user will want to read again. The application files it under reports/ in the assistant\u2019s workspace when the turn settles, with a header naming the run, the task and the agreed urgency. Never call it for a question, a check-in, a status line, an acknowledgement, or an ordinary chat reply: those leave no report.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_REPORT_TITLE_LIMIT,
          description: 'A short title for the report, in the user\u2019s own language.'
        },
        markdown: {
          type: 'string',
          minLength: 1,
          maxLength: ASSISTANT_REPORT_BODY_LIMIT,
          description:
            'Optional full report body. Omit it to file exactly the answer the user is about to read.'
        }
      },
      required: ['title'],
      additionalProperties: false
    }
  }
]

/**
 * Whether a settled turn is one that may file a report at all.
 *
 * The assistant's Getting started thread authors the knowledge; it is an interview,
 * not a run, so nothing about it is a report. Every other assistant-space turn
 * (a scheduled run, a manual run, or the user's own follow-up on a task) may
 * declare one, and files nothing when it does not.
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
 * tasks of one assistant, say   from overwriting each other's report.
 */
export function assistantReportFileName(at: number, threadId: string): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-')
  const clock = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
  return `${stamp}-${clock}-${threadId.slice(0, 6)}.md`
}

/**
 * The path a filed report is cited by inside its own thread.
 *
 * An assistant thread mounts `assistant-cwd/<assistantId>` as its workspace, so
 * the report is cited relative to that mount. The renderer resolves a cited path
 * against the mount it is rendered in, so this string is what turns the
 * announcement into a link that opens the file, and it never leaks the storage
 * layout to the reader.
 */
export function assistantReportCitation(fileName: string): string {
  return `${ASSISTANT_REPORTS_DIRECTORY}/${fileName}`
}

/**
 * The one line the app publishes under a run to announce its filed report.
 *
 * The run is told never to name the path or claim a report was saved, because
 * the app owns both, so the app is what announces the file. Without this line a
 * filed report is invisible unless the reader happens to browse the workspace
 * panel, which is how a run's report went unread.
 */
export function assistantReportAnnouncement(title: string, citation: string): string {
  const name = title.trim().slice(0, ASSISTANT_REPORT_TITLE_LIMIT) || 'Report'
  return `Report filed: **${name}**\n\n\`${citation}\` stays in this assistant's workspace, so it outlives this run's thread.`
}

export interface AssistantReportDocumentInput {
  /** The title the run chose for its own report. */
  title: string
  /** The task the run belongs to, named in the header. */
  taskTitle: string
  /** The assistant's name, when the task is grouped. */
  assistantName?: string
  /** The report body, or the turn's raw final answer; boundaries are resolved below. */
  report: string
  /** How the turn settled. */
  status: ThreadStatus
  /** When the report was written. */
  at: number
  /** The assistant's agreed urgency default, when it has one. */
  priority?: AssistantPriority
}

/**
 * The full Markdown document for one report: a small metadata header a reader
 * can scan in the files panel, then the report the run declared. The header
 * is plain Markdown (no front matter), so the file reads as one document in the
 * app's own preview. The heading is the run's own title, because a report nobody
 * named is a report nobody can find again.
 */
export function buildAssistantReportDocument(input: AssistantReportDocumentInput): string {
  const title = input.title.trim()
  const taskTitle = input.taskTitle.trim()
  const assistantName = input.assistantName?.trim()

  const meta = [
    `- Run: ${formatDateTime(input.at)}`,
    `- Status: ${assistantReportStatusLabel(input.status)}`
  ]
  if (assistantName && assistantName !== taskTitle && taskTitle) {
    meta.push(`- Task: ${taskTitle}`)
  }
  if (input.priority) meta.push(`- Agreed urgency: ${assistantPriorityLabel(input.priority)}`)

  return [
    `# ${title || assistantName || taskTitle || 'Report'}`,
    '',
    ...meta,
    '',
    '---',
    '',
    assistantResultText(input.report),
    ''
  ].join('\n')
}
