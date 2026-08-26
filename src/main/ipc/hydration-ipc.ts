import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { registerRendererLogIpcHandler } from './renderer-log-ipc'
import type { Database } from '../database/database'
import { StorageEngine } from '../storage/storage-engine'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { NoteRepo } from '../database/repositories/note-repo'
import { validateBoundedInteger, validateBoundedString, validateEntityId } from './ipc-validation'
import type { Thread, ThreadMessageCursor } from '../../lib/types'
import { RepositoryService } from '../git/repository-service'
import { settleThreadBranch, type ThreadBranchDeps } from '../chat/thread-branch-service'
import { broadcastThreadUpdate } from '../chat/thread-events'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Register the small IPC surface the renderer can invoke while its first
 * document is evaluating. This runs before BrowserWindow navigation; feature
 * graphs remain registered by `registerIpcHandlers` after first paint.
 */
export function registerHydrationIpcHandlers(storage: StorageEngine, database: Database): void {
  // Renderer error capture runs from the first renderer statement, so the
  // durable logging bridge must exist before BrowserWindow navigation.
  registerRendererLogIpcHandler()
  const projectManager = new ProjectManager(database)
  const scopeManager = new ScopeManager(database)
  const threadManager = new ThreadManager(database)
  const noteRepo = new NoteRepo(database)
  const branchDeps: ThreadBranchDeps = {
    resolver: new RepositoryService(),
    store: threadManager,
    onSettled: broadcastThreadUpdate
  }

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
    const thread = await threadManager.getThreadViaWorker(projectId, threadId)
    // A thread whose creation-time branch settle never completed (restart or a
    // transient git failure) heals lazily on its next open — off this read's
    // critical path, deduped while in flight.
    if (thread) settleThreadBranch(branchDeps, thread)
    return thread
  })
  ipcMain.handle('note:get', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const thread = await threadManager.getThread(validProjectId, validThreadId)
    if (!thread) return null
    return noteRepo.get(validThreadId)
  })
  ipcMain.handle('thread:listRecent', async (_, rawOptions: unknown) => {
    const options = isRecord(rawOptions) ? rawOptions : {}
    const projectId =
      options.projectId === undefined
        ? undefined
        : validateEntityId(options.projectId, 'Project ID')
    const limit = validateBoundedInteger(options.limit ?? 100, 'Thread list limit', 1, 500)
    const offset = validateBoundedInteger(options.offset ?? 0, 'Thread list offset', 0, 100_000)
    const threads = await threadManager.listThreadsForHydration({
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
  ipcMain.handle(
    'thread:loadMessages',
    async (_, projectId: unknown, threadId: unknown, before?: unknown, limit: unknown = 40) => {
      let safeBefore: ThreadMessageCursor | undefined
      if (before !== undefined) {
        if (!isRecord(before)) throw new TypeError('Message cursor must be an object')
        safeBefore = {
          createdAt: validateBoundedInteger(
            before.createdAt,
            'Message cursor timestamp',
            0,
            Number.MAX_SAFE_INTEGER
          ),
          id: validateBoundedString(before.id, 'Message cursor ID', 1, 512)
        }
      }
      return threadManager.loadMessagePage(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        safeBefore,
        validateBoundedInteger(limit, 'Message page limit', 1, 100)
      )
    }
  )
  ipcMain.handle(
    'thread:loadMessagesAround',
    (_, projectId: unknown, threadId: unknown, anchorId: unknown, limit: unknown = 40) =>
      threadManager.loadMessagePageAround(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateBoundedString(anchorId, 'Message ID', 1, 512),
        validateBoundedInteger(limit, 'Message page limit', 1, 100)
      )
  )
  ipcMain.handle('thread:loadUserMessages', async (_, projectId: unknown, threadId: unknown) =>
    threadManager.loadUserMessages(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
}
