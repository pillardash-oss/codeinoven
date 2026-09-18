import type { IpcMainInvokeEvent } from 'electron'
import type { Database } from '../../database/database'
import type { StorageEngine } from '../../storage/storage-engine'
import type { UpdaterService } from '../../notifications/updater-service'
import type { ChatEngine } from '../../chat/chat-engine'
import type { ProjectManager } from '../../../lib/engines/project-manager'
import type { ThreadManager } from '../../../lib/engines/thread-manager'
import type { ScopeManager } from '../../../lib/engines/scope-manager'
import type { ScopeWorktreeService } from '../../git/scope-worktree-service'
import type { ScopeThreadLifecycle } from '../../git/scope-worktree-service'
import type {
  ScopeRootResolver,
  scopeRootProvider,
  ManagedWorktreeInspector
} from '../../workspaces/scope-root-resolver'
import type { SyncPeerService } from '../../git/sync-peer-service'
import type { ProjectFilesService } from '../../editor/project-files-service'
import type { DirectoryPreviewService } from '../../preview/directory-preview-service'
import type { CheckpointManager } from '../../storage/checkpoint-manager'
import type { ThreadCreationCoordinator } from '../../chat/thread-creation-coordinator'
import type { ThreadDeletionCoordinator } from '../../chat/thread-deletion-coordinator'
import type { ThreadBranchDeps } from '../../chat/thread-branch-service'
import type { HistoryEngine } from '../../../lib/engines/history-engine'
import type { EngineeringLifecycleEngine } from '../../../lib/engines/engineering-lifecycle-engine'
import type { PlanEngine } from '../../../lib/engines/plan-engine'
import type { SpecEngine } from '../../../lib/engines/spec-engine'
import type { BrainstormEngine } from '../../../lib/engines/brainstorm-engine'
import type { PrdEngine } from '../../../lib/engines/prd-engine'
import type { AuditEngine } from '../../../lib/engines/audit-engine'
import type { AssignmentEngine } from '../../../lib/engines/assignment-engine'
import type { SpecContextService } from '../../chat/spec-context-service'
import type { EditorService } from '../../editor/editor-service'
import type { RepositoryService } from '../../git/repository-service'
import type { GitService } from '../../git/git-service'
import type { GitProvider } from '../../git/git-provider.interface'
import type { SecretVault } from '../../storage/secret-vault'
import type { GitHubAuthService } from '../../git/github-auth-service'
import type { DiagnosticsService } from '../../system/diagnostics-service'
import type { MemoryService } from '../../chat/memory-service'
import type { HarnessManifestService } from '../../agents/harness-manifest-service'
import type { PowerWakeService } from '../../system/power-wake-service'
import type { RetrySchedulerService } from '../../system/retry-scheduler-service'
import type { HeartbeatSchedulerService } from '../../system/heartbeat-scheduler-service'
import type { AttachmentGrantRepo } from '../../database/repositories/attachment-grant-repo'
import type { HarnessUsageRepo } from '../../database/repositories/harness-usage-repo'
import type { ModelRankingRepo } from '../../database/repositories/model-ranking-repo'
import type { NoteRepo } from '../../database/repositories/note-repo'
import type { PrivilegedIpcValidator } from '../ipc-validation'
import type { AttachmentStorageScope } from '../../../lib/types'

export interface RegisterIpcHandlersOptions {
  projectManager?: ProjectManager
  projectFilesService?: ProjectFilesService
  /** Loopback static servers behind the file tree's "Open in browser" action. */
  directoryPreviewService?: DirectoryPreviewService
  powerWakeService?: PowerWakeService
  /** Auto-resume scheduler gated by the General settings toggle. */
  retryScheduler?: RetrySchedulerService
  /** Timed usage-window "keep warm" ping scheduler backing the Heartbeat settings page. */
  heartbeatScheduler?: HeartbeatSchedulerService
  /** Confirmed-override layer on the declarative harness behavior manifests. */
  harnessManifestService?: HarnessManifestService
  /** Hydration channels already registered before BrowserWindow navigation. */
  hydrationHandlersRegistered?: boolean
  /** Optimistic thread-create finalization coordinator shared with ChatEngine. */
  threadCreation?: ThreadCreationCoordinator
  /** Optimistic thread-delete cleanup coordinator shared with remote RPC. */
  threadDeletion?: ThreadDeletionCoordinator
  /** Git-backed inspector shared with the managed worktree service. */
  worktreeInspector?: ManagedWorktreeInspector
  /** Shared managed-worktree service; the resolver inspector falls back to it. */
  worktreeService?: ScopeWorktreeService
  /** Speech service for auto-evict of idle sound models. */
  speechService?: { updateUnloadOptions: (opts: Record<string, unknown>) => void }
  /** Receives the privileged scoped-path resolver so other main-process
   *  boundaries (the `appfile://` preview protocol) authorize paths exactly
   *  like privileged IPC does. */
  onScopedPathResolver?: (resolve: (value: unknown) => Promise<string>) => void
}

