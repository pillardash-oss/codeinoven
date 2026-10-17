import { randomUUID } from 'node:crypto'
import type { Database } from '../database/database'
import { Logger } from '../system/logger'

interface WorkPathNotice {
  directory: string
  destination: string
  revision: string
}

/** Included in the same transaction that rebases the thread's work records. */
export function workPathNoticeStatements(
  projectId: string,
  threadId: string,
  from: string,
  to: string
): Array<{ sql: string; params: unknown[] }> {
  const revision = randomUUID()
  return [
    {
      sql: `UPDATE work_path_notices SET destination = ?, revision = ?
        WHERE project_id = ? AND thread_id = ? AND destination = ?`,
      params: [to, revision, projectId, threadId, from]
    },
    {
      sql: `INSERT INTO work_path_notices (project_id, thread_id, directory, destination, revision)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
          SELECT 1 FROM work_path_notices WHERE project_id = ? AND thread_id = ? AND destination = ?
        ) ON CONFLICT(project_id, thread_id, directory)
        DO UPDATE SET destination = excluded.destination, revision = excluded.revision`,
      params: [projectId, threadId, from, to, revision, projectId, threadId, to]
    },
    {
      sql: 'DELETE FROM work_path_notices WHERE project_id = ? AND thread_id = ? AND directory = destination',
      params: [projectId, threadId]
    }
  ]
}

/** Read at dispatch time, so an undoable held steer receives moves made while waiting. */
export async function deliverWithWorkPathNotices(input: {
  database: Database
  projectId: string
  threadId: string
  text: string
  deliver: (text: string) => Promise<void>
  recordTransport?: (text: string) => Promise<void>
}): Promise<void> {
  const pending = await input.database.queryViaWorker(
    `SELECT directory, destination, revision FROM work_path_notices
      WHERE project_id = ? AND thread_id = ? ORDER BY directory`,
    [input.projectId, input.threadId],
    0
  )
  if (!pending.ok) throw new Error('Could not read pending work path updates')
  const notices = pending.rows as unknown as WorkPathNotice[]
  if (notices.length === 0) {
    await input.deliver(input.text)
    return
  }
  const text = [
    '[update notice]',
    'The user moved or renamed these design/video folders in this project:',
    ...notices.map(
      (notice) => `${JSON.stringify(notice.directory)} -> ${JSON.stringify(notice.destination)}`
    ),
    'Continue working in the new locations. Use them for all reads, edits, shell commands, previews and checkpoints. Paths in earlier messages are outdated. The project default save folder is unchanged by an individual move.',
    '',
    '[user message]',
    input.text
  ].join('\n')
  await input.recordTransport?.(text)
  await input.deliver(text)
  // A failed dispatch leaves notices pending. Revision matching also preserves
  // another move committed while the harness was accepting this message.
  try {
    const acknowledged = await input.database.transactionViaWorker(
      notices.map((notice) => ({
        sql: `DELETE FROM work_path_notices WHERE project_id = ? AND thread_id = ? AND directory = ? AND revision = ?`,
        params: [input.projectId, input.threadId, notice.directory, notice.revision]
      }))
    )
    if (!acknowledged.ok) throw new Error(acknowledged.error ?? 'Acknowledgement failed')
  } catch (error) {
    // Delivery already succeeded. An acknowledgement failure must not cause the
    // caller to resend the user's message; the harmless notice can repeat later.
    Logger.error('Delivered work path updates could not be acknowledged', {
      projectId: input.projectId,
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
