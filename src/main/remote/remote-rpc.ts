/**
 * Main-process dispatcher for the phone client's remote RPC bridge.
 *
 * The phone PWA speaks the same `invoke`/`subscribe` surface as the desktop
 * renderer, but instead of Electron IPC the calls arrive over the encrypted
 * WebSocket bridge. This dispatcher resolves each channel to the SAME service
 * used by the desktop IPC handlers (ThreadManager, ProjectManager,
 * ChatEngine), so the phone sees an identical data surface   threads, messages,
 * settings, permissions   and can stream live `agent:event` updates.
 *
 * Security: only channels in `REMOTE_ALLOWED_CHANNELS` are ever dispatched;
 * anything else is rejected before touching a service.
 *
 * This file is the composition root: device authorization lives in
 * `remote-rpc/remote-rpc-authorization.ts`, attachment staging in
 * `remote-rpc/remote-rpc-attachments.ts`, and the channel bodies are grouped by
 * domain in `remote-rpc-agent.ts`, `remote-rpc-workflow.ts`,
 * `remote-rpc-studios.ts`, and `remote-rpc-git.ts`.
 */

import { ThreadManager } from '../../lib/engines/thread-manager'
import { EngineeringLifecycleEngine } from '../../lib/engines/engineering-lifecycle-engine'
import { PrdEngine } from '../../lib/engines/prd-engine'
import { NoteRepo } from '../database/repositories/note-repo'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ProjectFilesService } from '../editor/project-files-service'
import { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import {
  broadcastNoteChanged,
  broadcastThreadDeleted,
  broadcastThreadUpdate
} from '../chat/thread-events'
import { REMOTE_ALLOWED_CHANNELS } from '../../lib/remote-rpc'
import { authorizationForChannel, type RemoteRpcDeviceContext } from '../../lib/remote-rpc'
import { DeviceCredentialService } from './device-credential-service'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ScopeWorktreeService } from '../git/scope-worktree-service'
import { ScopeRootResolver, scopeRootProvider } from '../workspaces/scope-root-resolver'
import { SpecEngine } from '../../lib/engines/spec-engine'
import { BrainstormEngine } from '../../lib/engines/brainstorm-engine'
import { AuditEngine } from '../../lib/engines/audit-engine'
import { AssignmentEngine } from '../../lib/engines/assignment-engine'
import { SpecContextService } from '../chat/spec-context-service'
import { CheckpointManager } from '../storage/checkpoint-manager'
import { MemoryService } from '../chat/memory-service'
import { RepositoryService } from '../git/repository-service'
import { GitService } from '../git/git-service'
import { SecretVault } from '../storage/secret-vault'
import { GitHubAuthService } from '../git/github-auth-service'
import { validateEngineeringSpec } from '../../lib/spec/spec-validation'
import { StorageEngine } from '../storage/storage-engine'
import {
  validateBoundedString,
  validateEntityId,
  validateScopeAppearancePatch,
  validateScopeCollapsePatch,
  validateScopeCreateInput,
  validateScopeOrderIds,
  validateScopeSlice,
  validateScopeTarget,
  validateSourcePath,
  validateWorktreeDefaults
} from '../ipc/ipc-validation'
import type {
  AttachmentStorageScope,
  CreateThreadInput,
  Thread,
  ThreadContextUsage,
  ThreadSettings
} from '../../lib/types'
import { Logger } from '../system/logger'
import { remoteWebPush, type RemotePushSubscription } from './web-push-service'
import type {
  RemoteInvoke,
  RemoteRpcResult,
  RemoteRpcServices
} from './remote-rpc/remote-rpc-types'
import { RemoteAttachmentStore } from './remote-rpc/remote-rpc-attachments'
import {
  approveRemoteStepUp,
  authorizeRemoteRpc,
  listRemoteAuditEvents,
  listRemotePendingApprovals,
  remoteResourceForChannel
} from './remote-rpc/remote-rpc-authorization'
import { REMOTE_RPC_UNHANDLED, type RemoteRpcCallContext } from './remote-rpc/remote-rpc-context'
import { callRemoteAgentRpc } from './remote-rpc/remote-rpc-agent'
import { callRemoteWorkflowRpc } from './remote-rpc/remote-rpc-workflow'
import { callRemoteStudioRpc } from './remote-rpc/remote-rpc-studios'
import { callRemoteGitRpc } from './remote-rpc/remote-rpc-git'
import {
  optionalString,
  requireBoolean,
  requireRemoteDeviceId,
  requireString,
  requireStringArray
} from './remote-rpc/remote-rpc-args'

