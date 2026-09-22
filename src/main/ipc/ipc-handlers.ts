import { app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { appRendererNavigationTargets, trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { join } from 'path'
import { getConfigRoot, getScopeRootPath } from '../../lib/utils'
import { threadAttachmentDirectory } from '../../lib/thread-storage-paths'
import { validateEngineeringSpec } from '../../lib/spec/spec-validation'
import { Logger } from '../system/logger'
import { openWithService } from '../system/open-with-service'
import { GitHubProvider } from '../providers/github-provider'
import {
  PrivilegedIpcValidator,
  validateBoundedString,
  validateEntityId,
  validatePrNumber
} from './ipc-validation'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ScopeWorktreeService } from '../git/scope-worktree-service'
import type { ScopeThreadLifecycle } from '../git/scope-worktree-service'
import { ScopeRootResolver, scopeRootProvider } from '../workspaces/scope-root-resolver'
import { HistoryEngine } from '../../lib/engines/history-engine'
import { EngineeringLifecycleEngine } from '../../lib/engines/engineering-lifecycle-engine'
import { PlanEngine } from '../../lib/engines/plan-engine'
import { SpecEngine } from '../../lib/engines/spec-engine'
import { BrainstormEngine } from '../../lib/engines/brainstorm-engine'
import { PrdEngine } from '../../lib/engines/prd-engine'
import { AuditEngine } from '../../lib/engines/audit-engine'
import { AssignmentEngine } from '../../lib/engines/assignment-engine'
import { SpecContextService } from '../chat/spec-context-service'
import { EditorService } from '../editor/editor-service'
import { ProjectFilesService } from '../editor/project-files-service'
import { RepositoryService } from '../git/repository-service'
import { GitService } from '../git/git-service'
import { SyncPeerService, syncPeerGit } from '../git/sync-peer-service'
import { SecretVault } from '../storage/secret-vault'
import { GitHubAuthService } from '../git/github-auth-service'
import { DiagnosticsService } from '../system/diagnostics-service'
import { MemoryService } from '../chat/memory-service'
import { AttachmentGrantRepo } from '../database/repositories/attachment-grant-repo'
import { HarnessUsageRepo } from '../database/repositories/harness-usage-repo'
import { ModelRankingRepo } from '../database/repositories/model-ranking-repo'
import { ModelRankingSnapshotRepo } from '../database/repositories/model-ranking-snapshot-repo'
import { NoteRepo } from '../database/repositories/note-repo'
import { CheckpointManager } from '../storage/checkpoint-manager'
import { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import type { ThreadBranchDeps } from '../chat/thread-branch-service'
import {
  broadcastThreadBranchUpdated,
  broadcastThreadDeleted,
  broadcastThreadUpdate,
  dismissThreadNotifications
} from '../chat/thread-events'
import { registerEngineeringLifecycleHandlers } from './handlers/lifecycle-handlers'
import { registerFilesHandlers } from './handlers/files-handlers'
import { registerConfigHandlers } from './handlers/config-handlers'
import { registerMemoryHandlers } from './handlers/memory-handlers'
import { registerSpecHandlers } from './handlers/specs-handlers'
import { registerSystemHandlers } from './handlers/system-handlers'
import { registerProjectHandlers } from './handlers/project-handlers'
import { registerGitHandlers } from './handlers/git-handlers'
import { registerGitRemoteHandlers } from './handlers/git-remote-handlers'
import { registerMergeHandlers } from './handlers/merge-handlers'
import { registerPrHandlers } from './handlers/pr-handlers'
import { registerCloudHandlers } from './handlers/cloud-handlers'
import { registerEditorsHandlers } from './handlers/editors-handlers'
import { registerThreadHandlers } from './handlers/thread-handlers'
import { registerNotesHandlers } from './handlers/notes-handlers'
import { registerHistoryHandlers } from './handlers/history-handlers'
import { registerSearchHandlers } from './handlers/search-handlers'
import { registerPlanHandlers } from './handlers/plan-handlers'
import { registerUpdaterHandlers } from './handlers/updater-handlers'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import type { UpdaterService } from '../notifications/updater-service'
import type { GitProvider } from '../git/git-provider.interface'
import type { AttachmentStorageScope, OpenedPath } from '../../lib/types'
import type {
  IpcChatEngine,
  IpcHandlerContext,
  RegisterIpcHandlersOptions
} from './handlers/context'

export type { RegisterIpcHandlersOptions } from './handlers/context'
export { validateAppConfigPatch } from './handlers/config-helpers'

export function registerIpcHandlers(
  storage: StorageEngine,
  database: Database,
  updaterService?: UpdaterService,
  chatEngine?: IpcChatEngine,
  options: RegisterIpcHandlersOptions = {}
): void {
  const projectManager = options.projectManager ?? new ProjectManager(database)
  const threadCreation = options.threadCreation ?? new ThreadCreationCoordinator()
  const threadDeletion = options.threadDeletion ?? new ThreadDeletionCoordinator()
  const checkpointManager = new CheckpointManager(database)
  const scopeManager = new ScopeManager(database)
  const scopeWorktreeService =
    options.worktreeService ??
    new ScopeWorktreeService(scopeManager, projectManager, {
      activeProcesses: chatEngine
        ? {
            hasActiveProcessesFor: (projectId: string, scopeBucketId?: string) =>
              chatEngine.hasActiveProcessesInScope(projectId, scopeBucketId)
          }
        : undefined
    })
  const scopeRootResolver = new ScopeRootResolver(
    projectManager,
    scopeManager,
    options.worktreeInspector ?? scopeWorktreeService
  )
  const scopeRoots = scopeRootProvider(scopeRootResolver)
  /**
   * Stream a managed-worktree job's stages back to the renderer that started it,
   * so the docked job panel can show real progress instead of a bare spinner.
   * Progress is advisory: a failed delivery must never affect the git work.
   */

  // Constructed after the scope resolver so interactive file surfaces can
  // resolve managed worktree roots instead of always reading the project root.
  const projectFilesService =
    options.projectFilesService ?? new ProjectFilesService(projectManager, scopeRoots)
  const threadManager = new ThreadManager(
    database,
    broadcastThreadUpdate,
    async (thread) => {
      if (chatEngine?.deleteThreadSession) {
        await chatEngine.deleteThreadSession(thread.projectId, thread.id)
      }
      await memoryService.deleteThreadMemory(thread.projectId, thread.id)
      dismissThreadNotifications(thread.projectId, thread.id)
    },
    async (threads) => {
      for (const thread of threads) broadcastThreadDeleted(thread)
      for (const projectId of new Set(threads.map((thread) => thread.projectId))) {
        await checkpointManager.pruneUnusedBlobs(projectId)
      }
    },
    scopeRoots
  )
  // The merge lifecycle deletes/moves threads in the source scope after the
  // git merge lands; the thread manager is created after the worktree service,
  // so the service receives it here. The agent-facing scope tool shares this
  // same lifecycle object, so both routes dispose of scope threads identically.
  const scopeThreadLifecycle: ScopeThreadLifecycle = {
    countThreadsInScope: (projectId, bucketId) =>
      threadManager.countThreadsInScope(projectId, bucketId),
    deleteThreadsInScope: (projectId, bucketId) =>
      threadManager.deleteThreadsInScope(projectId, bucketId),
    moveThreadsOutOfScope: (projectId, fromBucketId) =>
      threadManager.moveThreadsOutOfScope(projectId, fromBucketId),
    moveThreadIntoScope: async (projectId, threadId, bucketId) => {
      await threadManager.updateThread(projectId, threadId, { scopeBucketId: bucketId })
    }
  }
  scopeWorktreeService.attachThreadLifecycle(scopeThreadLifecycle)
  const historyEngine = new HistoryEngine(database)
  const engineeringLifecycleEngine = new EngineeringLifecycleEngine(database)
  const planEngine = new PlanEngine(storage, database)
  const specEngine = new SpecEngine(storage, database, {
    validateForApproval: validateEngineeringSpec
  })
  const brainstormEngine = new BrainstormEngine(storage, database)
  const prdEngine = new PrdEngine(storage, database)
  const auditEngine = new AuditEngine(storage, database)
  const assignmentEngine = new AssignmentEngine(storage, database)
  const specContextService = new SpecContextService(database, projectManager)
  const editorService = new EditorService()
  const repositoryService = new RepositoryService()
  const gitService = new GitService()
  /**
   * The sync's other end is resolved once, for both the picker that lists the
   * options and the operation that acts on the choice, so the two can never name
   * the same end differently.
   */
  const syncPeers = new SyncPeerService({
    scopes: scopeManager,
    resolveRoot: (projectId, scopeBucketId) =>
      scopeRootResolver.resolve({ projectId, scopeBucketId }),
    git: syncPeerGit(gitService)
  })
  const branchBackfillDeps: ThreadBranchDeps = {
    resolver: repositoryService,
    store: threadManager,
    onSettled: broadcastThreadBranchUpdated
  }
  const vault = options.vault ?? new SecretVault(storage)
  const gitCredentialRef = (projectId: string): string => `git_pat_${projectId}`

  const githubAuthService = options.githubAuthService ?? new GitHubAuthService(vault)
  const diagnosticsService = new DiagnosticsService(database, () =>
    memoryService.auxiliaryUsageByFeature()
  )
  const memoryService = new MemoryService(storage)
  const attachmentGrantRepo = new AttachmentGrantRepo(database)
  const harnessUsageRepo = new HarnessUsageRepo(database)
  const modelRankingRepo = new ModelRankingRepo(database)
  // The ranking drain in ChatEngine owns its own instance; repositories are
  // stateless views over the same file, so this one exists only so a user
  // purge can clear the queue together with the aggregates it feeds.
  const rankingSnapshotRepo = new ModelRankingSnapshotRepo(database)
  const noteRepo = new NoteRepo(database)

  /**
   * Optimistic renderer creates return before their database row is written.
   * Any handler that validates thread ownership must wait for that write before
   * consulting a thread-scoped engine.
   */
  async function waitForThreadReady(
    projectId: unknown,
    threadId: unknown,
    projectLabel = 'Project ID',
    threadLabel = 'Thread ID'
  ): Promise<{ projectId: string; threadId: string }> {
    const safeProjectId = validateEntityId(projectId, projectLabel)
    const safeThreadId = validateEntityId(threadId, threadLabel)
    await threadCreation.awaitReady(safeThreadId)
    // A failed finalization never persisted the row; fail fast with the real
    // cause instead of letting thread-scoped engines report a misleading
    // ownership error. Phrase matches the renderer's 'Thread not found' retry.
    if (threadCreation.didFinalizationFail(safeThreadId)) {
      throw new Error(`Thread not found: ${safeThreadId} (its creation did not complete)`)
    }
    return { projectId: safeProjectId, threadId: safeThreadId }
  }

  // Shared privileged-IPC boundary: every renderer call that can open the
  // system browser, reveal files, or read local files is validated here.
  const isProduction = app.isPackaged || process.env['NODE_ENV'] === 'production'
  const privilegedIpc = new PrivilegedIpcValidator({
    navigationTargets: appRendererNavigationTargets(),
    allowDevelopmentHttp: !isProduction,
    scopes: {
      projectRoots: async () => {
        const projects = await projectManager.listProjects()
        const roots = projects
          .map((project) => project.path)
          .filter((path): path is string => typeof path === 'string' && path.length > 0)
        // Healthy managed worktrees live beneath the config root and are added
        // individually   never by approving the whole config directory.
        for (const project of projects) {
          const board = scopeManager.getBoard(project.id)
          for (const bucket of board.buckets) {
            if (bucket.root.kind !== 'worktree') continue
            try {
              const health = await scopeWorktreeService.health({
                projectId: project.id,
                scopeBucketId: bucket.id
              })
              if (health.category === 'healthy') {
                roots.push(getScopeRootPath(project.id, bucket.root.directoryName))
              }
            } catch {
              // Unhealthy managed roots grant no filesystem scope.
            }
          }
        }
        return roots
      },
      appArtifactRoots: async () => {
        const projects = await projectManager.listProjects()
        return [
          join(getConfigRoot(), 'chats'),
          join(getConfigRoot(), 'chat-artifacts'),
          join(getConfigRoot(), 'chats-artifacts'),
          ...projects.flatMap((project) => [
            join(getConfigRoot(), 'projects', project.id, 'spec-context', 'attachments'),
            join(getConfigRoot(), 'projects', project.id, 'threads')
          ])
        ]
      },
      isApprovedFile: (canonicalPath) => attachmentGrantRepo.isApproved(canonicalPath)
    }
  })

  options.onScopedPathResolver?.((value) => privilegedIpc.resolveScopedPath(value))

  /** Authorize a path the operating system handed to CodeInOven: the user's
   *  own "Open in CodeInOven" gesture is exactly as explicit as a dialog pick,
   *  so folders become user-selected roots and files user-selected files. */
  function grantOpenedPaths(paths: readonly OpenedPath[]): void {
    void (async () => {
      for (const opened of paths) {
        try {
          if (opened.kind === 'directory') await privilegedIpc.registerUserSelectedRoot(opened.path)
          else await privilegedIpc.registerUserSelectedFile(opened.path)
        } catch (error) {
          Logger.error('Opened-path scope grant failed:', error)
        }
      }
    })()
  }

  // Paths can arrive before the post-paint service graph exists (a launch with
  // paths, or a macOS `open-file` during startup), so grant what is already
  // known and keep listening for later hand-offs.
  grantOpenedPaths(openWithService.grantedPaths())
  openWithService.onPaths(grantOpenedPaths)

  /** Register a privileged channel whose sender frame must be trusted. */
  function privileged<TArgs extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      privilegedIpc.assertTrustedSender(event)
      return handler(event, ...(args as TArgs))
    })
  }

  async function attachmentStorageDirectory(scope: AttachmentStorageScope): Promise<string> {
    const project = await projectManager.getProject(scope.projectId)
    return threadAttachmentDirectory(project ?? null, scope)
  }

  const resolveProjectPath = async (projectId: string, scopeBucketId?: string): Promise<string> => {
    // When a scope is supplied, resolve through the authoritative scope
    // resolver so a managed worktree becomes this operation's repository
    // root. Unhealthy managed scopes fail closed (never fall back to the
    // project directory).
    if (scopeBucketId) {
      const scopeRoot = await scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
      if (!scopeRoot) throw new Error(`Scope root unavailable: ${projectId}:${scopeBucketId}`)
      return scopeRoot
    }
    const project = await projectManager.getProject(projectId)
    if (!project?.path) throw new Error(`Project not found: ${projectId}`)
    return project.path
  }

  const providerForProject = async (projectId: string): Promise<GitProvider | null> => {
    const oauthToken = await githubAuthService.resolveToken()
    if (oauthToken) {
      return new GitHubProvider(oauthToken, undefined, () => githubAuthService.resolveToken(true))
    }
    const tokenRef = gitCredentialRef(projectId)
    if (!(await vault.exists(tokenRef))) return null
    const token = await vault.resolve(tokenRef)
    return new GitHubProvider(token)
  }

  /** Shared preamble for every single-PR channel: provider + validated target. */
  const pullRequestTarget = async (
    projectId: unknown,
    owner: unknown,
    repo: unknown,
    pullNumber: unknown
  ): Promise<{ provider: GitProvider; owner: string; repo: string; pullNumber: number }> => {
    const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
    if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
    return {
      provider,
      owner: validateBoundedString(owner, 'PR owner', 1, 128),
      repo: validateBoundedString(repo, 'PR repository', 1, 128),
      pullNumber: validatePrNumber(pullNumber)
    }
  }

  const ctx: IpcHandlerContext = {
    storage,
    database,
    updaterService,
    chatEngine,
    options,
    projectManager,
    threadCreation,
    threadDeletion,
    checkpointManager,
    scopeManager,
    scopeWorktreeService,
    scopeRootResolver,
    scopeRoots,
    syncPeers,
    projectFilesService,
    threadManager,
    scopeThreadLifecycle,
    historyEngine,
    engineeringLifecycleEngine,
    planEngine,
    specEngine,
    brainstormEngine,
    prdEngine,
    auditEngine,
    assignmentEngine,
    specContextService,
    editorService,
    repositoryService,
    gitService,
    branchBackfillDeps,
    vault,
    gitCredentialRef,
    githubAuthService,
    skillUpdates: options.skillUpdates,
    diagnosticsService,
    memoryService,
    attachmentGrantRepo,
    harnessUsageRepo,
    modelRankingRepo,
    rankingSnapshotRepo,
    noteRepo,
    privilegedIpc,
    privileged,
    attachmentStorageDirectory,
    waitForThreadReady,
    resolveProjectPath,
    providerForProject,
    pullRequestTarget
  }

  registerEngineeringLifecycleHandlers(ctx)
  registerFilesHandlers(ctx)
  registerConfigHandlers(ctx)
  registerMemoryHandlers(ctx)
  registerSpecHandlers(ctx)
  registerSystemHandlers(ctx)
  registerProjectHandlers(ctx)
  registerGitHandlers(ctx)
  registerGitRemoteHandlers(ctx)
  registerMergeHandlers(ctx)
  registerPrHandlers(ctx)
  registerCloudHandlers(ctx)
  registerEditorsHandlers(ctx)
  registerThreadHandlers(ctx)
  registerNotesHandlers(ctx)
  registerHistoryHandlers(ctx)
  registerSearchHandlers(ctx)
  registerPlanHandlers(ctx)
  registerUpdaterHandlers(ctx)
}
