import { app, dialog, shell, BrowserWindow, nativeImage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'path'
import { atomicWrite, getConfigRoot } from '../../../lib/utils'
import { posixDirname } from '../../../lib/paths'
import { Logger } from '../../system/logger'
import { openWithService } from '../../system/open-with-service'
import { sendToRenderer } from '../renderer-delivery'
import { ScopeToolService } from '../../workspaces/scope-tool-service'
import type { ScopeToolServiceOptions } from '../../workspaces/scope-tool-service'
import { AssignmentWorkerScopeService } from '../../workspaces/assignment-worker-scope-service'
import {
  validateBoolean,
  validateBoundedString,
  validateConfirmationToken,
  validateCreateProjectInput,
  validateEntityId,
  validateScopeAdoptInput,
  validateScopeAppearancePatch,
  validateScopeCollapsePatch,
  validateScopeCreateInput,
  validateScopeLifecycleAction,
  validateScopeMergeMode,
  validateScopeOrderIds,
  validateScopeTarget,
  validateScopeWorktreeCreateInput,
  validateSourcePath,
  validateWorktreeDefaults
} from '../ipc-validation'
import { requireString, validateStringArray } from './shared'
import { EDITOR_IDS } from './config-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type {
  CreateProjectInput,
  DirectoryPreviewSession,
  EditorId,
  ScopeAgentConfirmationRequest,
  ScopeTarget,
  ScopeWorktreeProgress,
  ScopeWorktreeProgressEvent
} from '../../../lib/types'
import type { IpcHandlerContext } from './context'
import { sanitizeCustomSvg } from '../../../lib/custom-svg'
import { randomUUID } from 'node:crypto'

/** Upper bound on one in-app "open these paths" request (a drag selection). */
const MAX_OPEN_PATHS = 64

/** Document types the directory preview can open directly at their own URL. */
const HTML_PREVIEW_PATTERN = /\.(?:html?|xhtml)$/iu

/** Resolve the native drag icon. Prefer the dragged file's own Finder icon so
 *  the drag ghost keeps the file's look; fall back to the app icon. */
async function resolveDragIcon(firstPath?: string): Promise<Electron.NativeImage> {
  if (firstPath) {
    try {
      const icon = await app.getFileIcon(firstPath, { size: 'normal' })
      if (!icon.isEmpty()) return icon
    } catch {
      // Fall back to the app icon below.
    }
  }
  const candidates = [
    join(app.getAppPath(), 'out', 'renderer', 'icon.png'),
    join(app.getAppPath(), 'src', 'renderer', 'static', 'icon.png')
  ]
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const icon = nativeImage.createFromBuffer(readFileSync(candidate))
      if (!icon.isEmpty()) return icon
    } catch {
      // Try the next candidate path.
    }
  }
  throw new Error('The native file drag icon is unavailable')
}

