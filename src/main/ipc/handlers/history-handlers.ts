import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { validateEntityId, validateHistoryRole } from '../ipc-validation'
import type { HistoryEntry } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

export function registerHistoryHandlers(ctx: IpcHandlerContext): void {
  const { historyEngine } = ctx

  ipcMain.handle(
    'history:append',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      role: unknown,
      content: string,
      metadata?: HistoryEntry['metadata']
    ) =>
      historyEngine.append(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateHistoryRole(role),
        content,
        metadata
      )
  )
  ipcMain.handle('history:load', (_, projectId: string, threadId: string, limit?: number) =>
    historyEngine.load(projectId, threadId, limit)
  )
}
