import { join } from 'node:path'
import {
  ASSISTANT_REPORTS_DIRECTORY,
  assistantReportFileName,
  assistantReportIsTerminal,
  buildAssistantReportDocument,
  isAssistantReportThread
} from '../../lib/assistant-reports'
import { assistantThreadWorkspaceDirectory } from '../../lib/project-artifacts'
import type { AssistantPriority, Thread, ThreadStatus } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'

export interface AssistantReportInput {
  /** The settled assistant thread (a run or the user's own task turn). */
  thread: Thread
  /** The title the run chose for its own report. */
  title: string
  /** The task the run belongs to, for the report's header. */
  taskTitle: string
  /** The assistant's name, when the task is grouped. */
  assistantName?: string
  /** The assistant's agreed urgency default, when it has one. */
  priority?: AssistantPriority
  /** The report body: what the run wrote, or the answer it delivered. */
  report: string
  /** How the turn settled. */
  status: ThreadStatus
  /** When the report was written. */
  at: number
}

/**
 * Write one run's declared report to a durable Markdown file under `reports/` in
 * the assistant's own workspace.
 *
 * Only a run that declared a report reaches this: the app never derives a report
 * from an ordinary answer, so an ordinary answer leaves no file behind. Written
 * from the main process rather than handed to the agent as a file-writing step,
 * so the path, the file name and the header stay app-owned and the file always
 * lands where the Workspace files panel mounts it. Returns the storage-relative
 * path that was written, or null when this turn leaves nothing (a Getting started
 * turn, a non-terminal settle, or an empty report).
 */
export async function writeAssistantReport(
  storage: StorageEngine,
  input: AssistantReportInput
): Promise<string | null> {
  if (!isAssistantReportThread(input.thread)) return null
  if (!assistantReportIsTerminal(input.status)) return null

  const report = input.report.trim()
  if (report.length === 0) return null

  const directory = assistantThreadWorkspaceDirectory(input.thread.id, input.thread.assistantId)
  const relativePath = join(
    directory,
    ASSISTANT_REPORTS_DIRECTORY,
    assistantReportFileName(input.at, input.thread.id)
  )
  const document = buildAssistantReportDocument({
    title: input.title,
    taskTitle: input.taskTitle,
    assistantName: input.assistantName,
    priority: input.priority,
    report,
    status: input.status,
    at: input.at
  })
  // writeRaw ensures the reports/ directory exists and writes atomically
  // (`.tmp` then rename), so a half-written report is never left on disk.
  await storage.writeRaw(relativePath, document)
  return relativePath
}