export type {
  RemoteInvoke,
  RemoteRpcResult,
  RemoteRpcServices
} from './remote-rpc/remote-rpc-types'

const NOTE_BODY_MAX = 100_000

export class RemoteRpcDispatcher {
  private readonly threadManager: ThreadManager
  private readonly noteRepo: NoteRepo
  private readonly projectManager: ProjectManager
  private readonly projectFilesService: ProjectFilesService
  private readonly scopeManager: ScopeManager
  private readonly scopeWorktreeService: ScopeWorktreeService
  private readonly scopeRoots: ReturnType<typeof scopeRootProvider>
  private readonly specEngine: SpecEngine
  private readonly engineeringLifecycleEngine: EngineeringLifecycleEngine
  private readonly prdEngine: PrdEngine
  private readonly brainstormEngine: BrainstormEngine
  private readonly auditEngine: AuditEngine
  private readonly assignmentEngine: AssignmentEngine
  private readonly specContextService: SpecContextService
  private readonly checkpointManager: CheckpointManager
  private readonly memoryService: MemoryService
  private readonly repositoryService: RepositoryService
  private readonly gitService: GitService
  private readonly vault: SecretVault
  private readonly githubAuthService: GitHubAuthService
  private readonly storage: StorageEngine
  private readonly credentials: DeviceCredentialService | null
  private readonly threadCreation: ThreadCreationCoordinator
  private readonly threadDeletion: ThreadDeletionCoordinator
  private readonly attachments: RemoteAttachmentStore
  private readonly context: RemoteRpcCallContext

  constructor(private readonly services: RemoteRpcServices) {
    this.storage = services.storage ?? new StorageEngine()
    this.credentials = services.credentials ?? null
    this.threadCreation = services.threadCreation ?? new ThreadCreationCoordinator()
    this.threadDeletion = services.threadDeletion ?? new ThreadDeletionCoordinator()
    this.checkpointManager = new CheckpointManager(services.database)
    this.threadManager = new ThreadManager(
      services.database,
      broadcastThreadUpdate,
      async (thread) => {
        await services.chatEngine.deleteThreadSession(thread.projectId, thread.id)
        await this.memoryService.deleteThreadMemory(thread.projectId, thread.id)
      },
      async (threads) => {
        for (const thread of threads) broadcastThreadDeleted(thread)
        for (const projectId of new Set(threads.map((thread) => thread.projectId))) {
          await this.checkpointManager.pruneUnusedBlobs(projectId)
        }
      }
    )
    this.noteRepo = new NoteRepo(services.database)
    this.projectManager = services.projectManager ?? new ProjectManager(services.database)
    this.projectFilesService = new ProjectFilesService(this.projectManager)
    this.scopeManager = new ScopeManager(services.database)
    this.scopeWorktreeService = new ScopeWorktreeService(this.scopeManager, this.projectManager)
    this.scopeRoots = scopeRootProvider(
      new ScopeRootResolver(this.projectManager, this.scopeManager, this.scopeWorktreeService)
    )
    this.specEngine = new SpecEngine(this.storage, services.database, {
      validateForApproval: validateEngineeringSpec
    })
    this.engineeringLifecycleEngine = new EngineeringLifecycleEngine(services.database)
    this.prdEngine = new PrdEngine(this.storage, services.database)
    this.brainstormEngine = new BrainstormEngine(this.storage, services.database)
    this.auditEngine = new AuditEngine(this.storage, services.database)
    this.assignmentEngine = new AssignmentEngine(this.storage, services.database)
    this.specContextService = new SpecContextService(services.database, this.projectManager)
    this.memoryService = new MemoryService(this.storage)
    this.repositoryService = new RepositoryService()
    this.gitService = new GitService()
    this.vault = new SecretVault(this.storage)
    this.githubAuthService = new GitHubAuthService(this.vault)
    this.attachments = new RemoteAttachmentStore(this.projectManager)
    this.context = {
      chatEngine: services.chatEngine,
      threadManager: this.threadManager,
      threadCreation: this.threadCreation,
      threadDeletion: this.threadDeletion,
      projectManager: this.projectManager,
      projectFilesService: this.projectFilesService,
      scopeManager: this.scopeManager,
      scopeWorktreeService: this.scopeWorktreeService,
      scopeRoots: this.scopeRoots,
      specEngine: this.specEngine,
      engineeringLifecycleEngine: this.engineeringLifecycleEngine,
      prdEngine: this.prdEngine,
      brainstormEngine: this.brainstormEngine,
      auditEngine: this.auditEngine,
      assignmentEngine: this.assignmentEngine,
      specContextService: this.specContextService,
      checkpointManager: this.checkpointManager,
      memoryService: this.memoryService,
      repositoryService: this.repositoryService,
      gitService: this.gitService,
      vault: this.vault,
      githubAuthService: this.githubAuthService,
      storage: this.storage,
      noteRepo: this.noteRepo,
      attachments: this.attachments,
      credentials: this.credentials
    }
  }

