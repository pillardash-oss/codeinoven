/**
 * Main-process dispatcher for the phone client's remote RPC bridge.
 *
 * The phone PWA speaks the same `invoke`/`subscribe` surface as the desktop
 * renderer, but instead of Electron IPC the calls arrive over the encrypted
 * WebSocket bridge. This dispatcher resolves each channel to the SAME service
 * used by the desktop IPC handlers (ThreadManager, ProjectManager,
 * ChatEngine), so the phone sees an identical data surface — threads, messages,
 * settings, permissions — and can stream live `agent:event` updates.
 *
 * Security: only channels in `REMOTE_ALLOWED_CHANNELS` are ever dispatched;
 * anything else is rejected before touching a service.
 */

import type { Database } from '../database/database'
import { appendFile, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { EngineeringLifecycleEngine } from '../../lib/engines/engineering-lifecycle-engine'
import {
  PrdEngine,
  type AddPrdAnnotationInput,
  type NewPrdProvenance
} from '../../lib/engines/prd-engine'
import { parseGeneratedPrdContent } from '../../lib/prd/prd-validation'
import { resolvePrototypePreviewOrigin } from '../prototypes/prototype-preview-origin'

declare const __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: string | undefined
import { NoteRepo } from '../database/repositories/note-repo'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ProjectFilesService } from '../editor/project-files-service'
import type { ChatEngine } from '../chat/chat-engine'
import { ThreadCreationCoordinator } from '../chat/thread-creation-coordinator'
import { ThreadDeletionCoordinator } from '../chat/thread-deletion-coordinator'
import {
  broadcastNoteChanged,
  broadcastThreadDeleted,
  broadcastThreadUpdate
} from '../chat/thread-events'
import { REMOTE_ALLOWED_CHANNELS } from '../../lib/remote-rpc'
import {
  authorizationForChannel,
  type RemoteRpcDenied,
  type RemoteRpcDeviceContext,
  type RemoteRpcStepUpRequired
} from '../../lib/remote-rpc'
import { DeviceCredentialService, sha256Hex } from './device-credential-service'
import { ScopeManager } from '../../lib/engines/scope-manager'
import { ScopeWorktreeService } from '../git/scope-worktree-service'
import { ScopeRootResolver, scopeRootProvider } from '../workspaces/scope-root-resolver'
import {
  SpecEngine,
  type NewSpecProvenance,
  type AddSpecAnnotationInput
} from '../../lib/engines/spec-engine'
import {
  BrainstormEngine,
  type AddBrainstormAnnotationInput
} from '../../lib/engines/brainstorm-engine'
import { AuditEngine, type AddAuditAnnotationInput } from '../../lib/engines/audit-engine'
import {
  AssignmentEngine,
  type AddAssignmentAnnotationInput
} from '../../lib/engines/assignment-engine'
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
  validateEngineeringLifecycleDecision,
  validateEngineeringLifecycleResumeToken,
  validateEngineeringLifecycleSelectionInput,
  validateEngineeringLifecycleStage,
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
  AgentCapabilitySource,
  AssignmentModelSelection,
  AssignmentPlanContent,
  AuditGenerationRequest,
  BrainstormContent,
  BrainstormEntryChoice,
  CreateThreadInput,
  EngineeringSpecContent,
  GitResetMode,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  SpecContextReference,
  SpecValidationIssue,
  Thread,
  ThreadContextUsage,
  ThreadSettings,
  UserMessagePresentation
} from '../../lib/types'
import { Logger } from '../system/logger'
import { getConfigRoot } from '../../lib/utils'
import { PROJECT_DATA_DIRECTORY } from '../../lib/project-artifacts'
import { threadAttachmentDirectory } from '../../lib/thread-storage-paths'
import { remoteWebPush, type RemotePushSubscription } from './web-push-service'
import type { AttachmentStorageScope } from '../../lib/types'

const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024
const MAX_REMOTE_ATTACHMENT_CHUNK_BYTES = 256 * 1024
const REMOTE_ATTACHMENT_READ_CHUNK_BYTES = 192 * 1024
const MAX_CONCURRENT_REMOTE_UPLOADS = 16
const NOTE_BODY_MAX = 100_000
const REMOTE_UPLOAD_TTL_MS = 10 * 60 * 1_000

interface RemoteAttachmentUpload {
  deviceId: string
  stagingPath: string
  targetPath: string
  size: number
  received: number
  createdAt: number
}

export interface RemoteRpcServices {
  database: Database
  chatEngine: Pick<
    ChatEngine,
    | 'loadMessages'
    | 'loadTurnStreamParts'
    | 'deleteThreadSession'
    | 'activeTurnChangeSummary'
    | 'listProviderSnapshot'
    | 'getSessionStatus'
    | 'getHarnessAuthStatus'
    | 'ensureSession'
    | 'sendPrompt'
    | 'steerPrompt'
    | 'discardSteer'
    | 'abort'
    | 'listPermissions'
    | 'replyPermission'
    | 'listImageDescriptorErrors'
    | 'replyImageDescriptor'
    | 'listQuestions'
    | 'answerQuestion'
    | 'listCommands'
    | 'runCommand'
    | 'compactSession'
    | 'truncateMessages'
    | 'deleteMessages'
    | 'dismissQuestion'
    | 'updateQuestion'
    | 'listContextCapabilities'
    | 'listProcesses'
    | 'killProcess'
    | 'killThreadProcesses'
    | 'listArtifacts'
    | 'deleteSkill'
    | 'deleteMcp'
    | 'sendTemporaryPrompt'
    | 'steerTemporaryPrompt'
    | 'loadTemporaryConversation'
    | 'getTemporaryChatStatus'
    | 'abortTemporaryChat'
    | 'touchTemporaryChat'
    | 'listProviders'
    | 'refreshAccountUsage'
    | 'loadSessionMessages'
    | 'getChildSessionStatus'
    | 'dismissSessionError'
    | 'retryChildSession'
    | 'abortChildSession'
    | 'closeTemporaryChat'
    | 'chooseBrainstormEntry'
    | 'reviewBrainstorm'
    | 'finalizeBrainstorm'
    | 'generatePrd'
    | 'ensureInitialSpec'
    | 'readPrototypePreviewChunk'
    | 'ensureImplementationAuditorThread'
    | 'startAssignment'
    | 'stopAssignment'
    | 'resumeAssignment'
    | 'generateAudit'
    | 'ensureAssignmentAuditorThread'
    | 'generateAssignmentAudit'
    | 'generateAssignmentDraft'
    | 'ensureAchievementScope'
    | 'ensureAchievementAuditorThread'
    | 'generateAchievementAudit'
    | 'submitAchievementAuditFeedback'
    | 'returnAchievementAuditToOffer'
    | 'submitAssignmentAuditFeedback'
  >
  /** Storage engine — needed for config and the memory/spec/assignment engines. */
  storage?: StorageEngine
  projectManager?: ProjectManager
  /**
   * Device credential service used to enforce per-device scopes and local
   * step-up approval for remote invocations. Optional so the desktop-reuse
   * dispatcher and isolated tests can construct it without device state.
   */
  credentials?: DeviceCredentialService
  threadCreation?: ThreadCreationCoordinator
  threadDeletion?: ThreadDeletionCoordinator
}

/** A remote RPC invoke request that reached the main process. */
export interface RemoteInvoke {
  id: number
  channel: string
  args: unknown[]
  /** The authenticated device this invocation belongs to, when known. */
  device?: RemoteRpcDeviceContext
}

