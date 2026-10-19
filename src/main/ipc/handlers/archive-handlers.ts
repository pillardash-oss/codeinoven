import { emitArchiveChange } from '../../database/archive-events'
import { BrowserWindow } from 'electron'
import type { ArchiveKind, ArchiveTab } from '../../../lib/archives'
import { ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID, INBOX_PROJECT_ID } from '../../../lib/types'
import { sendToRenderer } from '../renderer-delivery'
import { validateEntityId } from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

function archiveKind(value: unknown): ArchiveKind {
  if (value === 'project' || value === 'thread' || value === 'assistant') return value
  throw new TypeError('Invalid archive kind')
}

export function registerArchiveHandlers(ctx: IpcHandlerContext): void {
  const { database } = ctx
  ipcMain.handle('archive:list', async (_, tab: ArchiveTab, offset: unknown = 0) => {
    if (!['projects', 'threads', 'chats', 'assistants'].includes(tab)) {
      throw new TypeError('Invalid archive tab')
    }
    const skip =
      typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    const kind = tab === 'projects' ? 'project' : tab === 'assistants' ? 'assistant' : 'thread'
    const table = kind === 'project' ? 'projects' : kind === 'assistant' ? 'assistants' : 'threads'
    const title = kind === 'thread' ? 'title' : 'name'
    const project = kind === 'thread' ? 'e.project_id' : 'NULL'
    const filter = kind === 'thread' ? `AND e.project_id ${tab === 'chats' ? '=' : '!='} ?` : ''
    const sql =
      kind === 'thread'
        ? `SELECT 'thread' AS kind, e.id, e.title AS name, e.project_id AS projectId,
           COALESCE(a.archived_at, e.updated_at) AS archivedAt,
           COALESCE((SELECT name FROM assistants WHERE id = e.assistant_id),
                    (SELECT name FROM projects WHERE id = e.project_id)) AS ownerName
         FROM threads e LEFT JOIN archives a ON a.kind = 'thread' AND a.entity_id = e.id
         WHERE (e.archived = 1 OR a.entity_id IS NOT NULL) ${filter}
         ORDER BY archivedAt DESC, e.id ASC LIMIT 51 OFFSET ?`
        : `SELECT a.kind, e.id, e.${title} AS name, ${project} AS projectId, a.archived_at AS archivedAt
         FROM archives a JOIN ${table} e ON e.id = a.entity_id
         WHERE a.kind = ?
         ORDER BY a.archived_at DESC, e.id ASC LIMIT 51 OFFSET ?`
    const result = await database.queryViaWorker(
      sql,
      kind === 'thread' ? [INBOX_PROJECT_ID, skip] : [kind, skip],
      51,
      { allowPrimaryFallback: false }
    )
    if (!result.ok) throw new Error('Could not load archives')
    return result.rows
  })

  ipcMain.handle('archive:set', async (_, rawKind: unknown, rawId: unknown, archived: unknown) => {
    const kind = archiveKind(rawKind)
    const id = validateEntityId(rawId, 'Archive ID')
    if (typeof archived !== 'boolean') throw new TypeError('Archived must be a boolean')
    const table = kind === 'project' ? 'projects' : kind === 'assistant' ? 'assistants' : 'threads'
    const found = await database.queryViaWorker(`SELECT id FROM ${table} WHERE id = ?`, [id], 1)
    if (!found.ok || found.rows.length === 0) throw new Error('This item no longer exists')
    if (
      kind === 'project' &&
      [INBOX_PROJECT_ID, ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID].includes(id)
    ) {
      throw new Error('This workspace container cannot be archived')
    }
    // Parking a scope must never leave invisible work running. Existing stop controls
    // settle active work first; this bounded check does not hydrate descendants.
    if (archived) {
      const owner =
        kind === 'project'
          ? 'project_id = ?'
          : kind === 'assistant'
            ? 'assistant_id = ?'
            : '(id = ? OR assistant_task_id = ? OR coordinator_thread_id = ?)'
      const ownerParams = kind === 'thread' ? [id, id, id] : [id]
      const active = await database.queryViaWorker(
        `SELECT id FROM threads WHERE ${owner} AND status IN ('planning','executing','working-paused') LIMIT 1`,
        ownerParams,
        1
      )
      if (!active.ok) throw new Error('Could not check active work')
      if (active.rows.length) throw new Error('Stop active work before archiving this item')
    } else if (kind === 'thread') {
      const parent = await database.queryViaWorker(
        `SELECT a.entity_id FROM threads t JOIN archives a ON
          (a.kind = 'project' AND a.entity_id = t.project_id) OR
          (a.kind = 'assistant' AND a.entity_id = t.assistant_id) OR
          (a.kind = 'thread' AND a.entity_id IN (t.assistant_task_id, t.coordinator_thread_id))
         WHERE t.id = ? LIMIT 1`,
        [id],
        1
      )
      if (!parent.ok) throw new Error('Could not check the parent archive')
      if (parent.rows.length) throw new Error('Restore the parent project or assistant first')
    }
    const statements = [
      {
        sql: archived
          ? 'INSERT INTO archives(kind, entity_id, archived_at) VALUES(?,?,?) ON CONFLICT(kind,entity_id) DO NOTHING'
          : 'DELETE FROM archives WHERE kind = ? AND entity_id = ?',
        params: archived ? [kind, id, Date.now()] : [kind, id]
      }
    ]
    if (kind === 'thread')
      statements.push({
        sql: 'UPDATE threads SET archived = ? WHERE id = ?',
        params: [archived ? 1 : 0, id]
      })
    const result = await database.transactionViaWorker(statements)
    if (!result.ok) throw new Error('Could not update the archive')
    if (archived && kind === 'project') ctx.projectFilesService.disposeProject(id)
    await emitArchiveChange(kind, id, archived)
    ctx.assistantScheduler?.refreshSchedule()
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window.webContents, 'archive:changed', kind, id, archived)
    }
  })
}