  /** Whether a channel is callable over the remote bridge. */
  isAllowed(channel: string): boolean {
    return REMOTE_ALLOWED_CHANNELS.includes(channel)
  }

  /** Dispatch a validated invoke. Returns the result or a rejected reason. */
  async dispatch(invoke: RemoteInvoke): Promise<RemoteRpcResult> {
    if (!this.isAllowed(invoke.channel)) {
      return { ok: false, message: `Channel not allowed over the remote bridge: ${invoke.channel}` }
    }
    // Fail closed: when device identity is configured, no invocation executes
    // without an authenticated device   the cloud relay cannot bypass device
    // authorization by calling the dispatcher without a device context.
    if (!invoke.device && this.credentials) {
      this.credentials.audit({
        decision: 'rpc_denied',
        reasonCode: 'denied_by_default',
        deviceId: null,
        transport: 'lan',
        sessionId: null,
        requestId: String(invoke.id),
        channel: invoke.channel
      })
      return { ok: false, message: 'Device authentication required for remote RPC' }
    }
    let stepUpApprovalId: string | null = null
    if (invoke.device) {
      const authorized = await authorizeRemoteRpc(this.credentials, invoke)
      if (!authorized.allowed) {
        if (authorized.denied.code === 'step_up_required') {
          return {
            ok: false,
            message: JSON.stringify(authorized.denied)
          }
        }
        return { ok: false, message: `Access denied: ${authorized.denied.reason}` }
      }
      stepUpApprovalId = authorized.stepUpApprovalId ?? null
    }
    try {
      // The remote bridge transports args as JSON, which cannot represent
      // `undefined`   an omitted optional argument (e.g. `presentation`,
      // `specAction`) arrives as `null`. Normalize so optional parameters
      // behave exactly as they do on the desktop IPC path.
      const args = invoke.args.map((arg) => (arg === null ? undefined : arg))
      const result = await this.call(invoke.channel, args, invoke.device)
      const authMeta = authorizationForChannel(invoke.channel)
      this.credentials?.audit({
        decision: 'rpc_allowed',
        deviceId: invoke.device?.deviceId ?? null,
        deviceName: invoke.device?.name ?? null,
        fingerprintPrefix: invoke.device?.fingerprint.slice(0, 8) ?? null,
        transport: invoke.device?.transport ?? 'lan',
        sessionId: invoke.device?.sessionId ?? null,
        requestId: invoke.device?.requestId ?? null,
        channel: invoke.channel,
        resourceId: remoteResourceForChannel(invoke.channel, invoke.args),
        requiredScope: authMeta?.scope ?? null,
        stepUpApprovalId,
        authVersion: invoke.device?.authVersion ?? null
      })
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logger.error(`Remote RPC ${invoke.channel} failed:`, error)
      // An explicit failure outcome attributes the thrown execution failure to
      // the device, capability, transport, session, and request.
      const authMeta = authorizationForChannel(invoke.channel)
      this.credentials?.audit({
        decision: 'rpc_failed',
        reasonCode: 'execution_failed',
        deviceId: invoke.device?.deviceId ?? null,
        deviceName: invoke.device?.name ?? null,
        fingerprintPrefix: invoke.device?.fingerprint.slice(0, 8) ?? null,
        transport: invoke.device?.transport ?? 'lan',
        sessionId: invoke.device?.sessionId ?? null,
        requestId: invoke.device?.requestId ?? null,
        channel: invoke.channel,
        resourceId: remoteResourceForChannel(invoke.channel, invoke.args),
        requiredScope: authMeta?.scope ?? null,
        stepUpApprovalId,
        authVersion: invoke.device?.authVersion ?? null
      })
      return { ok: false, message }
    }
  }

