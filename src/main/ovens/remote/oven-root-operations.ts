import { randomUUID } from 'node:crypto'
import { mkdir, rename, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OvenRootPeers } from '../../../lib/ovens'
import type { Project } from '../../../lib/types'
import { GitService } from '../../git/git-service'
import { RepositoryService } from '../../git/repository-service'
import { SyncPeerService, type SyncPeerScopeBucket } from '../../git/sync-peer-service'
import { ProjectFilesService } from '../../editor/project-files-service'
import { registerGitOperations } from '../../ipc/handlers/git-operations'
import { registerGitRemoteOperations } from '../../ipc/handlers/git-remote-operations'
import { registerMergeOperations } from '../../ipc/handlers/merge-operations'
import { validateBoundedString, validateEntityId } from '../../ipc/validation/primitives'
import { isOvenRootChannel } from '../../../lib/oven-root-routing'
import { Logger } from '../../system/logger'
import { ovenScopeRoot, ovenTrashDirectory } from './oven-root-paths'
import { ovenGitEnvironment, describeGitFailure, workspaceRoot } from './oven-workspace'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** The filesystem and Git methods a remote root channel may reach. */
const FILE_METHODS: Readonly<Record<string, keyof ProjectFilesService>> = {
  'projectFiles:list': 'listDirectory',
  'projectFiles:search': 'searchFiles',
  'projectFiles:create': 'createFile',
  'projectFiles:createDirectory': 'createDirectory',
  'projectFiles:info': 'getInfo',
  'projectFiles:read': 'readText',
  'projectFiles:rename': 'renameEntry',
  'projectFiles:save': 'writeText',
  'projectFiles:resolveCitationPaths': 'resolveCitationPaths'
}

/**
 * Execute one desktop operation against a checkout on the Oven.
 *
 * The desktop handlers are registered here unchanged, pointed at a synthetic
 * project whose root is the Oven checkout, so the Oven answers with the same
 * code paths the local panels already use instead of a parallel implementation
 * that could disagree with them. Vaulted credentials are refused: an Oven
 * authenticates over SSH with the app-mirrored local identity instead.
 */
export async function ovenRootOperation(input: unknown): Promise<unknown> {
  if (!input || typeof input !== 'object') throw new TypeError('A root operation is required.')
  const request = input as Record<string, unknown>
  const root = await realpath(workspaceRoot(request.root))
  const projectId = validateEntityId(request.projectId, 'Project ID')
  const channel = validateBoundedString(request.channel, 'Root operation', 1, 120)
  if (!isOvenRootChannel(channel))
    throw new Error('This operation does not belong to an Oven root.')
  if (!Array.isArray(request.arguments) || request.arguments.length > 16)
    throw new TypeError('Invalid root operation arguments.')
  const args = request.arguments.map((slot: unknown) => {
    if (!slot || typeof slot !== 'object') throw new TypeError('Invalid operation argument.')
    const field = slot as Record<string, unknown>
    return field.present === true ? field.value : undefined
  })

  /* Diagnostics must never share stdout with the protocol response. */
  Logger.useStandardError()
  Object.assign(process.env, await ovenGitEnvironment(request.localIdentityFile))

  const project: Project = {
    id: projectId,
    name: 'Oven checkout',
    path: root,
    source: 'local',
    providerId: '',
    workflowId: '',
    threadLimit: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const files = new ProjectFilesService(
    {
      getProject: async (id) => (id === projectId ? project : null),
      listProjects: async () => [project]
    },
    { resolveCompatibilityRoot: async () => root },
    {
      chatWorkspace: { resolve: async () => root },
      assistant: { resolve: async () => root },
      browser: { resolve: async () => root }
    }
  )
  const git = new GitService()
  const repository = new RepositoryService()
  const handlers = new Map<string, Handler>()
  const registrar = {
    handle: (name: string, handler: Handler): void => {
      handlers.set(name, handler)
    }
  }
  const resolveProjectPath = async (id: string): Promise<string> => {
    if (id !== projectId) throw new Error('The operation belongs to another project.')
    return root
  }
  registerGitOperations(
    {
      gitService: git,
      repositoryService: repository,
      resolveProjectPath,
      storage: { getConfig: async () => ({ maxConflictFileBytes: 8 * 1024 * 1024 }) },
      threadManager: {
        listThreads: async () => [],
        setBranch: async () => {
          throw new Error('Thread metadata belongs to the desktop.')
        }
      }
    },
    registrar
  )
  const credentialVault = {
    exists: async () => false,
    resolve: async () => {
      throw new Error('Use SSH authentication on this Oven.')
    },
    isAvailable: () => false,
    save: async () => {
      throw new Error('Manage credentials in the desktop app.')
    },
    remove: async () => undefined
  }
  registerGitRemoteOperations(
    {
      gitService: git,
      resolveProjectPath,
      gitCredentialRef: () => '',
      vault: credentialVault,
      syncPeers: ovenSyncPeers(git, root, projectId, request.peers)
    },
    registrar
  )
  registerMergeOperations(
    {
      gitService: git,
      resolveProjectPath,
      gitCredentialRef: () => '',
      vault: { exists: credentialVault.exists, resolve: credentialVault.resolve }
    },
    registrar
  )

  /** One channel call: Git handlers, repository reads, or the file service. */
  const dispatch = async (): Promise<unknown> => {
    if (channel.startsWith('git:')) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error('This Git operation is unavailable on the Oven.')
      return await handler(undefined, projectId, ...args)
    }
    if (channel === 'repository:preflight') return repository.preflight(root)
    if (channel === 'repository:initialize') return repository.initialize(root)
    if (channel === 'repository:currentBranch') return repository.getCurrentBranch(root)
    if (channel === 'projectFiles:resolveExternalCitationPaths') return citationPaths(root, args)
    if (channel === 'projectFiles:delete') return moveToTrash(files, projectId, args)
    if (channel === 'projectFiles:openInEditor' || channel === 'projectFiles:openInEditorWith')
      throw new Error(
        'This file lives on the Oven. Download it with Save as, or open it from the Oven shell.'
      )
    const method = FILE_METHODS[channel]
    if (!method)
      throw new Error(
        'This action needs an explicit transfer from the Oven. It cannot operate on local files.'
      )
    return await Reflect.apply(files[method] as (...values: unknown[]) => unknown, files, [
      projectId,
      ...args
    ])
  }

  try {
    return await dispatch()
  } catch (error) {
    /* Git's own diagnostics are classified once, here, so every remote Git
       failure reaches the user as an explanation rather than an exit code. */
    const message = error instanceof Error ? error.message : String(error)
    const explanation = channel.startsWith('git:') ? describeGitFailure(message) : null
    if (explanation) throw new Error(explanation, { cause: error })
    throw error
  } finally {
    files.disposeProject(projectId)
  }
}
/**
 * The other ends a sync may name on this Oven.
 *
 * The desktop resolved every scope checkout before the call, so the Oven only
 * has to answer with the ones it can actually see: its own root for the Default
 * scope, and each known peer for as long as the directory is still there.
 */
