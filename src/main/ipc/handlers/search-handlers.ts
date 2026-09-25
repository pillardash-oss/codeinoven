import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { requireString } from './shared'
import type { IpcHandlerContext } from './context'

export function registerSearchHandlers(ctx: IpcHandlerContext): void {
  const { projectManager, historyEngine } = ctx

  ipcMain.handle('history:search', (_, query: unknown, projectId?: unknown, limit?: unknown) =>
    historyEngine.search(
      requireString(query, 'Search query'),
      typeof projectId === 'string' ? projectId : undefined,
      typeof limit === 'number' ? limit : 20
    )
  )
  ipcMain.handle('project:search', (_, query: unknown, limit?: unknown) =>
    projectManager.search(
      requireString(query, 'Search query'),
      typeof limit === 'number' ? limit : 20
    )
  )
}