export function registerProjectHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    database,
    chatEngine,
    options,
    projectManager,
    scopeManager,
    scopeWorktreeService,
    projectFilesService,
    threadManager,
    editorService,
    repositoryService,
    privilegedIpc,
    privileged,
    scopeThreadLifecycle,
    gitService,
    vault,
    gitCredentialRef
  } = ctx

  ipcMain.handle('icon-library:list', () =>
    database
      .all<{ id: string; name: string; svg: string; created_at: number }>(
        'SELECT id, name, svg, created_at FROM custom_icons ORDER BY created_at, id'
      )
      .map((icon) => ({ id: icon.id, name: icon.name, svg: icon.svg, createdAt: icon.created_at }))
  )
  ipcMain.handle('icon-library:add', (_, rawName: unknown, rawSvg: unknown) => {
    const name = requireString(rawName, 'Icon name').trim().slice(0, 80)
    if (!name) throw new TypeError('Icon name is required')
    const svg = sanitizeCustomSvg(requireString(rawSvg, 'Custom SVG'))
    const id = randomUUID()
    const createdAt = Date.now()
    database.run(
      'INSERT INTO custom_icons(id, name, svg, created_at) VALUES(?, ?, ?, ?)',
      id,
      name,
      svg,
      createdAt
    )
    return { id, name, svg, createdAt }
  })

  const worktreeProgressRelay =
    (event: IpcMainInvokeEvent, target: ScopeTarget) =>
    (progress: ScopeWorktreeProgress): void => {
      const payload: ScopeWorktreeProgressEvent = {
        projectId: target.projectId,
        scopeBucketId: target.scopeBucketId,
        origin: 'user',
        ...progress
      }
      sendToRenderer(event.sender, 'scope:worktree:progress', payload)
    }
  // Constructed after the scope resolver so interactive file surfaces can
  // resolve managed worktree roots instead of always reading the project root.

  const pendingScopeConfirmations = new Map<string, (approved: boolean) => void>()

  const requestScopeConfirmation = async (
    request: ScopeAgentConfirmationRequest
  ): Promise<boolean> => {
    const windows = BrowserWindow.getAllWindows().filter(
      (window) => !window.isDestroyed() && !window.webContents.isDestroyed()
    )
    if (windows.length === 0) return false
    // Held in a local because the executor's `resolve` is not in scope where the
    // expiry timer fires; this file already has a path `resolve` helper.
    let settle: ((approved: boolean) => void) | null = null
    const answer = new Promise<boolean>((resolve) => {
      settle = resolve
      pendingScopeConfirmations.set(request.requestId, resolve)
    })
    for (const window of windows) {
      sendToRenderer(window.webContents, 'scope:agentConfirmation', request)
    }
    // The dialog removes its own entry when answered; the timeout is what keeps
    // a closed or reloaded renderer from parking the agent's turn forever.
    const timeout = setTimeout(
      () => {
        if (pendingScopeConfirmations.delete(request.requestId)) settle?.(false)
      },
      Math.max(0, request.expiresAt - Date.now())
    )
    try {
      return await answer
    } finally {
      clearTimeout(timeout)
      pendingScopeConfirmations.delete(request.requestId)
    }
  }

  /** A scope change, whoever caused it, invalidates the board in every window. */
  const broadcastScopeBoardChanged: ScopeToolServiceOptions['onBoardChanged'] = (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window.webContents, 'scope:boardChanged', event)
    }
  }
  /** Every worktree run, from any surface, streams into the same docked job panel. */
  const broadcastWorktreeProgress: ScopeToolServiceOptions['onProgress'] = (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      sendToRenderer(window.webContents, 'scope:worktree:progress', event)
    }
  }

  const scopeToolService = new ScopeToolService(
    scopeWorktreeService,
    scopeManager,
    projectManager,
    {
      getStatus: (projectPath) => gitService.getStatus(projectPath),
      syncWith: (projectPath, options) => gitService.syncWith(projectPath, options)
    },
    {
      scopeThreads: scopeThreadLifecycle,
      requestConfirmation: requestScopeConfirmation,
      onBoardChanged: broadcastScopeBoardChanged,
      onProgress: broadcastWorktreeProgress,
      resolveGitToken: async (projectId) => {
        const ref = gitCredentialRef(projectId)
        return (await vault.exists(ref)) ? await vault.resolve(ref) : undefined
      },
      // An agent has no strategy chooser, so the configured `ask` resolves to
      // the safe, non-history-rewriting default.
      defaultPullStrategy: async () => {
        const preference = (await storage.getConfig()).defaultPullStrategy
        return preference === 'ask' ? 'merge' : preference
      }
    }
  )
  chatEngine?.setScopeToolService?.((input, context) => scopeToolService.execute(input, context))

  // An Assignment worker with a worktree scope of its own gets it from here, on
  // dispatch, so a worker created by the Sr. Engineer is a first-class scope on
  // the board with its own branch and setup.
  chatEngine?.setAssignmentWorkerScopeProvisioner?.(
    new AssignmentWorkerScopeService(scopeWorktreeService, scopeManager, projectManager, {
      onBoardChanged: broadcastScopeBoardChanged,
      onProgress: broadcastWorktreeProgress
    })
  )

  /** Optional trailing thread mount on `projectFiles:*` channels: when the
   *  caller browses a chat's own artifact directory it names the thread so the
   *  service resolves `chats-artifacts/<threadId>` as the root. */
  function threadIdArg(threadId: unknown): string | undefined {
    return threadId === undefined ? undefined : validateEntityId(threadId, 'Thread ID')
  }

  // ─── Projects ───────────────────────────────────────────────────────────
  ipcMain.handle('project:findByPath', async (_, rawPath: unknown) => {
    const path = validateBoundedString(rawPath, 'Project path', 1, 4096)
    return projectManager.findByCanonicalPath(path)
  })

  // A file the OS handed over may already belong to a project: resolve the owning
  // project so the renderer opens it in that project's own editor (file tree,
  // scopes, save flow) instead of the standalone viewer.
  ipcMain.handle('project:findFileOwner', async (_, rawPath: unknown) => {
    const path = validateBoundedString(rawPath, 'File path', 1, 16384)
    return projectFilesService.findProjectOwner(path)
  })

  // The renderer drains the queue on mount; later hand-offs arrive as the
  // `openWith:paths` push (see main/index.ts).
  ipcMain.handle('openWith:consumePending', () => openWithService.consumePending())

  // In-app drops (the project sidebar) reuse the OS opener: main classifies the
  // paths and pushes the result back through `openWith:paths`.
  ipcMain.handle('openWith:openPaths', async (_, rawPaths: unknown) => {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_OPEN_PATHS) {
      throw new TypeError(`Opened paths must be an array of 1 to ${MAX_OPEN_PATHS} paths`)
    }
    const paths = rawPaths.map((entry, index) =>
      validateBoundedString(entry, `Opened path ${index + 1}`, 1, 4096)
    )
    await openWithService.ingest(paths)
  })

  ipcMain.handle('project:create', async (_, rawInput: unknown) => {
    const input = validateCreateProjectInput(rawInput)
    const config = await storage.getConfig()
    return projectManager.createProject({
      ...input,
      threadLimit: input.threadLimit ?? config.threadLimit
    })
  })

  function deriveRepoNameFromUrl(url: string): string {
    const trimmed = url.trim().replace(/\/+$/u, '')
    if (!trimmed) return 'repo'
    const withoutQuery = trimmed.split('?')[0].split('#')[0]
    // Take after last '/' or ':' (covers git@github.com:org/repo.git)
    const lastSlash = withoutQuery.lastIndexOf('/')
    const lastColon = withoutQuery.lastIndexOf(':')
    const sepIndex = Math.max(lastSlash, lastColon)
    const segment = sepIndex >= 0 ? withoutQuery.slice(sepIndex + 1) : withoutQuery
    const withoutGit = segment.endsWith('.git') ? segment.slice(0, -4) : segment
    const sanitized = withoutGit
      .replace(/[^A-Za-z0-9._-]/gu, '-')
      .replace(/^-+/u, '')
      .replace(/-+$/u, '')
    return sanitized.length > 0 ? sanitized.slice(0, 100) : 'repo'
  }

  function validateGitCloneInput(value: unknown): { url: string; destination?: string } {
    if (typeof value !== 'object' || value === null)
      throw new TypeError('Git clone input must be an object')
    const record = value as Record<string, unknown>
    const url = record['url']
    if (typeof url !== 'string' || url.trim().length === 0)
      throw new TypeError('Git URL is required')
    if (url.length > 2048) throw new TypeError('Git URL is too long')
    if (url.includes('\0')) throw new TypeError('Git URL contains invalid characters')
    const trimmed = url.trim()
    // Allow https, http, git, ssh, and scp-like git@host:path
    const isHttps = /^https?:\/\/.+/u.test(trimmed)
    const isSsh = /^ssh:\/\/.+/u.test(trimmed)
    const isGit = /^git:\/\/.+/u.test(trimmed)
    const isScp = /^[^:]+@[^:]+:.+/u.test(trimmed) && !trimmed.includes('://')
    const isGitAt = /^git@.+/u.test(trimmed)
    if (!(isHttps || isSsh || isGit || isScp || isGitAt)) {
      throw new TypeError('Git URL must be a valid https:// or ssh (git@host:owner/repo) URL')
    }
    const destination = record['destination']
    if (destination !== undefined) {
      if (typeof destination !== 'string' || destination.trim().length === 0)
        throw new TypeError('Destination must be a non-empty path')
      if (destination.length > 4096) throw new TypeError('Destination path is too long')
      if (destination.includes('\0')) throw new TypeError('Destination contains invalid characters')
      if (!isAbsolute(destination)) throw new TypeError('Destination must be an absolute path')
    }
    return {
      url: trimmed,
      destination: typeof destination === 'string' ? destination.trim() : undefined
    }
  }

  ipcMain.handle('dialog:pickCloneDestination', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      if (win && !win.isFocused()) win.focus()
      const defaultPath = join(getConfigRoot(), 'projects-gh')
      await mkdir(defaultPath, { recursive: true })
      const config = await storage.getConfig()
      const options: Electron.OpenDialogOptions = {
        title: 'Select Clone Destination',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: config.lastFolderDialogPath || defaultPath
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      const chosen = result.filePaths[0]
      await privilegedIpc.registerUserSelectedRoot(chosen)
      return chosen
    } catch (error) {
      Logger.error('dialog:pickCloneDestination failed:', error)
      return null
    }
  })

  ipcMain.handle('git:defaultClonePath', async (_, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0)
      throw new TypeError('Git URL is required')
    const repoName = deriveRepoNameFromUrl(rawUrl)
    const defaultPath = join(getConfigRoot(), 'projects-gh', repoName)
    return defaultPath
  })

  ipcMain.handle('git:cloneHandoff', async (_, rawInput: unknown) => {
    const { url, destination } = validateGitCloneInput(rawInput)
    const repoName = deriveRepoNameFromUrl(url)
    const resolvedDestination = destination ?? join(getConfigRoot(), 'projects-gh', repoName)
    // Ensure the projects-gh parent exists
    await mkdir(join(getConfigRoot(), 'projects-gh'), { recursive: true })
    // Guard against cloning into an existing non-empty directory
    try {
      const statResult = await stat(resolvedDestination)
      if (statResult.isDirectory()) {
        const entries = await import('fs/promises').then((m) => m.readdir(resolvedDestination))
        if (entries.length > 0)
          throw new Error(`Destination already exists and is not empty: ${resolvedDestination}`)
      } else {
        throw new Error(`Destination already exists and is not a directory: ${resolvedDestination}`)
      }
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // Destination does not exist   git clone will create it
      } else {
        throw error
      }
    }
    await privilegedIpc.registerUserSelectedRoot(dirname(resolvedDestination))
    await privilegedIpc.registerUserSelectedRoot(resolvedDestination)
    return {
      command: 'git',
      args: ['clone', url, resolvedDestination],
      destination: resolvedDestination,
      repoName
    }
  })
  if (!options.hydrationHandlersRegistered) {
    ipcMain.handle('project:get', (_, projectId: string) => projectManager.getProject(projectId))
    ipcMain.handle('project:list', async () => {
      const projects = await projectManager.listProjects()
      // Index every local project's files in the background so the first
      // search is instant instead of building the whole index on demand.
      for (const project of projects) {
        if (project.source === 'local' && project.path.trim()) {
          void projectFilesService.prewarmProject(project.id)
        }
      }
      return projects
    })
    ipcMain.handle('project:ensureInbox', () => projectManager.ensureInboxProject())
    ipcMain.handle('scope:get', (_, projectId: unknown) =>
      scopeManager.getBoard(validateEntityId(projectId, 'Project ID'))
    )
  }
  ipcMain.handle('scope:updateLayout', (_, projectId: unknown, orderedIds: unknown) =>
    scopeManager.updateLayout(
      validateEntityId(projectId, 'Project ID'),
      validateScopeOrderIds(orderedIds)
    )
  )
  ipcMain.handle(
    'scope:updateAppearance',
    (_, projectId: unknown, bucketId: unknown, patch: unknown) =>
      scopeManager.updateAppearance(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(bucketId, 'Scope bucket ID'),
        validateScopeAppearancePatch(patch)
      )
  )
  ipcMain.handle(
    'scope:updateCollapse',
    (_, projectId: unknown, bucketId: unknown, patch: unknown) =>
      scopeManager.updateCollapse(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(bucketId, 'Scope bucket ID'),
        validateScopeCollapsePatch(patch)
      )
  )
  ipcMain.handle('scope:create', (_, projectId: unknown, input: unknown) => {
    const validated = validateScopeCreateInput(input)
    return scopeManager.createBucket(validateEntityId(projectId, 'Project ID'), validated)
  })
  ipcMain.handle(
    'scope:setArchive',
    (_, projectId: unknown, bucketId: unknown, archived: unknown) =>
      scopeManager.setArchive(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(bucketId, 'Scope bucket ID'),
        validateBoolean(archived, 'Archived')
      )
  )
  ipcMain.handle('scope:delete', (_, projectId: unknown, bucketId: unknown) =>
    scopeManager.deleteBucket(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(bucketId, 'Scope bucket ID')
    )
  )
  ipcMain.handle('scope:setPinned', (_, projectId: unknown, bucketId: unknown, pinned: unknown) =>
    scopeManager.setPinned(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(bucketId, 'Scope bucket ID'),
      validateBoolean(pinned, 'Pinned')
    )
  )
  ipcMain.handle('scope:setWorktreeDefaults', (_, projectId: unknown, defaults: unknown) =>
    scopeManager.setWorktreeDefaults(
      validateEntityId(projectId, 'Project ID'),
      validateWorktreeDefaults(defaults)
    )
  )
  // The user's answer to a destructive scope action an agent asked for. The
  // agent's tool call is parked until this lands, so an unknown or already
  // expired request is a no-op rather than an error the renderer has to handle.
  ipcMain.handle('scope:agentConfirmationRespond', (_, requestId: unknown, approved: unknown) => {
    // Both inputs are validated before the map is touched: a rejected payload
    // must leave the entry in place so the request's own expiry can still deny
    // it, instead of orphaning the resolver and parking the agent's call.
    const id = validateEntityId(requestId, 'Confirmation ID')
    const decision = validateBoolean(approved, 'Approval')
    const settle = pendingScopeConfirmations.get(id)
    if (!settle) return
    pendingScopeConfirmations.delete(id)
    settle(decision)
  })
  ipcMain.handle('scope:worktree:create', (event, target: unknown, input: unknown) => {
    const validatedTarget = validateScopeTarget(target)
    const validatedInput = validateScopeWorktreeCreateInput(input)
    return scopeWorktreeService.createManagedWorktree(
      validatedTarget,
      validatedInput,
      worktreeProgressRelay(event, validatedTarget)
    )
  })
  ipcMain.handle('scope:worktree:sourceInfo', (_, projectId: unknown) =>
    scopeWorktreeService.sourceInfo(validateEntityId(projectId, 'Project ID'))
  )
  ipcMain.handle('scope:worktree:health', (_, target: unknown) =>
    scopeWorktreeService.health(validateScopeTarget(target))
  )
  ipcMain.handle('scope:worktree:repair', (_, target: unknown) =>
    scopeWorktreeService.repair(validateScopeTarget(target))
  )
  ipcMain.handle('scope:worktree:detectAdopt', (_, projectId: unknown, sourcePath: unknown) =>
    scopeWorktreeService.detectAdoptable(
      validateEntityId(projectId, 'Project ID'),
      validateSourcePath(sourcePath)
    )
  )
  ipcMain.handle('scope:worktree:adopt', (event, target: unknown, input: unknown) => {
    const validatedTarget = validateScopeTarget(target)
    const validatedInput = validateScopeAdoptInput(input)
    return scopeWorktreeService.adoptWorktree(
      validatedTarget,
      validatedInput,
      worktreeProgressRelay(event, validatedTarget)
    )
  })
  ipcMain.handle('scope:worktree:preflight', (_, action: unknown, target: unknown) =>
    scopeWorktreeService.preflight(
      validateScopeLifecycleAction(action),
      validateScopeTarget(target)
    )
  )
  ipcMain.handle(
    'scope:worktree:confirmDetach',
    (_, target: unknown, confirmationId: unknown, force: unknown) =>
      scopeWorktreeService.confirmDetach(
        validateScopeTarget(target),
        validateConfirmationToken(confirmationId),
        validateBoolean(force, 'Force detach')
      )
  )
  ipcMain.handle(
    'scope:worktree:confirmRemove',
    (_, target: unknown, confirmationId: unknown, force: unknown) =>
      scopeWorktreeService.confirmRemoveWorktree(
        validateScopeTarget(target),
        validateConfirmationToken(confirmationId),
        validateBoolean(force, 'Force')
      )
  )
  ipcMain.handle(
    'scope:worktree:confirmDeleteBranch',
    (_, target: unknown, confirmationId: unknown) =>
      scopeWorktreeService.confirmDeleteBranch(
        validateScopeTarget(target),
        validateConfirmationToken(confirmationId)
      )
  )
  ipcMain.handle('scope:worktree:retrySetup', (event, target: unknown, options: unknown) => {
    const validatedTarget = validateScopeTarget(target)
    const input = options === undefined ? undefined : (options as Record<string, unknown>)
    const runSetup = input === undefined ? true : validateBoolean(input.runSetup, 'Run setup')
    return scopeWorktreeService.runSetupFromFailure(
      validatedTarget,
      { runSetup },
      worktreeProgressRelay(event, validatedTarget)
    )
  })
  ipcMain.handle(
    'scope:worktree:confirmDeleteScope',
    (_, target: unknown, confirmationId: unknown, deleteBranch: unknown) =>
      scopeWorktreeService.confirmDeleteScope(
        validateScopeTarget(target),
        validateConfirmationToken(confirmationId),
        validateBoolean(deleteBranch, 'Delete branch')
      )
  )
  ipcMain.handle(
    'scope:worktree:mergePreflight',
    (_, target: unknown, mergeTarget: unknown, mode: unknown) =>
      scopeWorktreeService.mergePreflight(
        validateScopeTarget(target),
        validateScopeTarget(mergeTarget),
        validateScopeMergeMode(mode)
      )
  )
  ipcMain.handle(
    'scope:worktree:confirmMerge',
    (_, target: unknown, mergeTarget: unknown, mode: unknown, confirmationId: unknown) =>
      scopeWorktreeService.confirmMerge(
        validateScopeTarget(target),
        validateScopeTarget(mergeTarget),
        validateScopeMergeMode(mode),
        validateConfirmationToken(confirmationId)
      )
  )
  ipcMain.handle(
    'project:update',
    async (_, projectId: string, input: Partial<CreateProjectInput>) => {
      const validatedInput = { ...input }
      if ('customSvg' in input) {
        if (input.customSvg === null) validatedInput.customSvg = undefined
        else if (typeof input.customSvg === 'string') {
          validatedInput.customSvg = sanitizeCustomSvg(input.customSvg)
        } else if (input.customSvg !== undefined) {
          throw new TypeError('Project custom SVG must be text')
        }
      }
      const project = await projectManager.updateProject(projectId, validatedInput)
      projectFilesService.invalidateProject(projectId)
      // The root may have changed; warm the index and re-point the watcher.
      void projectFilesService.prewarmProject(projectId)
      return project
    }
  )
  ipcMain.handle(
    'project:delete',
    async (_, projectId: string, options?: { deleteFolder?: boolean }) => {
      // Optional folder erasure runs FIRST and gates the CodeInOven-side
      // removal: if the filesystem delete fails, nothing below executes and
      // the project stays fully intact in CodeInOven (the renderer restores
      // it). Only after the folder is gone does the app data removal begin.
      if (options?.deleteFolder === true) {
        const project = await projectManager.getProject(projectId)
        if (!project?.path || !isAbsolute(project.path)) {
          throw new Error('This project has no local folder on disk to delete')
        }
        const target = resolve(project.path)
        const homeDir = resolve(app.getPath('home'))
        const configRoot = resolve(getConfigRoot())
        const managedClonesRoot = resolve(join(configRoot, 'projects-gh'))
        const isInside = (child: string, parent: string): boolean => child.startsWith(parent + sep)
        // Refuse obviously dangerous targets: the filesystem root, the home
        // directory (or any ancestor of it), and anything inside the app
        // config root. This makes an accidental catastrophic rm impossible.
        // The one exception is a project folder strictly inside the managed
        // `projects-gh/` clones directory: those clones are app-owned project
        // folders the user registered, so erasing one on removal is legitimate
        // (the clones root itself stays protected so sibling clones survive).
        const isManagedClone = isInside(target, managedClonesRoot)
        if (
          target === sep ||
          target === homeDir ||
          isInside(homeDir, target) ||
          target === configRoot ||
          (isInside(target, configRoot) && !isManagedClone)
        ) {
          throw new Error('Refusing to delete a protected directory')
        }
        // `force` treats an already-missing folder as deleted; real failures
        // (permissions, path is a file, ...) still throw and abort below.
        await rm(target, { recursive: true, force: true })
      }
      // Never orphan a registered managed worktree silently: refuse deletion
      // until every managed association in this project is detached/removed
      // through the guarded lifecycle (dirty and unpushed work is protected).
      const board = scopeManager.getBoard(projectId)
      const managedBuckets = board.buckets.filter((bucket) => bucket.root.kind === 'worktree')
      if (managedBuckets.length > 0) {
        throw new Error(
          `Cannot delete the project while ${managedBuckets.length} managed worktree scope(s) exist; remove them first`
        )
      }
      // Delete every thread through the same path as `thread:delete` (session
      // teardown, DB row cleanup for FK-less tables, disk artifact removal) so
      // project deletion can never fall behind that logic or leave orphans.
      await threadManager.deleteAllThreadsInProject(projectId)
      await projectManager.deleteProject(projectId)
      projectFilesService.disposeProject(projectId)
      // Remove app-owned scratch data keyed by this project id (spec-context
      // attachments, any leftover per-thread directories) that isn't tied to
      // an individual thread and so isn't covered by the per-thread cleanup
      // above. Best-effort: the DB rows are already gone either way.
      await rm(join(getConfigRoot(), 'projects', projectId), {
        recursive: true,
        force: true
      }).catch(() => {})
      // Mass deletion just freed potentially thousands of pages. Reclaim the
      // file space off-main via the maintenance worker   this also converts
      // pre-existing databases to `auto_vacuum = INCREMENTAL` so future
      // incremental vacuums work. Fire-and-forget: the IPC result must not wait
      // on an O(database-size) operation, and a concurrent WAL transaction may
      // make VACUUM fail (fine to retry next time).
      void database.fullVacuum().then((result) => {
        if (result.ok && (result.freedPages ?? 0) > 0) {
          Logger.info(`Vacuum after project deletion reclaimed ${result.freedPages} pages`)
        } else if (!result.ok) {
          Logger.dev(`Post-deletion vacuum skipped/failed: ${result.error}`)
        }
      })
    }
  )
  if (!options.hydrationHandlersRegistered) {
    ipcMain.handle('project:getIcon', (_, projectId: string) =>
      projectManager.getIconDataUrl(projectId)
    )
  }
  ipcMain.handle('project:setIcon', (_, projectId: string, sourcePath: string) =>
    projectManager.setIcon(projectId, sourcePath)
  )
  ipcMain.handle('project:clearIcon', (_, projectId: string) => projectManager.clearIcon(projectId))
  ipcMain.handle('project:setPinned', (_, projectId: unknown, pinned: unknown) =>
    projectManager.setPinned(
      validateEntityId(projectId, 'Project ID'),
      validateBoolean(pinned, 'Pinned')
    )
  )
  ipcMain.handle('project:setHasDeployments', (_, projectId: unknown, hasDeployments: unknown) =>
    projectManager.setHasDeployments(
      validateEntityId(projectId, 'Project ID'),
      validateBoolean(hasDeployments, 'Has deployments')
    )
  )
  ipcMain.handle('project:reorder', (_, orderedIds: unknown) =>
    projectManager.reorderProjects(validateStringArray(orderedIds, 'Ordered IDs'))
  )
  ipcMain.handle(
    'projectFiles:list',
    (
      _,
      projectId: unknown,
      relativeDirectory: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      const validatedProjectId = validateEntityId(projectId, 'Project ID')
      const directory = requireString(relativeDirectory, 'Project directory', true)
      if (directory === '') {
        void projectFilesService.prewarmProject(validatedProjectId, threadIdArg(threadId))
      }
      return projectFilesService.listDirectory(
        validatedProjectId,
        directory,
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
    }
  )
  ipcMain.handle(
    'projectFiles:search',
    (
      _,
      projectId: unknown,
      query: unknown,
      category: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      if (category !== 'all' && category !== 'rules') {
        throw new TypeError('Project file search category must be all or rules')
      }
      return projectFilesService.searchFiles(
        validateEntityId(projectId, 'Project ID'),
        requireString(query, 'Project file search query', true),
        category,
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
    }
  )
  ipcMain.handle(
    'projectFiles:resolveCitationPaths',
    (_, projectId: unknown, candidates: unknown, scopeBucketId?: unknown) =>
      projectFilesService.resolveCitationPaths(
        validateEntityId(projectId, 'Project ID'),
        validateStringArray(candidates, 'Citation paths'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
  )
  ipcMain.handle('projectFiles:resolveExternalCitationPaths', (_, absolutePaths: unknown) =>
    projectFilesService.resolveExternalCitationPaths(
      validateStringArray(absolutePaths, 'Absolute citation paths')
    )
  )
  ipcMain.handle(
    'projectFiles:create',
    (
      _,
      projectId: unknown,
      relativeDirectory: unknown,
      name: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) =>
      projectFilesService.createFile(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativeDirectory, 'Project directory', true),
        requireString(name, 'File name'),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.handle(
    'projectFiles:createDirectory',
    (
      _,
      projectId: unknown,
      relativeDirectory: unknown,
      name: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) =>
      projectFilesService.createDirectory(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativeDirectory, 'Project directory', true),
        requireString(name, 'Folder name'),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.handle(
    'projectFiles:delete',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      const validatedProjectId = validateEntityId(projectId, 'Project ID')
      const validatedScopeBucketId =
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      const target = await projectFilesService.resolveForTrash(
        validatedProjectId,
        requireString(relativePath, 'Project file path'),
        validatedScopeBucketId,
        threadIdArg(threadId)
      )
      await shell.trashItem(target)
      projectFilesService.invalidateProject(validatedProjectId, validatedScopeBucketId)
    }
  )
  ipcMain.handle(
    'projectFiles:info',
    (_, projectId: unknown, relativePath: unknown, scopeBucketId?: unknown, threadId?: unknown) =>
      projectFilesService.getInfo(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.handle(
    'directoryPreview:open',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ): Promise<DirectoryPreviewSession> => {
      const previews = options.directoryPreviewService
      if (!previews) throw new TypeError('Directory preview is unavailable')
      const validatedProjectId = validateEntityId(projectId, 'Project ID')
      const validatedScopeBucketId =
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      const requested = requireString(relativePath, 'Preview path', true)
      if (requested === '') {
        // The mount root itself: `getInfo` rejects an empty relative path, so
        // it is resolved through the scope authority directly.
        const registration = await previews.open(
          await projectFilesService.resolveMountRoot(
            validatedProjectId,
            validatedScopeBucketId,
            threadIdArg(threadId)
          )
        )
        return { url: registration.url, directory: '', entryFile: null }
      }
      const info = await projectFilesService.getInfo(
        validatedProjectId,
        requested,
        validatedScopeBucketId,
        threadIdArg(threadId)
      )
      const entryFile =
        info.kind === 'file' && HTML_PREVIEW_PATTERN.test(info.name) ? info.name : null
      if (info.kind !== 'directory' && !entryFile) {
        throw new TypeError('Only a directory or an HTML file can be opened in the browser')
      }
      // A single file is served from the origin root of its own directory, so
      // that the file's relative and root-absolute asset URLs resolve exactly
      // as they would in a plain static host.
      const registration = await previews.open(
        info.kind === 'directory' ? info.absolutePath : dirname(info.absolutePath)
      )
      return {
        url: entryFile ? `${registration.url}${encodeURIComponent(entryFile)}` : registration.url,
        directory: info.kind === 'directory' ? info.path : posixDirname(info.path),
        entryFile
      }
    }
  )
  privileged(
    'projectFiles:openInEditor',
    async (
      _event,
      projectId: unknown,
      relativePath: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      const config = await storage.getConfig()
      const target = await projectFilesService.resolveForExternalEditor(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
      await editorService.openInEditor(config.preferredEditor, target, 'file')
    }
  )
  privileged(
    'projectFiles:openInEditorWith',
    async (
      _event,
      projectId: unknown,
      relativePath: unknown,
      editorId: unknown,
      scopeBucketId?: unknown
    ) => {
      if (typeof editorId !== 'string' || !EDITOR_IDS.has(editorId as EditorId)) {
        throw new TypeError('Unknown editor')
      }
      const target = await projectFilesService.resolveForExternalEditor(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        scopeBucketId === undefined ? undefined : validateEntityId(scopeBucketId, 'Scope bucket ID')
      )
      await editorService.openInEditor(editorId as EditorId, target, 'file')
    }
  )
  ipcMain.handle(
    'projectFiles:read',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      // Read failures (binary files, size limits, missing paths) are surfaced
      // gracefully by renderer call sites; returning null avoids a noisy
      // main-process "Error occurred in handler" log for every expected case.
      try {
        return await projectFilesService.readText(
          validateEntityId(projectId, 'Project ID'),
          requireString(relativePath, 'Project file path'),
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID'),
          threadIdArg(threadId)
        )
      } catch {
        return null
      }
    }
  )
  ipcMain.handle(
    'projectFiles:rename',
    (
      _,
      projectId: unknown,
      relativePath: unknown,
      name: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) =>
      projectFilesService.renameEntry(
        validateEntityId(projectId, 'Project ID'),
        requireString(relativePath, 'Project file path'),
        requireString(name, 'File name'),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.handle(
    'projectFiles:paste',
    (
      _,
      sourceProjectId: unknown,
      sourcePath: unknown,
      destinationProjectId: unknown,
      destinationDirectory: unknown,
      mode: unknown,
      sourceScopeBucketId?: unknown,
      destinationScopeBucketId?: unknown,
      sourceThreadId?: unknown,
      destinationThreadId?: unknown
    ) => {
      if (mode !== 'copy' && mode !== 'move') {
        throw new TypeError('Project file transfer mode must be copy or move')
      }
      return projectFilesService.pasteEntry(
        validateEntityId(sourceProjectId, 'Project ID'),
        requireString(sourcePath, 'Source file path'),
        validateEntityId(destinationProjectId, 'Project ID'),
        requireString(destinationDirectory, 'Destination directory', true),
        mode,
        sourceScopeBucketId === undefined
          ? undefined
          : validateEntityId(sourceScopeBucketId, 'Scope bucket ID'),
        destinationScopeBucketId === undefined
          ? undefined
          : validateEntityId(destinationScopeBucketId, 'Scope bucket ID'),
        threadIdArg(sourceThreadId),
        threadIdArg(destinationThreadId)
      )
    }
  )
  ipcMain.handle(
    'projectFiles:importPaths',
    (
      _,
      projectId: unknown,
      sourcePaths: unknown,
      destinationDirectory: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) =>
      projectFilesService.importPaths(
        validateEntityId(projectId, 'Project ID'),
        validateStringArray(sourcePaths, 'Import source paths'),
        requireString(destinationDirectory, 'Destination directory', true),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.handle(
    'projectFiles:dropPaths',
    (
      _,
      projectId: unknown,
      sourcePaths: unknown,
      destinationDirectory: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) =>
      projectFilesService.dropPaths(
        validateEntityId(projectId, 'Project ID'),
        validateStringArray(sourcePaths, 'Dropped paths'),
        requireString(destinationDirectory, 'Destination directory', true),
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
  )
  ipcMain.on(
    'projectFiles:startDrag',
    (event, projectId: unknown, relativePaths: unknown, scopeBucketId?: unknown) => {
      void (async () => {
        try {
          const paths = projectFilesService.resolveForDragSync(
            validateEntityId(projectId, 'Project ID'),
            validateStringArray(relativePaths, 'Dragged paths'),
            scopeBucketId === undefined
              ? undefined
              : validateEntityId(scopeBucketId, 'Scope bucket ID')
          )
          if (paths.length === 0) throw new Error('No files are available to drag')
          const icon = await resolveDragIcon(paths[0])
          event.sender.startDrag({ file: paths[0], files: paths, icon })
          Logger.dev('Native file drag started', { files: paths.length })
        } catch (error) {
          Logger.error('Could not start native file drag', error)
        }
      })()
    }
  )
  ipcMain.handle(
    'projectFiles:save',
    (
      _,
      projectId: unknown,
      relativePath: unknown,
      content: unknown,
      expectedRevision: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      const revision = requireString(expectedRevision, 'Project file revision')
      if (!/^[a-f0-9]{64}$/u.test(revision)) {
        throw new TypeError('Project file revision must be a SHA-256 digest')
      }
      return projectFilesService
        .writeText(
          validateEntityId(projectId, 'Project ID'),
          requireString(relativePath, 'Project file path'),
          requireString(content, 'Project file content', true),
          revision,
          scopeBucketId === undefined
            ? undefined
            : validateEntityId(scopeBucketId, 'Scope bucket ID'),
          threadIdArg(threadId)
        )
        .then((result) => {
          // The user saved this file themselves   record it so a concurrent
          // agent turn's file-changes card never claims their edit.
          chatEngine?.recordUserFileSave(
            validateEntityId(projectId, 'Project ID'),
            requireString(relativePath, 'Project file path')
          )
          return result
        })
    }
  )
  ipcMain.handle(
    'projectFiles:saveAs',
    async (
      _,
      projectId: unknown,
      relativePath: unknown,
      scopeBucketId?: unknown,
      threadId?: unknown
    ) => {
      const safeRelativePath = requireString(relativePath, 'Project file path')
      const textFile = await projectFilesService.readText(
        validateEntityId(projectId, 'Project ID'),
        safeRelativePath,
        scopeBucketId === undefined
          ? undefined
          : validateEntityId(scopeBucketId, 'Scope bucket ID'),
        threadIdArg(threadId)
      )
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options: Electron.SaveDialogOptions = {
        title: 'Save file as',
        defaultPath: basename(safeRelativePath),
        filters: [{ name: 'All Files', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await atomicWrite(result.filePath, textFile.content)
      return result.filePath
    }
  )
  ipcMain.handle('repository:preflight', (_, projectPath: string) =>
    repositoryService.preflight(projectPath)
  )
  ipcMain.handle('repository:init', (_, projectPath: string) =>
    repositoryService.initialize(projectPath)
  )
  ipcMain.handle('repository:remoteOrigin', (_, projectPath: string) =>
    repositoryService.getRemoteOrigin(projectPath)
  )
}