export type RemoteRpcResult = { ok: true; result: unknown } | { ok: false; message: string }

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
  private readonly remoteUploads = new Map<string, RemoteAttachmentUpload>()

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
    // without an authenticated device — the cloud relay cannot bypass device
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
      const authorized = await this.authorizeDevice(invoke)
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
      // `undefined` — an omitted optional argument (e.g. `presentation`,
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
        resourceId: this.resourceForChannel(invoke.channel, invoke.args),
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
        resourceId: this.resourceForChannel(invoke.channel, invoke.args),
        requiredScope: authMeta?.scope ?? null,
        stepUpApprovalId,
        authVersion: invoke.device?.authVersion ?? null
      })
      return { ok: false, message }
    }
  }

  /**
   * Enforce the device-scope + step-up contract for a remote invocation.
   * Deny-by-default: the channel must have a registry entry, the device must
   * hold the required scope, and high-risk channels require a single-use local
   * approval bound to this exact request.
   */
  private async authorizeDevice(
    invoke: RemoteInvoke
  ): Promise<
    | { allowed: true; stepUpApprovalId?: string | null }
    | { allowed: false; denied: RemoteRpcDenied | RemoteRpcStepUpRequired }
  > {
    const device = invoke.device as RemoteRpcDeviceContext
    const resource = this.resourceForChannel(invoke.channel, invoke.args)
    const auth = authorizationForChannel(invoke.channel)
    if (!auth) {
      this.credentials?.audit({
        decision: 'rpc_denied',
        reasonCode: 'denied_by_default',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.fingerprint.slice(0, 8),
        transport: device.transport,
        sessionId: device.sessionId,
        requestId: device.requestId,
        channel: invoke.channel,
        resourceId: resource,
        authVersion: device.authVersion
      })
      return {
        allowed: false,
        denied: { code: 'authorization_denied', scope: null, reason: 'channel not authorized' }
      }
    }
    // Per-invoke revalidation: revocation, expiry, idle expiry, and key/scope
    // rotation take effect immediately — a bound session is never trusted
    // statelessly even after the handshake succeeded.
    if (this.credentials && !this.credentials.isDeviceActive(device.deviceId, device.authVersion)) {
      this.credentials.audit({
        decision: 'rpc_denied',
        reasonCode:
          device.authVersion !==
          (this.credentials.getDevice(device.deviceId)?.authVersion ?? device.authVersion)
            ? 'superseded_auth_version'
            : 'revoked',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.fingerprint.slice(0, 8),
        transport: device.transport,
        sessionId: device.sessionId,
        requestId: device.requestId,
        channel: invoke.channel,
        resourceId: resource,
        requiredScope: auth.scope,
        authVersion: device.authVersion
      })
      return {
        allowed: false,
        denied: {
          code: 'authorization_denied',
          scope: auth.scope,
          reason: 'device no longer active'
        }
      }
    }
    // Argument-level project bounds (contract 5.1): a scope never implies
    // workstation-wide access. Devices with a restricted project grant cannot
    // reach projects outside that set.
    if (!device.allProjects) {
      const projectId = typeof invoke.args[0] === 'string' ? invoke.args[0] : null
      if (projectId && !device.projectIds.includes(projectId)) {
        this.credentials?.audit({
          decision: 'rpc_denied',
          reasonCode: 'denied_by_default',
          deviceId: device.deviceId,
          deviceName: device.name,
          fingerprintPrefix: device.fingerprint.slice(0, 8),
          transport: device.transport,
          sessionId: device.sessionId,
          requestId: device.requestId,
          channel: invoke.channel,
          resourceId: resource,
          requiredScope: auth.scope,
          authVersion: device.authVersion
        })
        return {
          allowed: false,
          denied: { code: 'authorization_denied', scope: auth.scope, reason: 'project not granted' }
        }
      }
    }
    if (!device.scopes.includes(auth.scope)) {
      this.credentials?.audit({
        decision: 'rpc_denied',
        reasonCode: 'no_scope',
        deviceId: device.deviceId,
        deviceName: device.name,
        fingerprintPrefix: device.fingerprint.slice(0, 8),
        transport: device.transport,
        sessionId: device.sessionId,
        requestId: device.requestId,
        channel: invoke.channel,
        resourceId: resource,
        requiredScope: auth.scope,
        authVersion: device.authVersion
      })
      return {
        allowed: false,
        denied: {
          code: 'authorization_denied',
          scope: auth.scope,
          reason: `device lacks scope ${auth.scope}`
        }
      }
    }

    const needsStepUp =
      auth.stepUp === 'always' || (auth.stepUp === 'conditional' && auth.requiresStepUp === true)
    if (!needsStepUp || !this.credentials) {
      return { allowed: true, stepUpApprovalId: null }
    }

    const argsDigest = await sha256Hex(JSON.stringify(invoke.args))
    const approvedId = this.credentials.hasApprovalFor({
      deviceId: device.deviceId,
      authVersion: device.authVersion,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      resource,
      argsDigest
    })
    if (approvedId !== null) {
      return { allowed: true, stepUpApprovalId: approvedId }
    }

    const created = this.credentials.createStepUpApproval({
      deviceId: device.deviceId,
      authVersion: device.authVersion,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      action: invoke.channel,
      resource,
      argsDigest
    })
    if (created.ok && created.approval) {
      return {
        allowed: false,
        denied: {
          code: 'step_up_required',
          approvalId: created.approval.approvalId,
          expiresAt: created.approval.expiresAt,
          action: created.approval.action,
          resource: created.approval.resource
        }
      }
    }
    this.credentials.audit({
      decision: 'rpc_denied',
      reasonCode: 'denied_by_default',
      deviceId: device.deviceId,
      deviceName: device.name,
      fingerprintPrefix: device.fingerprint.slice(0, 8),
      transport: device.transport,
      sessionId: device.sessionId,
      requestId: device.requestId,
      channel: invoke.channel,
      resourceId: resource,
      requiredScope: auth.scope,
      authVersion: device.authVersion
    })
    return {
      allowed: false,
      denied: {
        code: 'authorization_denied',
        scope: auth.scope,
        reason: 'step-up capacity exceeded'
      }
    }
  }

  /** Coarse affected-resource label for step-up binding and audit records. */
  private resourceForChannel(channel: string, args: unknown[]): string | null {
    const projectId = typeof args[0] === 'string' ? args[0] : null
    const threadId = typeof args[1] === 'string' ? args[1] : null
    if (channel.startsWith('project') || channel === 'git:init') {
      return projectId
    }
    if (projectId && threadId) return `${projectId}/${threadId}`
    if (projectId) return projectId
    return null
  }

  /** Local desktop approval for a pending step-up request (trusted IPC only). */
  approveStepUp(approvalId: string, decision: 'approved' | 'rejected'): boolean {
    if (!this.credentials) return false
    const pending = this.credentials
      .listPendingApprovals()
      .find((approval) => approval.approvalId === approvalId)
    if (!pending) return false
    return this.credentials.resolveStepUpApproval({
      approvalId,
      deviceId: pending.deviceId,
      authVersion: pending.authVersion,
      sessionId: pending.sessionId,
      requestId: pending.requestId,
      channel: pending.channel,
      resource: pending.resource,
      argsDigest: pending.argsDigest,
      decision
    })
  }

  listPendingApprovals(): ReturnType<DeviceCredentialService['listPendingApprovals']> {
    return this.credentials?.listPendingApprovals() ?? []
  }

  listAuditEvents(limit = 100): ReturnType<DeviceCredentialService['listAudit']> {
    return this.credentials?.listAudit(limit) ?? []
  }

  private async call(
    channel: string,
    args: unknown[],
    device?: RemoteRpcDeviceContext
  ): Promise<unknown> {
    const { chatEngine } = this.services
    switch (channel) {
      // ─── Projects ────────────────────────────────────────────────────────
      case 'project:list':
        return this.projectManager.listProjects()
      case 'project:get':
        return this.projectManager.getProject(this.string(args[0]))
      case 'project:getIcon':
        return this.projectManager.getIconDataUrl(this.string(args[0]))
      case 'project:ensureInbox':
        return this.projectManager.ensureInboxProject()

      // ─── Threads ─────────────────────────────────────────────────────────
      case 'thread:listAll':
        return this.threadManager.listAllThreads()
      case 'thread:list':
        return this.threadManager.listThreads(this.string(args[0]))
      case 'thread:get':
        // Reads never wait for optimistic thread finalization; the remote
        // renderer already holds the thread object from `thread:create`.
        return this.threadManager.getThread(this.string(args[0]), this.string(args[1]))
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
        return this.threadManager.markRead(this.string(args[0]), this.string(args[1]))
      case 'thread:setPinned':
        return this.threadManager.setPinned(
          this.string(args[0]),
          this.string(args[1]),
          Boolean(args[2])
        )
      case 'thread:setStatus':
        return this.threadManager.setStatus(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]) as Thread['status'],
          args[3] as { read?: boolean } | undefined
        )
      case 'thread:updateSettings':
        return this.threadManager.updateSettings(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'thread:setContextUsage':
        await this.threadManager.setContextUsage(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadContextUsage
        )
        return undefined
      case 'thread:harnessUsage':
        return this.threadManager.harnessUsageFor(this.string(args[0]), this.string(args[1]))
      case 'thread:efficiencyKpis':
        return this.threadManager.efficiencyKpisFor(this.string(args[0]), this.string(args[1]))
      case 'thread:loadMessages': {
        const before = args[2] as { createdAt?: number; id?: string } | undefined
        return this.threadManager.loadMessagePage(
          this.string(args[0]),
          this.string(args[1]),
          before && typeof before === 'object'
            ? {
                createdAt: before.createdAt ?? 0,
                id: before.id ?? ''
              }
            : undefined,
          typeof args[3] === 'number' ? args[3] : 40
        )
      }
      case 'thread:loadStreamParts':
        return this.services.chatEngine.loadTurnStreamParts(
          this.string(args[0]),
          this.string(args[1])
        )
      case 'thread:update':
        return this.threadManager.updateThread(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as Record<string, unknown>
        )
      case 'thread:delete':
        {
          const projectId = this.string(args[0])
          const threadId = this.string(args[1])
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
        await chatEngine.loadMessages(this.string(args[0]), this.string(args[1]))
        return this.threadManager.forkThread(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          typeof args[3] === 'string' ? args[3] : undefined,
          typeof args[4] === 'string' ? args[4] : undefined,
          typeof args[5] === 'string' ? args[5] : undefined
        )
      }
      case 'thread:reorderScope':
        return this.threadManager.reorderScopeThreads(
          this.string(args[0]),
          this.string(args[1]),
          validateScopeSlice(args[2]),
          this.stringArray(args[3], 'Ordered scope thread IDs')
        )
      case 'threads:search':
        return this.threadManager.searchThreads(
          this.string(args[0]),
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
        return this.beginRemoteUpload(
          device,
          args[0] as AttachmentStorageScope,
          this.string(args[1]),
          args[2]
        )
      case 'attachment:appendRemoteUpload':
        return this.appendRemoteUpload(device, this.string(args[0]), args[1], this.string(args[2]))
      case 'attachment:finishRemoteUpload':
        return this.finishRemoteUpload(device, this.string(args[0]))
      case 'attachment:cancelRemoteUpload':
        return this.cancelRemoteUpload(device, this.string(args[0]))
      case 'attachment:readRemoteChunk':
        return this.readRemoteAttachmentChunk(this.string(args[0]), args[1])
      case 'remotePush:getPublicKey':
        return remoteWebPush.publicKey()
      case 'remotePush:subscribe':
        return remoteWebPush.subscribe(
          this.requiredDeviceId(device),
          args[0] as RemotePushSubscription
        )
      case 'remotePush:unsubscribe':
        return remoteWebPush.unsubscribe(this.string(args[0]))

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
        const role = this.string(args[0]) as 'seniorEngineer' | 'worker' | 'auditor'
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
        return this.scopeManager.getBoard(this.string(args[0]))
      case 'scope:updateLayout':
        return this.scopeManager.updateLayout(this.string(args[0]), validateScopeOrderIds(args[1]))
      case 'scope:updateAppearance':
        return this.scopeManager.updateAppearance(
          this.string(args[0]),
          this.string(args[1]),
          validateScopeAppearancePatch(args[2])
        )
      case 'scope:updateCollapse':
        return this.scopeManager.updateCollapse(
          this.string(args[0]),
          this.string(args[1]),
          validateScopeCollapsePatch(args[2])
        )
      case 'scope:create':
        return this.scopeManager.createBucket(
          this.string(args[0]),
          validateScopeCreateInput(args[1])
        )
      case 'scope:setArchive':
        return this.scopeManager.setArchive(
          this.string(args[0]),
          this.string(args[1]),
          this.boolean(args[2])
        )
      case 'scope:delete':
        return this.scopeManager.deleteBucket(this.string(args[0]), this.string(args[1]))
      case 'scope:setWorktreeDefaults':
        return this.scopeManager.setWorktreeDefaults(
          this.string(args[0]),
          validateWorktreeDefaults(args[1])
        )
      case 'scope:worktree:health':
        return this.scopeWorktreeService.health(validateScopeTarget(args[0]))
      case 'scope:worktree:sourceInfo':
        return this.scopeWorktreeService.sourceInfo(this.string(args[0]))
      case 'scope:worktree:detectAdopt':
        return this.scopeWorktreeService.detectAdoptable(
          this.string(args[0]),
          validateSourcePath(args[1])
        )

      // ─── Agent chat surface ─────────────────────────────────────────────
      case 'agent:loadMessages':
        return chatEngine.loadMessages(this.string(args[0]), this.string(args[1]))
      case 'agent:listProviderSnapshot':
        return chatEngine.listProviderSnapshot(this.string(args[0]))
      case 'agent:refreshProviderCatalog':
        return chatEngine.listProviders(this.string(args[0]), args[1] !== false)
      case 'agent:refreshAccountUsage':
        return chatEngine.refreshAccountUsage(this.string(args[0]), this.string(args[1]))
      case 'agent:getHarnessAuthStatus':
        return chatEngine.getHarnessAuthStatus(this.string(args[0]), this.string(args[1]))
      case 'agent:getSessionStatus':
        return chatEngine.getSessionStatus(this.string(args[0]), this.string(args[1]))
      case 'agent:ensureSession':
        return chatEngine.ensureSession(
          this.string(args[0]),
          this.string(args[1]),
          this.optionalString(args[2])
        )
      case 'agent:sendPrompt':
        return chatEngine.sendPrompt(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings,
          this.string(args[3]),
          (args[4] ?? []) as PromptAttachment[],
          args[5] as SpecActionIntent | undefined,
          this.optionalString(args[6]),
          this.optionalString(args[7]),
          args[8] as PromptReference[] | undefined,
          args[9] as PromptProjectReference[] | undefined,
          'user',
          args[10] as UserMessagePresentation | undefined,
          args[11] as PromptAssignmentTaskReference[] | undefined
        )
      case 'agent:steerPrompt':
        return chatEngine.steerPrompt(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          (args[3] ?? []) as PromptAttachment[],
          this.string(args[4]),
          this.optionalString(args[5]),
          args[6] as PromptReference[] | undefined,
          args[7] as PromptProjectReference[] | undefined,
          args[8] as UserMessagePresentation | undefined,
          args[9] as PromptAssignmentTaskReference[] | undefined
        )
      case 'agent:discardSteer':
        return chatEngine.discardSteer(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:abort':
        return chatEngine.abort(this.string(args[0]), this.string(args[1]))
      case 'agent:listPermissions':
        return chatEngine.listPermissions(this.string(args[0]), this.string(args[1]))
      case 'agent:replyPermission':
        return chatEngine.replyPermission(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as 'once' | 'always' | 'reject',
          typeof args[3] === 'string' ? args[3] : undefined
        )
      case 'agent:listImageDescriptorErrors':
        return chatEngine.listImageDescriptorErrors(this.string(args[0]), this.string(args[1]))
      case 'agent:replyImageDescriptor':
        return chatEngine.replyImageDescriptor(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as 'retry' | 'ignore',
          args[4] as import('../../lib/types').AgentModelSelection | undefined
        )
      case 'agent:listQuestions':
        return chatEngine.listQuestions(this.string(args[0]), this.string(args[1]))
      case 'agent:answerQuestion':
        return chatEngine.answerQuestion(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as string[][]
        )
      case 'agent:dismissQuestion':
        return chatEngine.dismissQuestion(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:updateQuestion':
        return chatEngine.updateQuestion(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as string[],
          typeof args[5] === 'number' ? args[5] : undefined
        )
      case 'agent:listCommands':
        return chatEngine.listCommands(this.string(args[0]), this.string(args[1]))
      case 'agent:runCommand':
        return chatEngine.runCommand(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.string(args[3])
        )
      case 'agent:compact':
        return chatEngine.compactSession(this.string(args[0]), this.string(args[1]))
      case 'agent:truncateMessages':
        return chatEngine.truncateMessages(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:deleteMessages':
        return chatEngine.deleteMessages(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.string(args[3]) as 'down' | 'single' | 'up'
        )
      case 'agent:listContextCapabilities':
        return chatEngine.listContextCapabilities(this.string(args[0]), this.string(args[1]))
      case 'agent:listProcesses':
        return chatEngine.listProcesses(this.string(args[0]), this.string(args[1]))
      case 'agent:listArtifacts':
        return chatEngine.listArtifacts(this.string(args[0]), this.string(args[1]))
      case 'agent:killProcess':
        return chatEngine.killProcess(this.string(args[0]), this.string(args[1]), args[2] as number)
      case 'agent:killThreadProcesses':
        return chatEngine.killThreadProcesses(this.string(args[0]), this.string(args[1]))
      case 'capabilities:deleteSkill':
        return chatEngine.deleteSkill(args[0] as AgentCapabilitySource)
      case 'capabilities:deleteMcp':
        return chatEngine.deleteMcp(args[0] as AgentCapabilitySource)
      case 'agent:sendTemporaryPrompt':
        return chatEngine.sendTemporaryPrompt(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as ThreadSettings,
          this.string(args[4]),
          (args[5] ?? []) as PromptAttachment[],
          (args[6] ?? []) as PromptReference[],
          this.optionalString(args[7]),
          this.optionalString(args[8]),
          this.optionalString(args[9])
        )
      case 'agent:steerTemporaryPrompt':
        return chatEngine.steerTemporaryPrompt(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as ThreadSettings,
          this.string(args[4]),
          (args[5] ?? []) as PromptAttachment[],
          (args[6] ?? []) as PromptReference[],
          this.optionalString(args[7]),
          this.optionalString(args[8])
        )
      case 'agent:loadTemporaryChatMessages':
        return chatEngine.loadTemporaryConversation(this.string(args[0]))
      case 'agent:getTemporaryChatStatus':
        return chatEngine.getTemporaryChatStatus(this.string(args[0]))
      case 'agent:abortTemporaryChat':
        return chatEngine.abortTemporaryChat(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:touchTemporaryChat':
        return chatEngine.touchTemporaryChat(this.string(args[0]))
      case 'agent:closeTemporaryChat':
        return chatEngine.closeTemporaryChat(this.string(args[0]))
      case 'agent:loadSessionMessages':
        return chatEngine.loadSessionMessages(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:getChildSessionStatus':
        return chatEngine.getChildSessionStatus(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:dismissSessionError':
        return chatEngine.dismissSessionError(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:retryChildSession':
        return chatEngine.retryChildSession(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'agent:abortChildSession':
        return chatEngine.abortChildSession(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )

      // ─── Engineering workflow ───────────────────────────────────────────
      case 'agent:chooseBrainstormEntry':
        return chatEngine.chooseBrainstormEntry(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as BrainstormEntryChoice
        )
      case 'agent:reviewBrainstorm':
        return chatEngine.reviewBrainstorm(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          typeof args[4] === 'string' ? args[4] : ''
        )
      case 'agent:finalizeBrainstorm':
        return chatEngine.finalizeBrainstorm(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          typeof args[4] === 'string' ? args[4] : ''
        )
      case 'agent:generatePrd':
        return chatEngine.generatePrd(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings,
          this.string(args[3]),
          args[4] as PromptAttachment[],
          this.string(args[5])
        )
      case 'agent:ensureInitialSpec':
        return chatEngine.ensureInitialSpec(this.string(args[0]), this.string(args[1]))
      case 'prototypePreview:readChunk':
        return chatEngine.readPrototypePreviewChunk(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number
        )
      case 'agent:ensureImplementationAuditorThread':
        return chatEngine.ensureImplementationAuditorThread(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:startAssignment':
        return chatEngine.startAssignment(
          this.string(args[0]),
          this.string(args[1]),
          (args[2] as 'user' | 'internal') ?? 'user'
        )
      case 'agent:stopAssignment':
        return chatEngine.stopAssignment(this.string(args[0]), this.string(args[1]))
      case 'agent:resumeAssignment':
        return chatEngine.resumeAssignment(this.string(args[0]), this.string(args[1]))
      case 'agent:generateAudit':
        return chatEngine.generateAudit(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as AuditGenerationRequest
        )
      case 'agent:ensureAssignmentAuditorThread':
        return chatEngine.ensureAssignmentAuditorThread(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:generateAssignmentAudit':
        return chatEngine.generateAssignmentAudit(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:generateAssignmentDraft':
        return chatEngine.generateAssignmentDraft(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:ensureAchievementScope':
        return chatEngine.ensureAchievementScope(this.string(args[0]), this.string(args[1]))
      case 'agent:ensureAchievementAuditorThread':
        return chatEngine.ensureAchievementAuditorThread(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:generateAchievementAudit':
        return chatEngine.generateAchievementAudit(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'agent:submitAchievementAuditFeedback':
        return chatEngine.submitAchievementAuditFeedback(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )
      case 'agent:returnAchievementAuditToOffer':
        return chatEngine.returnAchievementAuditToOffer(this.string(args[0]), this.string(args[1]))
      case 'agent:submitAssignmentAuditFeedback':
        return chatEngine.submitAssignmentAuditFeedback(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )

      // ─── Spec studio ────────────────────────────────────────────────────
      case 'spec:getActive': {
        const projectId = this.string(args[0])
        const threadId = this.string(args[1])
        const workflow = await this.specEngine.getWorkflowState(projectId, threadId)
        if (!workflow?.activeSpecId || !workflow.activeSpecVersion) return null
        return this.specEngine.getVersion(
          projectId,
          threadId,
          workflow.activeSpecId,
          workflow.activeSpecVersion
        )
      }
      case 'spec:listVersions':
        return this.specEngine.listVersions(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'spec:saveDraft':
        return this.specEngine.saveDraft(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as EngineeringSpecContent
        )
      case 'spec:createVersion': {
        const projectId = this.string(args[0])
        const threadId = this.string(args[1])
        const specId = this.string(args[2])
        const content = args[3] as EngineeringSpecContent
        const provenance = (args[4] ?? {}) as NewSpecProvenance
        const latest = await this.specEngine.getLatest(projectId, threadId, specId)
        const memory = await this.memoryService.snapshotCurrent(projectId, threadId)
        return this.specEngine.createVersion({
          projectId,
          threadId,
          specId,
          content,
          provenance,
          context: [
            ...(latest?.context.filter((reference) => reference.type !== 'memory') ?? []),
            ...memory
          ]
        })
      }
      case 'spec:dismissValidationIssue':
        return this.specEngine.dismissValidationIssue(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as SpecValidationIssue
        )
      case 'spec:setReview':
        return this.specEngine.setReview(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number
        )
      case 'spec:approve':
        return this.specEngine.approve(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number
        )
      case 'spec:validate':
        return validateEngineeringSpec(args[0] as Parameters<typeof validateEngineeringSpec>[0])
      case 'spec:addAnnotation':
        return this.specEngine.addAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as AddSpecAnnotationInput
        )
      case 'spec:addDecisionComment':
        return this.specEngine.addDecisionComment(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as 'review' | 'implement',
          this.string(args[5])
        )
      case 'spec:resolveAnnotation':
        return this.specEngine.resolveAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )
      case 'spec:updateAnnotation':
        return this.specEngine.updateAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4]),
          this.string(args[5])
        )
      case 'spec:setContext':
        return this.specEngine.setContext(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as SpecContextReference[]
        )
      case 'spec:getContextAttachments': {
        const projectId = this.string(args[0])
        const current = await this.specEngine.getVersion(
          projectId,
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number
        )
        if (!current) throw new Error('Specification version not found')
        return this.specContextService.promptAttachments(projectId, current.context)
      }

      // ─── Assignment studio ──────────────────────────────────────────────
      case 'assignment:getActive':
        return this.assignmentEngine.getActive(this.string(args[0]), this.string(args[1]))
      case 'assignment:listVersions':
        return this.assignmentEngine.listVersions(this.string(args[2]))
      case 'assignment:saveDraft':
        return this.assignmentEngine.saveDraft(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as AssignmentPlanContent,
          args[3] as Parameters<typeof this.assignmentEngine.saveDraft>[3]
        )
      case 'assignment:addAnnotation':
        return this.assignmentEngine.addAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as AddAssignmentAnnotationInput
        )
      case 'assignment:updateAnnotation':
        return this.assignmentEngine.updateAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4]),
          this.string(args[5])
        )
      case 'assignment:resolveAnnotation':
        return this.assignmentEngine.resolveAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )
      case 'assignment:updateUnlinkedWorkerModel':
        return this.assignmentEngine.updateUnlinkedWorkerModel(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as AssignmentModelSelection
        )

      // ─── Audit studio ───────────────────────────────────────────────────
      case 'audit:getActive':
        return this.auditEngine.getActive(this.string(args[0]), this.string(args[1]))
      case 'audit:listVersions':
        return this.auditEngine.listVersions(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'audit:save':
        return this.auditEngine.save(args[0] as Parameters<typeof this.auditEngine.save>[0])
      case 'audit:addAnnotation':
        return this.auditEngine.addAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as AddAuditAnnotationInput
        )
      case 'audit:updateAnnotation':
        return this.auditEngine.updateAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4]),
          this.string(args[5])
        )
      case 'audit:resolveAnnotation':
        return this.auditEngine.resolveAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )
      case 'audit:complete': {
        const projectId = this.string(args[0])
        const threadId = this.string(args[1])
        const assignment = this.assignmentEngine.getActive(projectId, threadId)
        if (
          assignment?.status === 'completed' &&
          assignment.auditCycle &&
          ['report_ready', 'available'].includes(assignment.auditCycle.status)
        ) {
          await this.assignmentEngine.completeAuditCycle(projectId, threadId)
          await this.threadManager.setStatus(projectId, threadId, 'completed')
          return this.threadManager.setAuditState(projectId, threadId, undefined)
        }
        return this.threadManager.setAuditState(projectId, threadId, undefined)
      }
      case 'audit:returnToOffer': {
        const projectId = this.string(args[0])
        const threadId = this.string(args[1])
        const assignment = await this.assignmentEngine.makeAuditAvailable(projectId, threadId)
        await this.threadManager.setStatus(projectId, threadId, 'spec')
        return assignment
      }

      // ─── Brainstorm studio ──────────────────────────────────────────────
      case 'engineeringLifecycle:get':
        return this.engineeringLifecycleEngine.get(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID')
        )
      case 'engineeringLifecycle:select':
        return this.engineeringLifecycleEngine.select(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID'),
          validateEngineeringLifecycleSelectionInput(args[2])
        )
      case 'engineeringLifecycle:start':
        return this.engineeringLifecycleEngine.start(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID'),
          args[2] === undefined || args[2] === null
            ? undefined
            : validateEngineeringLifecycleStage(args[2])
        )
      case 'engineeringLifecycle:complete':
        return this.engineeringLifecycleEngine.completeStage(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID'),
          validateEngineeringLifecycleStage(args[2])
        )
      case 'engineeringLifecycle:resume':
        return this.engineeringLifecycleEngine.resume(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID'),
          validateEngineeringLifecycleResumeToken(args[2]),
          validateEngineeringLifecycleDecision(args[3])
        )
      case 'engineeringLifecycle:retry':
        return this.engineeringLifecycleEngine.retry(
          validateEntityId(args[0], 'Project ID'),
          validateEntityId(args[1], 'Thread ID'),
          validateEngineeringLifecycleResumeToken(args[2])
        )
      case 'engineeringLifecycle:cancel':
        if (args[2] !== true) {
          throw new TypeError('Engineering lifecycle cancellation requires confirmation')
        }
        {
          const pid = validateEntityId(args[0], 'Project ID')
          const tid = validateEntityId(args[1], 'Thread ID')
          const before = this.engineeringLifecycleEngine.get(pid, tid)
          const result = this.engineeringLifecycleEngine.cancel(pid, tid)
          // Match the desktop handler: a user-initiated stop must halt the
          // in-flight generation turn so the thread cannot be re-surfaced on
          // view switch or resumed by restart recovery.
          if (
            before &&
            (before.activeStage !== undefined ||
              before.humanGate !== undefined ||
              before.selection !== 'none')
          ) {
            await chatEngine.abort(pid, tid)
          }
          return result
        }
      case 'prd:ensureWorkflow':
        return this.prdEngine.ensureWorkflow(this.string(args[0]), this.string(args[1]))
      case 'prd:getWorkflow':
        return this.prdEngine.getWorkflowState(this.string(args[0]), this.string(args[1]))
      case 'prd:chooseEntry': {
        const choice = args[2]
        if (choice !== 'brainstorm_first' && choice !== 'start_prd') {
          throw new TypeError('Invalid PRD entry choice')
        }
        return this.prdEngine.chooseEntry(this.string(args[0]), this.string(args[1]), choice)
      }
      case 'prd:beginDrafting':
        return this.prdEngine.beginDrafting(this.string(args[0]), this.string(args[1]))
      case 'prd:getActive':
        return this.prdEngine.getActive(this.string(args[0]), this.string(args[1]))
      case 'prd:listVersions':
        return this.prdEngine.listVersions(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'prd:createDraft':
        return this.prdEngine.createDraft(
          this.string(args[0]),
          this.string(args[1]),
          parseGeneratedPrdContent(args[2]),
          args[3] as NewPrdProvenance
        )
      case 'prd:saveDraft':
        return this.prdEngine.saveDraft(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          parseGeneratedPrdContent(args[4])
        )
      case 'prd:createVersion':
        return this.prdEngine.createVersion(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          parseGeneratedPrdContent(args[3]),
          args[4] as NewPrdProvenance
        )
      case 'prd:addAnnotation':
        return this.prdEngine.addAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as AddPrdAnnotationInput
        )
      case 'prd:updateAnnotation':
        return this.prdEngine.updateAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4]),
          this.string(args[5])
        )
      case 'prd:resolveAnnotation':
        return this.prdEngine.resolveAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )
      case 'prd:finalize':
        return this.prdEngine.finalize(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number
        )
      case 'prd:openInEditor':
      case 'prd:revealInFiles':
        return ''
      case 'prototypePreview:getOrigin':
        return (
          resolvePrototypePreviewOrigin(process.env, {
            development: false,
            bakedOrigin: __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__
          }).origin ?? null
        )
      case 'brainstorm:getActive':
        return this.brainstormEngine.getActive(this.string(args[0]), this.string(args[1]))
      case 'brainstorm:getWorkflow':
        return this.brainstormEngine.getWorkflowState(this.string(args[0]), this.string(args[1]))
      case 'brainstorm:resetWorkflow':
        return this.brainstormEngine.resetWorkflow(this.string(args[0]), this.string(args[1]))
      case 'brainstorm:listVersions':
        return this.brainstormEngine.listVersions(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'brainstorm:saveDraft':
        return this.brainstormEngine.saveDraft(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as BrainstormContent
        )
      case 'brainstorm:addAnnotation':
        return this.brainstormEngine.addAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          args[4] as AddBrainstormAnnotationInput
        )
      case 'brainstorm:updateAnnotation':
        return this.brainstormEngine.updateAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4]),
          this.string(args[5])
        )
      case 'brainstorm:resolveAnnotation':
        return this.brainstormEngine.resolveAnnotation(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as number,
          this.string(args[4])
        )

      // ─── Checkpoints ────────────────────────────────────────────────────
      case 'checkpoint:list':
        return this.checkpointManager.listSummaries(this.string(args[0]), this.string(args[1]))
      case 'checkpoint:activeSummary':
        return this.services.chatEngine.activeTurnChangeSummary(
          this.string(args[0]),
          this.string(args[1])
        )
      case 'checkpoint:liveDiff':
        return this.checkpointManager.getLiveFileDiff(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.string(args[3])
        )
      case 'checkpoint:diff':
        return this.checkpointManager.getFileDiff(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.string(args[3])
        )
      case 'checkpoint:rollbackPaths':
        await this.checkpointManager.rollbackPaths(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.stringArray(args[3], 'Checkpoint paths')
        )
        return this.checkpointManager.listSummaries(this.string(args[0]), this.string(args[1]))
      case 'checkpoint:redoPaths':
        await this.checkpointManager.redoPaths(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          this.stringArray(args[3], 'Checkpoint paths')
        )
        return this.checkpointManager.listSummaries(this.string(args[0]), this.string(args[1]))

      // ─── Memory ─────────────────────────────────────────────────────────
      case 'memory:getPendingProposals':
        return this.memoryService.getPendingProposals(
          typeof args[0] === 'string' ? args[0] : undefined
        )
      case 'memory:approveProposal':
        return this.memoryService.approveProposal(
          this.string(args[0]),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'memory:rejectProposal':
        return this.memoryService.rejectProposal(
          this.string(args[0]),
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
          this.string(args[0]),
          typeof args[1] === 'string' ? args[1] : '',
          (args[2] as 'all' | 'rules') ?? 'all'
        )
      case 'projectFiles:resolveCitationPaths':
        return this.projectFilesService.resolveCitationPaths(
          this.string(args[0]),
          (args[1] ?? []) as string[]
        )
      case 'projectFiles:resolveExternalCitationPaths':
        return this.projectFilesService.resolveExternalCitationPaths((args[0] ?? []) as string[])

      // ─── Repo metadata ──────────────────────────────────────────────────
      case 'repository:remoteOrigin':
        return this.repositoryService.getRemoteOrigin(this.string(args[0]))
      case 'repository:preflight':
        return this.repositoryService.preflight(this.string(args[0]))

      // ─── Git management ─────────────────────────────────────────────────
      // The phone drives the same read/write git surface the desktop sidebar
      // uses. A paired phone already commands an agent with full repository
      // access over this bridge, so git mutations do not widen trust. Only the
      // credential store stays desktop-owned: the PAT lives in the main-process
      // vault and never crosses the bridge (it is resolved here for push), and
      // GitHub device-flow sign-in + pull-request creation are desktop-only.
      case 'git:status':
        return this.gitService.getStatus(
          await this.resolveProjectPath(
            this.string(args[0]),
            args[1] === undefined ? undefined : this.string(args[1])
          )
        )
      case 'git:diff':
        return this.gitService.getDiff(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          Boolean(args[2])
        )
      case 'git:analyzeConflict':
        return this.gitService.analyzeConflict(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:prepareConflictWorkFile':
        return this.gitService.prepareConflictWorkFile(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:saveConflictDraft':
        return this.gitService.saveConflictDraft(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2]),
          this.string(args[3])
        )
      case 'git:saveConflictResolution':
        return this.gitService.saveConflictResolution(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'git:stage':
        return this.gitService.stage(
          await this.resolveProjectPath(this.string(args[0])),
          this.stringArray(args[1], 'Git paths')
        )
      case 'git:resolveConflicted':
        return this.gitService.resolveConflicted(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:unstage':
        return this.gitService.unstage(
          await this.resolveProjectPath(this.string(args[0])),
          this.stringArray(args[1], 'Git paths')
        )
      case 'git:commit':
        return this.gitService.commit(
          await this.resolveProjectPath(
            this.string(args[0]),
            args[2] === undefined ? undefined : this.string(args[2])
          ),
          this.string(args[1])
        )
      case 'git:amend':
        return this.gitService.amend(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:init':
        return this.gitService.initialize(await this.resolveProjectPath(this.string(args[0])))
      case 'git:branches':
        return this.gitService.listBranches(
          await this.resolveProjectPath(
            this.string(args[0]),
            args[1] === undefined ? undefined : this.string(args[1])
          )
        )
      case 'git:checkout':
        return this.syncBranchAfterCheckout(
          this.string(args[0]),
          await this.gitService.checkout(
            await this.resolveProjectPath(this.string(args[0])),
            this.string(args[1])
          )
        )
      case 'git:createBranch':
        return this.syncBranchAfterCheckout(
          this.string(args[0]),
          await this.gitService.createBranch(
            await this.resolveProjectPath(this.string(args[0])),
            this.string(args[1])
          )
        )
      case 'git:createTrackingBranch':
        return this.syncBranchAfterCheckout(
          this.string(args[0]),
          await this.gitService.createTrackingBranch(
            await this.resolveProjectPath(this.string(args[0])),
            this.string(args[1]),
            this.string(args[2]),
            this.string(args[3])
          )
        )
      case 'git:deleteBranch':
        return this.gitService.deleteBranch(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.optionalBoolean(args[2]) ?? false
        )
      case 'git:log':
        return this.gitService.log(
          await this.resolveProjectPath(this.string(args[0])),
          typeof args[1] === 'number' ? args[1] : undefined,
          typeof args[2] === 'number' ? args[2] : undefined,
          typeof args[3] === 'string' ? this.string(args[3]) : undefined
        )
      case 'git:commitDiff':
        return this.gitService.commitDiff(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:commitFileDiff':
        return this.gitService.commitFileDiff(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'git:stashDiff':
        return this.gitService.stashDiff(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:stashFileDiff':
        return this.gitService.stashFileDiff(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'git:reset':
        return this.syncBranchAfterCheckout(
          this.string(args[0]),
          await this.gitService.reset(
            await this.resolveProjectPath(this.string(args[0])),
            this.string(args[1]) as GitResetMode,
            typeof args[2] === 'string' ? args[2] : undefined
          )
        )
      case 'git:getIdentity':
        return this.gitService.getIdentity(await this.resolveProjectPath(this.string(args[0])))
      case 'git:setIdentity': {
        const projectId = this.string(args[0])
        const identity = args[1] as { name?: string; email?: string } | undefined
        return this.gitService.setIdentity(
          await this.resolveProjectPath(projectId),
          this.string(identity?.name),
          this.string(identity?.email)
        )
      }
      case 'git:remotes':
        return this.gitService.listRemotes(
          await this.resolveProjectPath(
            this.string(args[0]),
            args[1] === undefined ? undefined : this.string(args[1])
          )
        )
      case 'git:addRemote':
        return this.gitService.addRemote(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'git:removeRemote':
        return this.gitService.removeRemote(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:fetch':
        return this.gitService.fetch(await this.resolveProjectPath(this.string(args[0])))
      case 'git:fetchBranch':
        return this.gitService.fetchBranch(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1]),
          this.string(args[2])
        )
      case 'git:pull':
        return this.gitService.pull(await this.resolveProjectPath(this.string(args[0])))
      case 'git:pullIntegrate': {
        const projectId = this.string(args[0])
        const options = (args[1] ?? {}) as {
          remote?: string
          branch?: string
          strategy?: string
        }
        const strategy = options.strategy
        if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'ff-only') {
          throw new TypeError('Invalid pull strategy')
        }
        const tokenRef = `git_pat_${projectId}`
        const token = (await this.vault.exists(tokenRef))
          ? await this.vault.resolve(tokenRef)
          : undefined
        return this.gitService.pullIntegrate(
          await this.resolveProjectPath(
            projectId,
            args[2] === undefined ? undefined : this.string(args[2])
          ),
          {
            remote: typeof options.remote === 'string' ? options.remote : undefined,
            branch: typeof options.branch === 'string' ? options.branch : undefined,
            strategy,
            token
          }
        )
      }
      case 'git:push': {
        const projectId = this.string(args[0])
        const options = (args[1] ?? {}) as {
          setUpstream?: boolean
          remote?: string
          branch?: string
        }
        const tokenRef = `git_pat_${projectId}`
        const token = (await this.vault.exists(tokenRef))
          ? await this.vault.resolve(tokenRef)
          : undefined
        return this.gitService.push(
          await this.resolveProjectPath(
            projectId,
            args[2] === undefined ? undefined : this.string(args[2])
          ),
          {
            setUpstream: Boolean(options.setUpstream),
            remote: typeof options.remote === 'string' ? options.remote : undefined,
            branch: typeof options.branch === 'string' ? options.branch : undefined,
            token
          }
        )
      }
      case 'git:getCredentialStatus': {
        const projectId = this.string(args[0])
        return {
          configured: await this.vault.exists(`git_pat_${projectId}`),
          secureStorageAvailable: this.vault.isAvailable()
        }
      }
      case 'git:merge':
        return this.gitService.merge(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:rebase':
        return this.gitService.rebase(
          await this.resolveProjectPath(this.string(args[0])),
          this.string(args[1])
        )
      case 'git:stash':
        return this.gitService.stash(
          await this.resolveProjectPath(this.string(args[0])),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'git:stashList':
        return this.gitService.listStashes(await this.resolveProjectPath(this.string(args[0])))
      case 'git:stashPop':
        return this.gitService.popStash(
          await this.resolveProjectPath(this.string(args[0])),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'git:stashDrop':
        return this.gitService.dropStash(
          await this.resolveProjectPath(this.string(args[0])),
          typeof args[1] === 'string' ? args[1] : undefined
        )
      case 'git:abortMerge':
        return this.gitService.abortMerge(await this.resolveProjectPath(this.string(args[0])))
      case 'git:abortRebase':
        return this.gitService.abortRebase(await this.resolveProjectPath(this.string(args[0])))

      // ─── GitHub read-only auth status (device flow stays desktop-only) ──
      case 'github:authStatus':
        return this.githubAuthService.status()

      // ─── Electron-only helpers — the phone cannot use these, but the
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

  private requiredDeviceId(device?: RemoteRpcDeviceContext): string {
    if (!device?.deviceId) throw new Error('Authenticated device identity is required')
    return device.deviceId
  }

  private async remoteAttachmentDirectory(scope: AttachmentStorageScope): Promise<string> {
    if (
      !scope ||
      (scope.kind !== 'project' && scope.kind !== 'chat') ||
      typeof scope.projectId !== 'string' ||
      typeof scope.threadId !== 'string' ||
      scope.projectId.length === 0 ||
      scope.threadId.length === 0 ||
      scope.projectId.length > 256 ||
      scope.threadId.length > 256 ||
      /[/\\]/u.test(scope.projectId) ||
      /[/\\]/u.test(scope.threadId)
    ) {
      throw new TypeError('Attachment storage scope is invalid')
    }
    const project = await this.projectManager.getProject(scope.projectId)
    return threadAttachmentDirectory(project ?? null, scope)
  }

  private async pruneRemoteUploads(): Promise<void> {
    const cutoff = Date.now() - REMOTE_UPLOAD_TTL_MS
    for (const [uploadId, upload] of this.remoteUploads) {
      if (upload.createdAt >= cutoff) continue
      this.remoteUploads.delete(uploadId)
      await rm(upload.stagingPath, { force: true }).catch(() => undefined)
    }
  }

  private async beginRemoteUpload(
    device: RemoteRpcDeviceContext | undefined,
    scope: AttachmentStorageScope,
    originalFilename: string,
    rawSize: unknown
  ): Promise<string> {
    const deviceId = this.requiredDeviceId(device)
    await this.pruneRemoteUploads()
    if (this.remoteUploads.size >= MAX_CONCURRENT_REMOTE_UPLOADS) {
      throw new Error('Too many attachment uploads are already in progress')
    }
    if (
      typeof rawSize !== 'number' ||
      !Number.isSafeInteger(rawSize) ||
      rawSize < 1 ||
      rawSize > MAX_REMOTE_ATTACHMENT_BYTES
    ) {
      throw new TypeError('Remote attachment must be between 1 byte and 32 MB')
    }
    if (originalFilename.length < 1 || originalFilename.length > 255) {
      throw new TypeError('Attachment filename is invalid')
    }
    const extension = extname(originalFilename)
    const safeExtension = /^\.[a-z0-9]{1,16}$/iu.test(extension) ? extension.toLowerCase() : ''
    const directory = await this.remoteAttachmentDirectory(scope)
    await mkdir(directory, { recursive: true })
    const uploadId = randomUUID()
    const filename = `dropped-${randomUUID()}${safeExtension}`
    const targetPath = join(directory, filename)
    const stagingPath = join(directory, `.${filename}.${process.pid}.${uploadId}.tmp`)
    await writeFile(stagingPath, new Uint8Array(0), { flag: 'wx', mode: 0o600 })
    this.remoteUploads.set(uploadId, {
      deviceId,
      stagingPath,
      targetPath,
      size: rawSize,
      received: 0,
      createdAt: Date.now()
    })
    return uploadId
  }

  private async appendRemoteUpload(
    device: RemoteRpcDeviceContext | undefined,
    uploadId: string,
    rawOffset: unknown,
    base64Chunk: string
  ): Promise<number> {
    const upload = this.remoteUploads.get(uploadId)
    if (!upload || upload.deviceId !== this.requiredDeviceId(device)) {
      throw new Error('Attachment upload was not found')
    }
    if (rawOffset !== upload.received) throw new Error('Attachment upload chunk is out of order')
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64Chunk)) {
      throw new TypeError('Attachment upload chunk is invalid')
    }
    const bytes = Buffer.from(base64Chunk, 'base64')
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_REMOTE_ATTACHMENT_CHUNK_BYTES) {
      throw new TypeError('Attachment upload chunk is too large')
    }
    if (upload.received + bytes.byteLength > upload.size) {
      throw new TypeError('Attachment upload exceeds the declared file size')
    }
    await appendFile(upload.stagingPath, bytes)
    upload.received += bytes.byteLength
    return upload.received
  }

  private async finishRemoteUpload(
    device: RemoteRpcDeviceContext | undefined,
    uploadId: string
  ): Promise<string> {
    const upload = this.remoteUploads.get(uploadId)
    if (!upload || upload.deviceId !== this.requiredDeviceId(device)) {
      throw new Error('Attachment upload was not found')
    }
    if (upload.received !== upload.size) throw new Error('Attachment upload is incomplete')
    await rename(upload.stagingPath, upload.targetPath)
    this.remoteUploads.delete(uploadId)
    return upload.targetPath
  }

  private async cancelRemoteUpload(
    device: RemoteRpcDeviceContext | undefined,
    uploadId: string
  ): Promise<void> {
    const upload = this.remoteUploads.get(uploadId)
    if (!upload || upload.deviceId !== this.requiredDeviceId(device)) return
    this.remoteUploads.delete(uploadId)
    await rm(upload.stagingPath, { force: true }).catch(() => undefined)
  }

  private async readRemoteAttachmentChunk(
    requestedPath: string,
    rawOffset: unknown
  ): Promise<{ base64: string; nextOffset: number; size: number }> {
    if (requestedPath.length < 1 || requestedPath.length > 4_096 || !isAbsolute(requestedPath)) {
      throw new TypeError('Attachment path is invalid')
    }
    if (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw new TypeError('Attachment read offset is invalid')
    }

    const canonicalPath = await realpath(resolve(requestedPath))
    const fileInfo = await stat(canonicalPath)
    if (!fileInfo.isFile()) throw new TypeError('Attachment source must be a file')
    if (fileInfo.size < 1 || fileInfo.size > MAX_REMOTE_ATTACHMENT_BYTES) {
      throw new TypeError('Remote attachment must be between 1 byte and 32 MB')
    }
    if (rawOffset > fileInfo.size) throw new RangeError('Attachment read offset exceeds file size')
    if (!(await this.isAppOwnedAttachmentPath(canonicalPath))) {
      throw new Error('Attachment path is outside app-owned temporary storage')
    }

    const byteLength = Math.min(REMOTE_ATTACHMENT_READ_CHUNK_BYTES, fileInfo.size - rawOffset)
    if (byteLength === 0) return { base64: '', nextOffset: rawOffset, size: fileInfo.size }

    const handle = await open(canonicalPath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(byteLength)
      const { bytesRead } = await handle.read(buffer, 0, byteLength, rawOffset)
      if (bytesRead < 1) throw new Error('Attachment read ended unexpectedly')
      return {
        base64: buffer.subarray(0, bytesRead).toString('base64'),
        nextOffset: rawOffset + bytesRead,
        size: fileInfo.size
      }
    } finally {
      await handle.close()
    }
  }

  private async isAppOwnedAttachmentPath(canonicalPath: string): Promise<boolean> {
    const configRoot = await realpath(getConfigRoot()).catch(() => resolve(getConfigRoot()))
    const configRelative = relative(configRoot, canonicalPath)
    if (isContainedRelativePath(configRelative)) {
      const segments = configRelative.split(sep)
      const chatAttachment =
        segments[0] === 'chats' && segments.length >= 4 && segments[2] === 'tmp'
      const projectAttachment =
        segments[0] === 'projects' &&
        segments.length >= 6 &&
        segments[2] === 'threads' &&
        segments[4] === 'tmp'
      if (chatAttachment || projectAttachment) return true
    }

    const projects = await this.projectManager.listProjects()
    for (const project of projects) {
      if (project.source !== 'local' || !project.path) continue
      const root = join(project.path, PROJECT_DATA_DIRECTORY, 'tmp', 'attachments')
      const canonicalRoot = await realpath(root).catch(() => null)
      if (canonicalRoot && isContainedRelativePath(relative(canonicalRoot, canonicalPath))) {
        return true
      }
    }
    return false
  }

  /** Resolve a project id to its validated absolute path (git operates on paths). */
  private async resolveProjectPath(projectId: string, scopeBucketId?: string): Promise<string> {
    if (scopeBucketId) {
      const scopeRoot = await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
      if (!scopeRoot) throw new Error(`Scope root unavailable: ${projectId}:${scopeBucketId}`)
      return scopeRoot
    }
    const project = await this.projectManager.getProject(projectId)
    if (!project?.path) throw new Error(`Project not found: ${projectId}`)
    return project.path
  }

  /**
   * A checkout/create-branch/reset moves the branch, so keep every owned
   * thread whose working directory is this project coherent — mirroring the
   * desktop git IPC handler.
   */
  private async syncBranchAfterCheckout<T>(projectId: string, result: T): Promise<T> {
    const threads = await this.threadManager.listThreads(projectId)
    for (const thread of threads) {
      if (!thread.workingDirectory) continue
      const branchName = await this.repositoryService.getCurrentBranch(thread.workingDirectory)
      if (branchName) await this.threadManager.setBranch(projectId, thread.id, branchName)
    }
    return result
  }

  private string(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('Expected a string argument')
    return value
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
  }

  private optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new TypeError('Expected a boolean argument')
    return value
  }

  private boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new TypeError('Expected a boolean argument')
    return value
  }

  private stringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError(`${label} must be an array of strings`)
    }
    return value
  }
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`)
  )
}
