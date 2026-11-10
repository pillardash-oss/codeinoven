import { unarchivedThreadSql } from '../../lib/archives'
import type { IpcMainInvokeEvent } from 'electron'
import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { registerRendererLogIpcHandler } from './renderer-log-ipc'
import type { Database } from '../database/database'
import { StorageEngine } from '../storage/storage-engine'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { NoteRepo } from '../database/repositories/note-repo'
import { ProjectRepo } from '../database/repositories/project-repo'
import { GLOBAL_BROWSER_PROJECT_ID, isBrowserTabId } from '../../lib/ipc/browser'
import { validateBoundedInteger, validateBoundedString, validateEntityId } from './ipc-validation'
import type { Thread, ThreadMessageCursor } from '../../lib/types'
import { RepositoryService } from '../git/repository-service'
import { settleThreadBranch, type ThreadBranchDeps } from '../chat/thread-branch-service'
import { broadcastThreadBranchUpdated } from '../chat/thread-events'

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
  dataReady: Promise<true>
): void {
  /**
   * Register a hydration channel that must not touch the data stores until the
   * boot has opened them.
   *
   * The window is now created before storage and SQLite, so the renderer can
   * invoke any of these channels before the boot has finished opening them.
   * Every one of them waits on the boot-data gate instead of answering from a
   * database that is not there yet; the gate is published the moment both are
   * open, so a request that beat the boot costs the wait and nothing else.
   */
  const handle = <Args extends unknown[]>(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: Args) => unknown
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      await dataReady
      return listener(event, ...(args as Args))
    })
  }
  // Renderer error capture runs from the first renderer statement, so the
  // durable logging bridge must exist before BrowserWindow navigation.
  registerRendererLogIpcHandler()
  const projectManager = new ProjectManager(database)
  const projectRepo = new ProjectRepo(database)
  const scopeManager = new ScopeManager(database)
  // Create the hidden assistant container before the renderer's first
  // `project:list`, exactly like the inbox. Assistant View reads this project
  // record during its first hydration pass, so ensuring it here keeps that pass
  // off the post-paint feature graph instead of serializing the whole first
  // usable frame behind it. Idempotent: it upserts only when the row is absent.
  const assistantSpaceReady = dataReady.then(() => projectManager.ensureAssistantSpace())
  // The renderer warms the provider catalog for the inbox as soon as the first
  // paint settles, which is before any New chat resolves `project:ensureInbox`.
  // On a cold data root that pass used to discover against a project row that
  // did not exist yet, so the row is created here, ahead of every renderer read.
  const inboxReady = dataReady.then(() => projectManager.ensureInboxProject())
  const threadManager = new ThreadManager(database)
  // The global browser's per-tab agent sidebar is a side chat whose scope
  // resolves against this reserved hidden project and its single thread, so
  // both must exist before the browser view can discover capabilities for a
  // tab. Idempotent, and the thread is created only after its project row.
  const browserSpaceReady = dataReady.then(() => projectManager.ensureGlobalBrowserSpace())
  void browserSpaceReady
    .then(() => threadManager.ensureGlobalBrowserThread())
    .catch(() => undefined)
  const projectsReady = Promise.all([assistantSpaceReady, inboxReady, browserSpaceReady])
  const noteRepo = new NoteRepo(database)
  const branchDeps: ThreadBranchDeps = {
    resolver: new RepositoryService(),
    store: threadManager,
    onSettled: broadcastThreadBranchUpdated
  }

  handle('config:get', () => storage.getConfig())

  // ── The conversation the last session was on ────────────────────────────
  //
  // The selection itself lives in the renderer's recovery storage, which main
  // cannot read. Persisting a copy here lets the boot start the two reads the
  // restored conversation needs (its row and its newest transcript page) while
  // the splash is still up: the renderer's own request then lands on a warm
  // page cache instead of being the database's first sight of that thread.
  // Best effort in both directions - a missing or unreadable file only costs
  // the warmth, never the restore.
  const LAST_THREAD_FILE = 'state/last-thread.json'
  handle('app:rememberThread', (_, rawProjectId: unknown, rawThreadId: unknown) => {
    const reference = {
      projectId: validateEntityId(rawProjectId, 'Project ID'),
      threadId: validateEntityId(rawThreadId, 'Thread ID')
    }
    void storage.write(LAST_THREAD_FILE, reference).catch(() => undefined)
  })
  handle('app:forgetThread', () => storage.removeRaw(LAST_THREAD_FILE).catch(() => undefined))
  void (async (): Promise<void> => {
    await dataReady
    const last = await storage
      .read<{ projectId: string; threadId: string }>(LAST_THREAD_FILE)
      .catch(() => null)
    const projectId = validateEntityId(last?.projectId, 'Project ID')
    const threadId = validateEntityId(last?.threadId, 'Thread ID')
    const thread = await threadManager.getThreadViaWorker(projectId, threadId)
    if (!thread || thread.archived) return
    await threadManager.loadMessagePage(projectId, threadId, undefined, 40)
  })().catch(() => undefined)
  handle('project:get', (_, projectId: string) => projectManager.getProject(projectId))
  handle('project:list', async () => {
    await projectsReady
    // Read on the database worker: this is the first project list the renderer
    // asks for, and a synchronous read here holds the whole main process for as
    // long as the OS takes to serve the statement (see `docs/APP-BIBLE.md`).
    // `queryViaWorker` already falls back to the primary connection, so a null
    // answer means the database refused the read outright: keep the synchronous
    // read's own failure instead of reporting an empty sidebar.
    const projects = await projectRepo.listViaWorkerOrNull()
    return projects ?? projectManager.listProjects()
  })
  handle('project:ensureInbox', () => projectManager.ensureInboxProject())
  // Same channel `registerAssistantHandlers` would register after first paint;
  // registering it on the hydration surface lets the renderer resolve it without
  // waiting for the feature graph, and that handler skips its own registration.
  handle('assistant:ensureSpace', () => projectManager.ensureAssistantSpace())
  handle('project:getIcon', (_, projectId: string) => projectManager.getIconDataUrl(projectId))
  handle('scope:get', (_, projectId: unknown) =>
    scopeManager.getBoardViaWorker(validateEntityId(projectId, 'Project ID'))
  )
  handle('thread:get', async (_, projectId: string, threadId: string) => {
    const visible = await database.queryViaWorker(
      `SELECT id FROM threads WHERE id = ? AND project_id = ? AND ${unarchivedThreadSql()}`,
      [threadId, projectId],
      1
    )
    if (!visible.ok || visible.rows.length === 0) return null
    const thread = await threadManager.getThreadViaWorker(projectId, threadId)
    // A thread whose creation-time branch settle never completed (restart or a
    // transient git failure) heals lazily on its next open   off this read's
    // critical path, deduped while in flight.
    if (thread) settleThreadBranch(branchDeps, thread)
    return thread
  })
  /**
   * Bounded per-project recent threads for first-paint hydration: at most
   * `RECENT_THREADS_PER_PROJECT` per project, with the inbox (Chats) project
   * capped at its configured thread_limit instead. Registered on the early
   * hydration surface because App.svelte invokes it during first paint.
   */
  handle('thread:listRecentPerProject', async () => {
    const threads = await threadManager.listRecentPerProject()
    return threads.filter((thread) => !thread.archived)
  })
  /** Paged threads for one project (project filter precedes the SQL LIMIT). */
  handle('thread:listProjectPage', async (_, rawOptions: unknown) => {
    const options = isRecord(rawOptions) ? rawOptions : {}
    if (options.projectId === undefined) throw new TypeError('Project ID is required')
    const projectId = validateEntityId(options.projectId, 'Project ID')
    const limit = validateBoundedInteger(options.limit ?? 50, 'History page limit', 1, 200)
    const offset = validateBoundedInteger(options.offset ?? 0, 'History page offset', 0, 100_000)
    return threadManager.listProjectThreads(projectId, { limit, offset })
  })
  handle('note:get', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    // The reserved global browser keys its notes by browser tab instead of by a
    // thread; the tab id arrives in the same `threadId` position. Reported in
    // the shape the one Notes panel already reads.
    if (validProjectId === GLOBAL_BROWSER_PROJECT_ID) {
      if (!isBrowserTabId(threadId)) throw new TypeError('Browser tab ID is invalid')
      const note = noteRepo.getForBrowserTab(threadId)
      return note
        ? {
            threadId: note.tabId,
            body: note.body,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt
          }
        : null
    }
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const thread = await threadManager.getThread(validProjectId, validThreadId)
    if (!thread) return null
    return noteRepo.get(validThreadId)
  })
  handle('thread:listRecent', async (_, rawOptions: unknown) => {
    const options = isRecord(rawOptions) ? rawOptions : {}
    const projectId =
      options.projectId === undefined
        ? undefined
        : validateEntityId(options.projectId, 'Project ID')
    const limit = validateBoundedInteger(options.limit ?? 100, 'Thread list limit', 1, 500)
    const offset = validateBoundedInteger(options.offset ?? 0, 'Thread list offset', 0, 100_000)
    const threads = await threadManager.listProjectThreadsForSidebar({
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
  // The Threads view's guarantee set: pinned rows, non-done rows, and every row
  // of a pinned-like scope, independent of the recency window.
  handle('thread:listAlwaysVisible', () => threadManager.listAlwaysVisibleThreads())
  handle(
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
  handle(
    'thread:loadMessagesAround',
    (_, projectId: unknown, threadId: unknown, anchorId: unknown, limit: unknown = 40) =>
      threadManager.loadMessagePageAround(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateBoundedString(anchorId, 'Message ID', 1, 512),
        validateBoundedInteger(limit, 'Message page limit', 1, 100)
      )
  )
  handle('thread:loadUserMessages', async (_, projectId: unknown, threadId: unknown) =>
    threadManager.loadUserMessages(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
}