  /** Local desktop approval for a pending step-up request (trusted IPC only). */
  approveStepUp(approvalId: string, decision: 'approved' | 'rejected'): boolean {
    return approveRemoteStepUp(this.credentials, approvalId, decision)
  }

  listPendingApprovals(): ReturnType<DeviceCredentialService['listPendingApprovals']> {
    return listRemotePendingApprovals(this.credentials)
  }

  listAuditEvents(limit = 100): ReturnType<DeviceCredentialService['listAudit']> {
    return listRemoteAuditEvents(this.credentials, limit)
  }

  private async call(
    channel: string,
    args: unknown[],
    device?: RemoteRpcDeviceContext
  ): Promise<unknown> {
    // Domain handlers own disjoint channel sets; each returns the sentinel when
    // the channel is not one of its cases.
    const agentOutcome = await callRemoteAgentRpc(this.context, channel, args)
    if (agentOutcome !== REMOTE_RPC_UNHANDLED) return agentOutcome
    const workflowOutcome = await callRemoteWorkflowRpc(this.context, channel, args)
    if (workflowOutcome !== REMOTE_RPC_UNHANDLED) return workflowOutcome
    const studioOutcome = await callRemoteStudioRpc(this.context, channel, args)
    if (studioOutcome !== REMOTE_RPC_UNHANDLED) return studioOutcome
    const gitOutcome = await callRemoteGitRpc(this.context, channel, args)
    if (gitOutcome !== REMOTE_RPC_UNHANDLED) return gitOutcome

    switch (channel) {
      // ─── Projects ────────────────────────────────────────────────────────
      case 'project:list':
        return this.projectManager.listProjects()
      case 'project:get':
        return this.projectManager.getProject(requireString(args[0]))
      case 'project:getIcon':
        return this.projectManager.getIconDataUrl(requireString(args[0]))
      case 'project:ensureInbox':
        return this.projectManager.ensureInboxProject()

      // ─── Threads ─────────────────────────────────────────────────────────
      case 'thread:listAll':
        return this.threadManager.listAllThreads()
      case 'thread:list':
        return this.threadManager.listThreads(requireString(args[0]))
      case 'thread:get':
        // Reads never wait for optimistic thread finalization; the remote
        // renderer already holds the thread object from `thread:create`.
        return this.threadManager.getThread(requireString(args[0]), requireString(args[1]))
      case 'thread:create': {
        const { thread, finalize } = this.threadManager.prepareCreateThread(
          args[0] as CreateThreadInput
        )
        this.threadCreation.begin(
          thread.id,
          async () => {
            await finalize()
            broadcastThreadUpdate(thread)
          },
          () => broadcastThreadDeleted(thread)
        )
        return thread
      }
      case 'thread:markRead':
        return this.threadManager.markRead(requireString(args[0]), requireString(args[1]))
      case 'thread:setPinned':
        return this.threadManager.setPinned(
          requireString(args[0]),
          requireString(args[1]),
          Boolean(args[2])
        )
      case 'thread:setStatus':
        return this.threadManager.setStatus(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]) as Thread['status'],
          args[3] as { read?: boolean } | undefined
        )
      case 'thread:updateSettings':
        return this.threadManager.updateSettings(
          requireString(args[0]),
          requireString(args[1]),
          args[2] as ThreadSettings
        )
      case 'thread:setContextUsage':
        await this.threadManager.setContextUsage(
          requireString(args[0]),
          requireString(args[1]),
          args[2] as ThreadContextUsage
        )
        return undefined
      case 'thread:harnessUsage':
        return this.threadManager.harnessUsageFor(requireString(args[0]), requireString(args[1]))
      case 'thread:efficiencyKpis':
        return this.threadManager.efficiencyKpisFor(requireString(args[0]), requireString(args[1]))
      case 'thread:loadMessages': {
        const before = args[2] as { createdAt?: number; id?: string } | undefined
        return this.threadManager.loadMessagePage(
          requireString(args[0]),
          requireString(args[1]),
          before && typeof before === 'object'
            ? {
                createdAt: before.createdAt ?? 0,
                id: before.id ?? ''
              }
            : undefined,
          typeof args[3] === 'number' ? args[3] : 40
        )
      }
      case 'thread:loadStreamParts': {
        const query = args[2] as Record<string, unknown> | undefined
        return this.services.chatEngine.loadTurnStreamParts(
          requireString(args[0]),
          requireString(args[1]),
          query && typeof query === 'object'
            ? {
                beforeId: optionalString(query.beforeId),
                changedSince:
                  typeof query.changedSince === 'number' ? query.changedSince : undefined,
                limit: typeof query.limit === 'number' ? query.limit : undefined
              }
            : undefined
        )
      }
      case 'thread:update':
        return this.threadManager.updateThread(
          requireString(args[0]),
          requireString(args[1]),
          args[2] as Record<string, unknown>
        )
      case 'thread:delete':
        {
          const projectId = requireString(args[0])
          const threadId = requireString(args[1])
          this.threadDeletion.begin(
            projectId,
            threadId,
            () => this.threadManager.deleteThread(projectId, threadId),
            () => {
              void this.threadManager.getThreadViaWorker(projectId, threadId).then((thread) => {
                if (thread) broadcastThreadUpdate(thread)
              })
            }
          )
        }
        return undefined
      case 'thread:fork': {
        return this.threadManager.forkThread(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]),
          typeof args[3] === 'string' ? args[3] : undefined,
          typeof args[4] === 'string' ? args[4] : undefined,
          typeof args[5] === 'string' ? args[5] : undefined
        )
      }
      case 'thread:reorderScope':
        return this.threadManager.reorderScopeThreads(
          requireString(args[0]),
          requireString(args[1]),
          validateScopeSlice(args[2]),
          requireStringArray(args[3], 'Ordered scope thread IDs')
        )
      case 'threads:search':
        return this.threadManager.searchThreads(
          requireString(args[0]),
          (args[1] ?? {}) as { projectId?: string; limit?: number }
        )
      case 'note:get': {
        const projectId = validateEntityId(args[0], 'Project ID')
        const threadId = validateEntityId(args[1], 'Thread ID')
        const thread = await this.threadManager.getThread(projectId, threadId)
        return thread ? this.noteRepo.get(threadId) : null
      }
      case 'note:list':
        return this.noteRepo.listThreadIds()
      case 'note:save': {
        const projectId = validateEntityId(args[0], 'Project ID')
        const threadId = validateEntityId(args[1], 'Thread ID')
        const body = validateBoundedString(args[2], 'Note body', 0, NOTE_BODY_MAX)
        const thread = await this.threadManager.getThread(projectId, threadId)
        if (!thread) throw new Error('Thread not found')
        const previous = this.noteRepo.get(threadId)
        const now = Date.now()
        const note = {
          threadId,
          body,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now
        }
        this.noteRepo.upsert(note)
        broadcastNoteChanged(projectId, threadId, true)
        return note
      }
      case 'note:delete': {
        const projectId = validateEntityId(args[0], 'Project ID')
        const threadId = validateEntityId(args[1], 'Thread ID')
        const thread = await this.threadManager.getThread(projectId, threadId)
        if (!thread) throw new Error('Thread not found')
        this.noteRepo.delete(threadId)
        broadcastNoteChanged(projectId, threadId, false)
        return undefined
      }
      case 'attachment:beginRemoteUpload':
        return this.context.attachments.begin(
          device,
          args[0] as AttachmentStorageScope,
          requireString(args[1]),
          args[2]
        )
      case 'attachment:appendRemoteUpload':
        return this.context.attachments.append(
          device,
          requireString(args[0]),
          args[1],
          requireString(args[2])
        )
      case 'attachment:finishRemoteUpload':
        return this.context.attachments.finish(device, requireString(args[0]))
      case 'attachment:cancelRemoteUpload':
        return this.context.attachments.cancel(device, requireString(args[0]))
      case 'attachment:readRemoteChunk':
        return this.context.attachments.readChunk(requireString(args[0]), args[1])
      case 'remotePush:getPublicKey':
        return remoteWebPush.publicKey()
      case 'remotePush:subscribe':
        return remoteWebPush.subscribe(
          requireRemoteDeviceId(device),
          args[0] as RemotePushSubscription
        )
      case 'remotePush:unsubscribe':
        return remoteWebPush.unsubscribe(requireString(args[0]))

      // ─── Config ─────────────────────────────────────────────────────────
      case 'config:get':
        return this.storage.getConfig()
      case 'config:update':
        await this.storage.saveConfig({
          ...(await this.storage.getConfig()),
          ...(args[0] as Record<string, unknown>)
        })
        return this.storage.getConfig()
      case 'config:syncAgentRole': {
        const config = await this.storage.getConfig()
        const role = requireString(args[0]) as 'seniorEngineer' | 'worker' | 'auditor'
        const selection = args[1] as { harnessId: string; providerId: string; modelId: string }
        if (!config.agentDefaults.syncFromThreadChanges) return config
        const updated = {
          ...config,
          agentDefaults: {
            ...config.agentDefaults,
            [role]: selection
          }
        }
        await this.storage.saveConfig(updated)
        return updated
      }

      // ─── Scope board ("charts") ─────────────────────────────────────────
      case 'scope:get':
        return this.scopeManager.getBoard(requireString(args[0]))
      case 'scope:updateLayout':
        return this.scopeManager.updateLayout(
          requireString(args[0]),
          validateScopeOrderIds(args[1])
        )
      case 'scope:updateAppearance':
        return this.scopeManager.updateAppearance(
          requireString(args[0]),
          requireString(args[1]),
          validateScopeAppearancePatch(args[2])
        )
      case 'scope:updateCollapse':
        return this.scopeManager.updateCollapse(
          requireString(args[0]),
          requireString(args[1]),
          validateScopeCollapsePatch(args[2])
        )
      case 'scope:create':
        return this.scopeManager.createBucket(
          requireString(args[0]),
          validateScopeCreateInput(args[1])
        )
      case 'scope:setArchive':
        return this.scopeManager.setArchive(
          requireString(args[0]),
          requireString(args[1]),
          requireBoolean(args[2])
        )
      case 'scope:setPinned':
        return this.scopeManager.setPinned(
          requireString(args[0]),
          requireString(args[1]),
          requireBoolean(args[2])
        )
      case 'scope:delete':
        return this.scopeManager.deleteBucket(requireString(args[0]), requireString(args[1]))
      case 'scope:setWorktreeDefaults':
        return this.scopeManager.setWorktreeDefaults(
          requireString(args[0]),
          validateWorktreeDefaults(args[1])
        )
      case 'scope:worktree:health':
        return this.scopeWorktreeService.health(validateScopeTarget(args[0]))
      case 'scope:worktree:sourceInfo':
        return this.scopeWorktreeService.sourceInfo(requireString(args[0]))
      case 'scope:worktree:detectAdopt':
        return this.scopeWorktreeService.detectAdoptable(
          requireString(args[0]),
          validateSourcePath(args[1])
        )

      // ─── Checkpoints ────────────────────────────────────────────────────
      case 'checkpoint:list':
        return this.checkpointManager.listSummaries(requireString(args[0]), requireString(args[1]))
      case 'checkpoint:activeSummary':
        return this.services.chatEngine.activeTurnChangeSummary(
          requireString(args[0]),
          requireString(args[1])
        )
      case 'checkpoint:liveDiff':
        return this.checkpointManager.getLiveFileDiff(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]),
          requireString(args[3])
        )
      case 'checkpoint:diff':
        return this.checkpointManager.getFileDiff(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]),
          requireString(args[3])
        )
      case 'checkpoint:rollbackPaths':
        await this.checkpointManager.rollbackPaths(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]),
          requireStringArray(args[3], 'Checkpoint paths')
        )
        return this.checkpointManager.listSummaries(requireString(args[0]), requireString(args[1]))
      case 'checkpoint:redoPaths':
        await this.checkpointManager.redoPaths(
          requireString(args[0]),
          requireString(args[1]),
          requireString(args[2]),
          requireStringArray(args[3], 'Checkpoint paths')
        )
        return this.checkpointManager.listSummaries(requireString(args[0]), requireString(args[1]))

      // ─── Memory ─────────────────────────────────────────────────────────
      case 'memory:getPendingProposals':
        return this.memoryService.getPendingProposals(
          typeof args[0] === 'string' ? args[0] : undefined
        )
      case 'memory:approveProposal':
        return this.memoryService.approveProposal(
          requireString(args[0]),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'memory:rejectProposal':
        return this.memoryService.rejectProposal(
          requireString(args[0]),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'memory:getEntries':
        return this.memoryService.getEntries(
          typeof args[0] === 'string' ? args[0] : undefined,
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'memory:saveEntries':
        await this.memoryService.saveEntries(
          args[0] as Parameters<typeof this.memoryService.saveEntries>[0],
          typeof args[1] === 'string' ? args[1] : undefined,
          typeof args[2] === 'string' ? args[2] : undefined
        )
        return undefined

      // ─── Project files ──────────────────────────────────────────────────
      case 'projectFiles:search':
        return this.projectFilesService.searchFiles(
          requireString(args[0]),
          typeof args[1] === 'string' ? args[1] : '',
          (args[2] as 'all' | 'rules') ?? 'all'
        )
      case 'projectFiles:resolveCitationPaths':
        return this.projectFilesService.resolveCitationPaths(
          requireString(args[0]),
          (args[1] ?? []) as string[]
        )
      case 'projectFiles:resolveExternalCitationPaths':
        return this.projectFilesService.resolveExternalCitationPaths((args[0] ?? []) as string[])

      // ─── Repo metadata ──────────────────────────────────────────────────
      case 'repository:remoteOrigin':
        return this.repositoryService.getRemoteOrigin(requireString(args[0]))
      case 'repository:preflight':
        return this.repositoryService.preflight(requireString(args[0]))
      // ─── Electron-only helpers   the phone cannot use these, but the
      //     shared components call them; return a graceful no-op. ─────────
      case 'dialog:pickFile':
      case 'clipboard:saveImage':
        return null
      case 'dialog:pickFiles':
        return []
      case 'shell:revealPath':
      case 'shell:openExternal':
        return undefined

      default:
        throw new Error(`Unknown remote channel: ${channel}`)
    }
  }
}
