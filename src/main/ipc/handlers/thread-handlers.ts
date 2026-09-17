import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import { join } from 'path'
import { Logger } from '../../system/logger'
import { settleThreadBranch } from '../../chat/thread-branch-service'
import { PROJECT_DATA_DIRECTORY } from '../../../lib/project-artifacts'
import { getConfigRoot } from '../../../lib/utils'
import {
  broadcastThreadDeleted,
  broadcastThreadOperationError,
  broadcastThreadUpdate
} from '../../chat/thread-events'
import {
  validateBoundedInteger,
  validateBoundedString,
  validateBoolean,
  validateCreateThreadInput,
  validateEntityId,
  validateThreadUpdateInput
} from '../ipc-validation'
import { isRecord, requireString } from './shared'
import type { Thread, ThreadMessageCursor } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

export function registerThreadHandlers(ctx: IpcHandlerContext): void {
  const {
    database,
    options,
    projectManager,
    threadCreation,
    threadDeletion,
    threadManager,
    branchBackfillDeps,
    waitForThreadReady
  } = ctx

  ipcMain.handle('thread:create', (_, input: unknown) => {
    const validated = validateCreateThreadInput(input)
    // Optimistic create: the thread object (with its stable id) is returned
    // immediately while persistence, lazy capacity eviction, and branch
    // detection finalize in the background. Only the send path awaits
    // `threadCreation.awaitReady`, so a message sent in this window renders
    // instantly and is queued behind the finalization before reaching the
    // harness   thread creation never waits on the database, and neither does
    // typing, reading, or switching threads.
    const { thread, finalize } = threadManager.prepareCreateThread(validated, {
      onEvictionError: (error) =>
        Logger.error('Thread capacity eviction failed', {
          threadId: thread.id,
          error: String(error)
        })
    })
    threadCreation.begin(
      thread.id,
      async () => {
        await finalize()
        // Broadcast immediately so the new thread opens instantly   the git
        // branch settles through a detached task below and arrives via a later
        // broadcast, never blocking typing, voice, or "Loading conversation...".
        broadcastThreadUpdate(thread)
      },
      () => {
        broadcastThreadDeleted(thread)
        broadcastThreadOperationError(
          'The new thread could not be saved and was removed.',
          thread.projectId,
          thread.id
        )
      }
    )
    threadCreation.beginDetached(thread.id, async (aborted) => {
      if (aborted) return
      settleThreadBranch(branchBackfillDeps, thread)
    })
    return thread
  })
  if (!options.hydrationHandlersRegistered) {
    // The renderer already holds the optimistic thread object, so this is not
    // on the initial paint path. Wait only when this exact thread is still
    // being finalized so background hydration never races durable ownership.
    // A thread whose creation-time settle never completed (restart or a
    // transient git failure) heals lazily on its next open   off this read's
    // critical path, deduped while in flight.
    ipcMain.handle('thread:get', async (_, projectId: string, threadId: string) => {
      const ids = await waitForThreadReady(projectId, threadId)
      const thread = await threadManager.getThread(ids.projectId, ids.threadId)
      if (thread) settleThreadBranch(branchBackfillDeps, thread)
      return thread
    })
  }
  ipcMain.handle('thread:list', (_, projectId: string) => threadManager.listThreads(projectId))
  ipcMain.handle('thread:listAll', () => threadManager.listAllThreads())
  if (!options.hydrationHandlersRegistered) {
    // Bounded hydration query: archived rows never cross IPC and the payload
    // is capped, with the selected project ordered first so the
    // visible workspace renders before the rest of the workspace data.
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
  // Older active tasks are deliberately opt-in and never participate in
  // initial renderer hydration.
  ipcMain.handle('thread:listHistoryPage', async (_, rawOptions: unknown) => {
    const options = isRecord(rawOptions) ? rawOptions : {}
    const projectId =
      options.projectId === undefined
        ? undefined
        : validateEntityId(options.projectId, 'Project ID')
    const limit = validateBoundedInteger(options.limit ?? 50, 'History page limit', 1, 100)
    const offset = validateBoundedInteger(options.offset ?? 0, 'History page offset', 0, 100_000)
    const threads = await threadManager.listAllThreads({
      includeArchived: false,
      limit,
      offset,
      order: 'activity'
    })
    return projectId ? threads.filter((thread) => thread.projectId === projectId) : threads
  })
  ipcMain.handle('threads:search', (_, query: unknown, options?: unknown) => {
    const safeQuery = requireString(query, 'Search query')
    const safeOptions: { projectId?: string; limit?: number } = {}
    if (options !== undefined) {
      if (!isRecord(options)) throw new TypeError('Search options must be an object')
      if (options.projectId !== undefined) {
        safeOptions.projectId = validateEntityId(options.projectId, 'Project ID')
      }
      if (options.limit !== undefined) {
        safeOptions.limit = validateBoundedInteger(options.limit, 'Search limit', 1, 100)
      }
    }
    return threadManager.searchThreads(safeQuery, safeOptions)
  })
  if (!options.hydrationHandlersRegistered) {
    // Mirror-only transcript reads   fast disk access, never touches a harness
    // driver. Hydration registers these before the renderer's first document
    // so a conversation page never waits for optional feature services.
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
        const safeProjectId = validateEntityId(projectId, 'Project ID')
        const safeThreadId = validateEntityId(threadId, 'Thread ID')
        return threadManager.loadMessagePage(
          safeProjectId,
          safeThreadId,
          safeBefore,
          validateBoundedInteger(limit, 'Message page limit', 1, 100)
        )
      }
    )
    // Mirror-only centered transcript read for quick jumps to arbitrary messages.
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
    // Lightweight full user-message history for the header quick-jump list.
    ipcMain.handle('thread:loadUserMessages', async (_, projectId: unknown, threadId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      return threadManager.loadUserMessages(safeProjectId, safeThreadId)
    })
  }
  // Export the conversation transcript as Markdown, off the main thread.
  ipcMain.handle(
    'thread:exportTranscript',
    async (_, projectId: unknown, threadId: unknown, rawOptions: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const thread = await threadManager.getThread(safeProjectId, safeThreadId)
      if (!thread) throw new Error('Thread not found')
      const includeTrace = isRecord(rawOptions)
        ? validateBoolean(rawOptions.includeTrace, 'Include working trace')
        : false

      const project = await projectManager.getProject(safeProjectId)
      const isProject = project?.source === 'local' && Boolean(project.path)
      const destinationDirectory = isProject
        ? join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'transcripts')
        : join(getConfigRoot(), 'chats', safeThreadId, 'tmp', 'transcripts')

      const slug =
        thread.title
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-+|-+$/gu, '')
          .slice(0, 48) || 'conversation'
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
      const destinationPath = join(destinationDirectory, `transcript-${slug}-${stamp}.md`)

      const outcome = await database.exportTranscriptViaWorker(
        safeThreadId,
        includeTrace,
        destinationPath
      )
      if (!outcome.ok || !outcome.path) {
        throw new Error(outcome.error ?? 'The transcript could not be exported')
      }
      return { path: outcome.path, location: isProject ? 'project' : 'chat' }
    }
  )
  ipcMain.handle('thread:update', (_, projectId: string, threadId: string, input) =>
    threadManager.updateThread(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateThreadUpdateInput(input)
    )
  )
  ipcMain.handle('thread:delete', (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    threadDeletion.begin(
      validProjectId,
      validThreadId,
      () => threadManager.deleteThread(validProjectId, validThreadId),
      () => {
        void threadManager.getThreadViaWorker(validProjectId, validThreadId).then((thread) => {
          if (thread) {
            broadcastThreadUpdate(thread)
            broadcastThreadOperationError(
              'The thread cleanup failed. The thread has been restored.',
              validProjectId,
              validThreadId
            )
            return
          }
          broadcastThreadOperationError(
            'The thread was deleted, but some background cleanup did not finish.',
            validProjectId,
            validThreadId
          )
        })
      }
    )
  })
}
