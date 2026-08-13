import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import type { Database } from './database/database'
import { StorageEngine } from './storage-engine'
import { ProjectManager } from '../lib/engines/project-manager'
import { ScopeManager } from '../lib/engines/scope-manager'
import { ThreadManager } from '../lib/engines/thread-manager'
import { validateBoundedInteger, validateEntityId } from './ipc-validation'
import type { Thread } from '../lib/types'
import type { ThreadCreationCoordinator } from './thread-creation-coordinator'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Register the small IPC surface the renderer can invoke while its first
 * document is evaluating. This runs before BrowserWindow navigation; feature
 * graphs remain registered by `registerIpcHandlers` after first paint.
 */
export function registerHydrationIpcHandlers(
  storage: StorageEngine,
  database: Database,
  threadCreation?: ThreadCreationCoordinator
): void {
  const projectManager = new ProjectManager(database)
  const scopeManager = new ScopeManager(database)
  const threadManager = new ThreadManager(database)

  ipcMain.handle('config:get', () => storage.getConfig())
  ipcMain.handle('project:get', (_, projectId: string) => projectManager.getProject(projectId))
  ipcMain.handle('project:list', () => projectManager.listProjects())
  ipcMain.handle('project:ensureInbox', () => projectManager.ensureInboxProject())
  ipcMain.handle('project:getIcon', (_, projectId: string) =>
    projectManager.getIconDataUrl(projectId)
  )
  ipcMain.handle('scope:get', (_, projectId: unknown) =>
    scopeManager.getBoard(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('thread:get', async (_, projectId: string, threadId: string) => {
    // A thread just created optimistically may still be finalizing; wait for
    // its row before answering so the renderer never reads a phantom thread.
    await threadCreation?.awaitReady(threadId)
    return threadManager.getThread(projectId, threadId)
  })
  ipcMain.handle('thread:listRecent', async (_, rawOptions: unknown) => {
    const options = isRecord(rawOptions) ? rawOptions : {}
    const projectId =
      options.projectId === undefined
        ? undefined
        : validateEntityId(options.projectId, 'Project ID')
    const limit = validateBoundedInteger(options.limit ?? 100, 'Thread list limit', 1, 500)
    const offset = validateBoundedInteger(options.offset ?? 0, 'Thread list offset', 0, 100_000)
    const threads = await threadManager.listAllThreads({
      includeArchived: false,
      limit,
      offset,
      order: 'activity'
    })
    if (!projectId) return threads
    const preferred: Thread[] = []
    const rest: Thread[] = []
    for (const thread of threads) {
      ;(thread.projectId === projectId ? preferred : rest).push(thread)
    }
    return [...preferred, ...rest]
  })
}