function ovenSyncPeers(
  git: GitService,
  root: string,
  projectId: string,
  peers: unknown
): SyncPeerService {
  const known: OvenRootPeers['checkouts'] = []
  if (peers && typeof peers === 'object') {
    const input = peers as OvenRootPeers
    if (Array.isArray(input.checkouts))
      for (const peer of input.checkouts.slice(0, 256))
        if (
          peer &&
          typeof peer.id === 'string' &&
          typeof peer.name === 'string' &&
          typeof peer.root === 'string'
        )
          known.push({ id: peer.id, name: peer.name, root: peer.root })
  }
  const currentScope =
    peers && typeof peers === 'object' && typeof (peers as OvenRootPeers).currentScope === 'string'
      ? (peers as OvenRootPeers).currentScope
      : 'default'
  const defaultRoot =
    currentScope === 'default'
      ? root
      : (known.find((peer) => peer.id === 'default')?.root ??
        ovenScopeRoot(homedir(), projectId, 'default'))
  const buckets: SyncPeerScopeBucket[] = known
    .filter((peer) => peer.id !== 'default')
    .map((peer) => ({ id: peer.id, name: peer.name, root: { kind: 'worktree' as const } }))
  return new SyncPeerService({
    allowMissingProjectRoot: true,
    scopes: { getBoard: () => ({ buckets }) },
    resolveRoot: async (_projectId, scope) => {
      if (scope === 'default') return { ok: true, root: await realpath(defaultRoot) }
      const peer = known.find((candidate) => candidate.id === scope)
      if (!peer) throw new Error('This scope has no checkout on this Oven.')
      return { ok: true, root: await realpath(peer.root) }
    },
    git: {
      statusBranch: async (path) => (await git.getStatus(path)).branch,
      listBranches: async (path) => {
        const branches = await git.listBranches(path)
        for (const peer of known.filter((candidate) => candidate.root !== path).slice(0, 64)) {
          const branch = (await git.listBranches(peer.root).catch(() => [])).find(
            (candidate) => candidate.current
          )
          if (branch) branches.push({ ...branch, current: false, worktreePath: peer.root })
        }
        return branches
      }
    }
  })
}

/** Whether each candidate path is a real file inside this checkout. */
async function citationPaths(root: string, args: unknown[]): Promise<Record<string, boolean>> {
  const paths = args[0]
  if (
    !Array.isArray(paths) ||
    paths.length > 256 ||
    paths.some((path) => typeof path !== 'string' || path.length > 4096)
  )
    throw new Error('Invalid citation paths.')
  const results: Record<string, boolean> = {}
  for (const path of paths as string[])
    results[path] = await realpath(path)
      .then(
        async (canonical) => canonical.startsWith(`${root}/`) && (await stat(canonical)).isFile()
      )
      .catch(() => false)
  return results
}

/**
 * Remote removals move into an Oven-owned trash directory.
 *
 * Nothing is deleted outright: a mistaken delete stays recoverable inside the
 * Oven data root instead of disappearing with the checkout.
 */
async function moveToTrash(
  files: ProjectFilesService,
  projectId: string,
  args: unknown[]
): Promise<void> {
  const path = validateBoundedString(args[0], 'File path', 1, 4096)
  const target = await files.resolveForTrash(projectId, path)
  await mkdir(ovenTrashDirectory(), { recursive: true, mode: 0o700 })
  await rename(target, join(ovenTrashDirectory(), randomUUID()))
}