/** The chat-engine surface the IPC layer depends on. */
export type IpcChatEngine = Pick<
  ChatEngine,
  | 'loadMessages'
  | 'deleteThreadSession'
  | 'activeTurnChangeSummary'
  | 'hasActiveProcessesInScope'
  | 'abort'
  | 'recordUserFileSave'
> &
  Partial<
    Pick<
      ChatEngine,
      'runVirtualTask' | 'setScopeToolService' | 'setAssignmentWorkerScopeProvisioner'
    >
  >

/**
 * Everything the domain handler modules share. The composition root builds one
 * instance and passes it to each register function, so no handler module ever
 * reaches for a module-level singleton.
 */
export interface IpcHandlerContext {
  storage: StorageEngine
  database: Database
  updaterService: UpdaterService | undefined
  chatEngine: IpcChatEngine | undefined
  options: RegisterIpcHandlersOptions
  projectManager: ProjectManager
  threadCreation: ThreadCreationCoordinator
  threadDeletion: ThreadDeletionCoordinator
  checkpointManager: CheckpointManager
  scopeManager: ScopeManager
  scopeWorktreeService: ScopeWorktreeService
  scopeThreadLifecycle: ScopeThreadLifecycle
  scopeRootResolver: ScopeRootResolver
  /** Resolves a sync's other end: every checkout and branch, named once. */
  syncPeers: SyncPeerService
  scopeRoots: ReturnType<typeof scopeRootProvider>
  projectFilesService: ProjectFilesService
  threadManager: ThreadManager
  historyEngine: HistoryEngine
  engineeringLifecycleEngine: EngineeringLifecycleEngine
  planEngine: PlanEngine
  specEngine: SpecEngine
  brainstormEngine: BrainstormEngine
  prdEngine: PrdEngine
  auditEngine: AuditEngine
  assignmentEngine: AssignmentEngine
  specContextService: SpecContextService
  editorService: EditorService
  repositoryService: RepositoryService
  gitService: GitService
  branchBackfillDeps: ThreadBranchDeps
  vault: SecretVault
  gitCredentialRef: (projectId: string) => string
  githubAuthService: GitHubAuthService
  diagnosticsService: DiagnosticsService
  memoryService: MemoryService
  attachmentGrantRepo: AttachmentGrantRepo
  harnessUsageRepo: HarnessUsageRepo
  modelRankingRepo: ModelRankingRepo
  noteRepo: NoteRepo
  privilegedIpc: PrivilegedIpcValidator
  /** Register a privileged channel whose sender frame must be trusted. */
  privileged: <TArgs extends unknown[]>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: TArgs) => unknown
  ) => void
  attachmentStorageDirectory: (scope: AttachmentStorageScope) => Promise<string>
  /** Wait for an optimistic thread-create to be persisted before proceeding. */
  waitForThreadReady: (
    projectId: unknown,
    threadId: unknown,
    projectLabel?: string,
    threadLabel?: string
  ) => Promise<{ projectId: string; threadId: string }>
  /** Resolve a project or managed-worktree root for a git operation. */
  resolveProjectPath: (projectId: string, scopeBucketId?: string) => Promise<string>
  /** Resolve the GitHub provider for a project from OAuth or a stored PAT. */
  providerForProject: (projectId: string) => Promise<GitProvider | null>
  /** Resolve a PR target (provider plus validated owner/repo/number). */
  pullRequestTarget: (
    projectId: unknown,
    owner: unknown,
    repo: unknown,
    pullNumber: unknown
  ) => Promise<{ provider: GitProvider; owner: string; repo: string; pullNumber: number }>
}
