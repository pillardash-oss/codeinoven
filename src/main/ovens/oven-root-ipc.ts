import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { BrowserWindow, dialog, shell } from 'electron'
import { basename, dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import type { ProjectManager } from '../../lib/engines/project-manager'
import type { ProjectFileDropResult, ProjectFileEntry } from '../../lib/types'
import type { OvenRootPeers, OvenRootTarget } from '../../lib/ovens'
import type { ProjectFilesService } from '../editor/project-files-service'
import type { OvenService } from './oven-service'
import type { OvenTransfers } from './oven-transfers'
import type { OvenPreview } from './oven-preview'
import { LOCAL_OVEN_ID } from '../../lib/ovens'
import { resolveOvenThreadRoot, type OvenThreadRoot } from './oven-thread-root'
import { isOvenRootChannel } from '../../lib/oven-root-routing'
import { validateBoundedString, validateEntityId } from '../ipc/validation/primitives'

export interface OvenRootDependencies {
  service: OvenService
  threads: ThreadManager
  projects: ProjectManager
  projectFiles: ProjectFilesService
  transfers: OvenTransfers
  previews: OvenPreview
  /** Scope bucket names, so a sync peer is offered under the name the board uses. */
  scopeNames: (projectId: string) => Record<string, string>
  /** Privileged local path authorization for files dragged onto a remote checkout. */
  authorizePath: (value: unknown) => Promise<string>
}

/** A renderer-issued scope key for a remote thread: `oven.<threadId>.<ovenId>`. */
const OVEN_SCOPE_KEY = /^oven\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u

function parseScopeKey(value: unknown): { threadId: string; ovenId: string } | null {
  if (typeof value !== 'string') return null
  const match = OVEN_SCOPE_KEY.exec(value)
  return match ? { threadId: match[1], ovenId: match[2] } : null
}

/**
 * Root operations for remote threads.
 *
 * Every file, Git, and repository action a remote thread offers arrives here
 * already addressed by the renderer, which binds each call to the checkout its
 * panel is showing. This module resolves that address to an authoritative root
 * on the Oven and executes the same desktop handler there, so a remote thread
 * never falls back to local files and a background save never lands on a
 * different Oven than the one it was issued for.
 */
export function registerOvenRootIpc(dependencies: OvenRootDependencies): void {
  const {
    service,
    threads,
    projects,
    projectFiles,
    transfers,
    previews,
    scopeNames,
    authorizePath
  } = dependencies

  /** A thread's checkout on its Oven, recorded so every panel resolves the same. */
  const threadRoot = async (
    projectId: string,
    threadId: string,
    expectedOvenId?: unknown
  ): Promise<OvenThreadRoot> => {
    if (expectedOvenId !== undefined && typeof expectedOvenId !== 'string')
      throw new TypeError('Invalid Oven identity.')
    const thread = await threads.getThread(projectId, validateEntityId(threadId, 'Thread ID'))
    if (!thread) throw new Error('The Oven thread is unavailable.')
    if (expectedOvenId !== undefined && expectedOvenId !== thread.settings?.ovenId)
      throw new Error(
        'This operation belongs to the previously selected Oven. Switch back before saving or retrying it.'
      )
    const target = await resolveOvenThreadRoot(service, thread, projects)
    if (thread.settings && thread.settings.ovenPath !== target.root)
      await threads.updateSettings(projectId, thread.id, {
        ...thread.settings,
        ovenPath: target.root
      })
    return target
  }

  /**
   * One side of a cross-root operation.
   *
   * A side named by a remote scope key resolves to that thread's Oven checkout;
   * anything else stays local, so a paste between two Ovens and a paste between
   * an Oven and this computer both travel the same path.
   */
  const sideRoot = async (
    projectId: string,
    scope: unknown,
    thread: unknown
  ): Promise<OvenRootTarget> => {
    const selected = parseScopeKey(scope)
    const threadId = typeof thread === 'string' ? thread : selected?.threadId
    if (threadId) {
      const bound = await threads.getThread(projectId, validateEntityId(threadId, 'Thread ID'))
      const ovenId = bound?.settings?.ovenId
      if (bound && ovenId && ovenId !== LOCAL_OVEN_ID)
        return await threadRoot(projectId, threadId, selected?.ovenId)
    }
    return {
      ovenId: LOCAL_OVEN_ID,
      root: await projectFiles.resolveMountRoot(
        projectId,
        typeof scope === 'string' ? scope : undefined,
        threadId
      )
    }
  }

  /**
   * Copy authorized local paths into a remote checkout directory.
   *
   * A drag-and-drop answers with the entries it landed; an import answers with
   * the entries themselves, which is what each renderer caller expects.
   */
  const importPaths = async (
    target: OvenRootTarget,
    sourcePaths: unknown,
    directory: unknown,
    asDrop: boolean
  ): Promise<ProjectFileEntry[] | ProjectFileDropResult[]> => {
    if (
      !Array.isArray(sourcePaths) ||
      sourcePaths.length > 256 ||
      sourcePaths.some((path) => typeof path !== 'string')
    )
      throw new Error('Invalid upload sources.')
    const folder = validateBoundedString(directory, 'Destination directory', 0, 4096)
    const entries: ProjectFileEntry[] = []
    for (const path of sourcePaths as string[]) {
      const source = await authorizePath(path)
      const copied = await transfers.copySelection(
        { ovenId: LOCAL_OVEN_ID, root: dirname(source) },
        target,
        [basename(source)],
        folder
      )
      for (const entry of copied)
        entries.push({
          name: entry.path.split('/').at(-1) ?? entry.path,
          path: entry.path,
          kind: entry.kind === 'directory' ? 'directory' : 'file'
        })
    }
    return asDrop ? entries.map((entry) => ({ entry })) : entries
  }

  /** Move or copy one entry between roots, then remove the source on a move. */
  const paste = async (args: unknown[]): Promise<ProjectFileEntry> => {
    const [
      sourceProject,
      sourcePath,
      destinationProject,
      directory,
      mode,
      sourceScope,
      destinationScope,
      sourceThread,
      destinationThread
    ] = args
    const sourceId = validateEntityId(sourceProject, 'Source project')
    const destinationId = validateEntityId(destinationProject, 'Destination project')
    if (mode !== 'copy' && mode !== 'move') throw new Error('Invalid copy mode.')
    const source = await sideRoot(sourceId, sourceScope, sourceThread)
    const destination = await sideRoot(destinationId, destinationScope, destinationThread)
    const path = validateBoundedString(sourcePath, 'Source path', 1, 4096)
    const folder = validateBoundedString(directory, 'Destination directory', 0, 4096)
    const result = (await transfers.copySelection(source, destination, [path], folder))[0]
    if (!result) throw new Error('No file was copied.')
    if (mode === 'move') {
      if (source.ovenId === LOCAL_OVEN_ID)
        await shell.trashItem(
          await projectFiles.resolveForTrash(
            sourceId,
            path,
            typeof sourceScope === 'string' ? sourceScope : undefined,
            typeof sourceThread === 'string' ? sourceThread : undefined
          )
        )
      else
        await service.rootOperation(source.ovenId, source.root, sourceId, 'projectFiles:delete', [
          path
        ])
    }
    return {
      name: result.path.split('/').at(-1) ?? result.path,
      path: result.path,
      kind: result.kind === 'directory' ? 'directory' : 'file'
    }
  }

  /** Write a copy of a remote file wherever the user chooses on this computer. */
  const saveAs = async (
    target: OvenRootTarget,
    projectId: string,
    args: unknown[]
  ): Promise<string | null> => {
    const path = validateBoundedString(args[0], 'File path', 1, 4096)
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = { title: 'Save file as', defaultPath: basename(path) }
    const chosen = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (chosen.canceled || !chosen.filePath) return null
    const read = (await service.rootOperation(
      target.ovenId,
      target.root,
      projectId,
      'projectFiles:read',
      [path]
    )) as { content: string }
    await writeFile(chosen.filePath, read.content, 'utf8')
    return chosen.filePath
  }

  /** Serve one remote directory through the local preview server. */
  const openDirectoryPreview = async (
    target: OvenRootTarget,
    args: unknown[]
  ): Promise<{ url: string; directory: string; entryFile: string | null }> => {
    const path = typeof args[0] === 'string' ? args[0] : ''
    const metadata = await service.workspace(target.ovenId, {
      operation: 'stat',
      root: target.root,
      path
    })
    if (!metadata.file || !['file', 'directory'].includes(metadata.file.kind))
      throw new Error('Choose a file or directory inside the Oven checkout.')
    const entryFile = metadata.file.kind === 'file' ? (path.split('/').at(-1) ?? null) : null
    const directory = entryFile ? path.split('/').slice(0, -1).join('/') : path
    const base = await previews.open(
      target.ovenId,
      `${target.root}${directory ? `/${directory}` : ''}`
    )
    return {
      url: entryFile ? `${base}${encodeURIComponent(entryFile)}` : base,
      directory,
      entryFile
    }
  }

  /**
   * The other ends a sync may name on this Oven.
   *
   * The Oven has no scope board of its own, so the desktop answers with every
   * checkout it knows for this project on this Oven, named the way the board
   * names it. A scope with no prepared checkout is simply absent.
   */
  const peersFor = async (
    projectId: string,
    threadId: string,
    ovenId: string
  ): Promise<OvenRootPeers> => {
    const names = scopeNames(projectId)
    const active = await threads.getThread(projectId, threadId)
    const checkouts = new Map<string, { id: string; name: string; root: string }>()
    for (const candidate of await threads.listThreads(projectId, { limit: 256 })) {
      if (candidate.settings?.ovenId !== ovenId || !candidate.settings.ovenPath) continue
      const scope = candidate.scopeBucketId ?? 'default'
      checkouts.set(scope, {
        id: scope,
        name: names[scope] ?? (scope === 'default' ? 'Project root' : candidate.title),
        root: candidate.settings.ovenPath
      })
    }
    return { currentScope: active?.scopeBucketId ?? 'default', checkouts: [...checkouts.values()] }
  }

  ipcMain.handle(
    'oven:rootOperation',
    async (
      _event,
      projectId: unknown,
      threadId: unknown,
      channel: unknown,
      args: unknown,
      expectedOvenId?: unknown
    ) => {
      if (
        typeof channel !== 'string' ||
        !isOvenRootChannel(channel) ||
        !Array.isArray(args) ||
        args.length > 16
      )
        throw new TypeError('Invalid Oven root operation.')
      const id = validateEntityId(projectId, 'Project ID')
      const target = await threadRoot(id, validateEntityId(threadId, 'Thread ID'), expectedOvenId)
      if (channel === 'projectFiles:importPaths' || channel === 'projectFiles:dropPaths')
        return importPaths(target, args[0], args[1], channel === 'projectFiles:dropPaths')
      if (channel === 'projectFiles:paste') return paste(args)
      if (channel === 'projectFiles:saveAs') return saveAs(target, id, args)
      if (channel === 'directoryPreview:open') return openDirectoryPreview(target, args)
      const project = await projects.getProject(id)
      const peers =
        channel === 'git:syncPeers' || channel === 'git:syncWith'
          ? await peersFor(id, validateEntityId(threadId, 'Thread ID'), target.ovenId)
          : undefined
      return service.rootOperation(
        target.ovenId,
        target.root,
        id,
        channel,
        args,
        project?.path,
        peers
      )
    }
  )
}
