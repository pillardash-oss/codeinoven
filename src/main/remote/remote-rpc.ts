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
import { ThreadManager } from '../../lib/engines/thread-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ProjectFilesService } from '../project-files-service'
import type { ChatEngine } from '../chat-engine'
import { broadcastThreadUpdate } from '../thread-events'
import { REMOTE_ALLOWED_CHANNELS } from '../../lib/remote-rpc'
import { ScopeManager } from '../../lib/engines/scope-manager'
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
import { SpecContextService } from '../spec-context-service'
import { CheckpointManager } from '../checkpoint-manager'
import { MemoryService } from '../memory-service'
import { RepositoryService } from '../repository-service'
import { validateEngineeringSpec } from '../../lib/spec/spec-validation'
import { StorageEngine } from '../storage-engine'
import { validateScopeBoard, validateScopeSlice } from '../ipc-validation'
import type {
  AssignmentModelSelection,
  AssignmentPlanContent,
  AuditGenerationRequest,
  BrainstormContent,
  BrainstormEntryChoice,
  CreateThreadInput,
  EngineeringSpecContent,
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
import { Logger } from '../logger'

export interface RemoteRpcServices {
  database: Database
  chatEngine: Pick<
    ChatEngine,
    | 'loadMessages'
    | 'deleteThreadSession'
    | 'listProviderSnapshot'
    | 'getSessionStatus'
    | 'ensureSession'
    | 'sendPrompt'
    | 'steerPrompt'
    | 'abort'
    | 'listPermissions'
    | 'replyPermission'
    | 'listQuestions'
    | 'answerQuestion'
    | 'listCommands'
    | 'runCommand'
    | 'compactSession'
    | 'truncateMessages'
    | 'dismissQuestion'
    | 'updateQuestion'
    | 'listContextCapabilities'
    | 'listProviders'
    | 'loadSessionMessages'
    | 'getChildSessionStatus'
    | 'retryChildSession'
    | 'abortChildSession'
    | 'closeTemporaryChat'
    | 'chooseBrainstormEntry'
    | 'reviewBrainstorm'
    | 'finalizeBrainstorm'
    | 'ensureAuditSession'
    | 'startAssignment'
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
}

/** A remote RPC invoke request that reached the main process. */
export interface RemoteInvoke {
  id: number
  channel: string
  args: unknown[]
}

export type RemoteRpcResult = { ok: true; result: unknown } | { ok: false; message: string }

export class RemoteRpcDispatcher {
  private readonly threadManager: ThreadManager
  private readonly projectManager: ProjectManager
  private readonly projectFilesService: ProjectFilesService
  private readonly scopeManager: ScopeManager
  private readonly specEngine: SpecEngine
  private readonly brainstormEngine: BrainstormEngine
  private readonly auditEngine: AuditEngine
  private readonly assignmentEngine: AssignmentEngine
  private readonly specContextService: SpecContextService
  private readonly checkpointManager: CheckpointManager
  private readonly memoryService: MemoryService
  private readonly repositoryService: RepositoryService
  private readonly storage: StorageEngine

  constructor(private readonly services: RemoteRpcServices) {
    this.storage = services.storage ?? new StorageEngine()
    this.threadManager = new ThreadManager(services.database, broadcastThreadUpdate, (thread) => {
      void services.chatEngine.deleteThreadSession(thread.projectId, thread.id)
    })
    this.projectManager = services.projectManager ?? new ProjectManager(services.database)
    this.projectFilesService = new ProjectFilesService(this.projectManager)
    this.scopeManager = new ScopeManager(services.database)
    this.specEngine = new SpecEngine(this.storage, services.database, {
      validateForApproval: validateEngineeringSpec
    })
    this.brainstormEngine = new BrainstormEngine(this.storage, services.database)
    this.auditEngine = new AuditEngine(this.storage, services.database)
    this.assignmentEngine = new AssignmentEngine(this.storage, services.database)
    this.specContextService = new SpecContextService(services.database, this.projectManager)
    this.checkpointManager = new CheckpointManager(services.database)
    this.memoryService = new MemoryService(this.storage)
    this.repositoryService = new RepositoryService()
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
    try {
      const result = await this.call(invoke.channel, invoke.args)
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logger.error(`Remote RPC ${invoke.channel} failed:`, error)
      return { ok: false, message }
    }
  }

  private async call(channel: string, args: unknown[]): Promise<unknown> {
    const { chatEngine } = this.services
    switch (channel) {
      // ─── Projects ────────────────────────────────────────────────────────
      case 'project:list':
        return this.projectManager.listProjects()
      case 'project:get':
        return this.projectManager.getProject(this.string(args[0]))
      case 'project:getIcon':
        return this.projectManager.getIconDataUrl(this.string(args[0]))

      // ─── Threads ─────────────────────────────────────────────────────────
      case 'thread:listAll':
        return this.threadManager.listAllThreads()
      case 'thread:list':
        return this.threadManager.listThreads(this.string(args[0]))
      case 'thread:get':
        return this.threadManager.getThread(this.string(args[0]), this.string(args[1]))
      case 'thread:create':
        return this.threadManager.createThread(args[0] as CreateThreadInput)
      case 'thread:markRead':
        return this.threadManager.markRead(this.string(args[0]), this.string(args[1]))
      case 'thread:setArchived':
        return this.threadManager.setArchived(
          this.string(args[0]),
          this.string(args[1]),
          Boolean(args[2])
        )
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
        this.threadManager.setContextUsage(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadContextUsage
        )
        return undefined
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
      case 'thread:update':
        return this.threadManager.updateThread(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as Record<string, unknown>
        )
      case 'thread:delete':
        await this.threadManager.deleteThread(this.string(args[0]), this.string(args[1]))
        await this.memoryService.deleteThreadMemory(this.string(args[0]), this.string(args[1]))
        return undefined
      case 'thread:fork': {
        await chatEngine.loadMessages(this.string(args[0]), this.string(args[1]))
        return this.threadManager.forkThread(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          typeof args[3] === 'string' ? args[3] : undefined,
          typeof args[4] === 'string' ? args[4] : undefined
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
      case 'scope:save':
        return this.scopeManager.saveBoard(this.string(args[0]), validateScopeBoard(args[1]))

      // ─── Agent chat surface ─────────────────────────────────────────────
      case 'agent:loadMessages':
        return chatEngine.loadMessages(this.string(args[0]), this.string(args[1]))
      case 'agent:listProviderSnapshot':
        return chatEngine.listProviderSnapshot(this.string(args[0]))
      case 'agent:refreshProviderCatalog':
        return chatEngine.listProviders(this.string(args[0]), true)
      case 'agent:getSessionStatus':
        return chatEngine.getSessionStatus(this.string(args[0]), this.string(args[1]))
      case 'agent:ensureSession':
        return chatEngine.ensureSession(this.string(args[0]), this.string(args[1]))
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
          (args[10] as 'user' | 'internal') ?? 'user',
          args[11] as UserMessagePresentation | undefined,
          args[12] as PromptAssignmentTaskReference[] | undefined
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
      case 'agent:listContextCapabilities':
        return chatEngine.listContextCapabilities(this.string(args[0]), this.string(args[1]))
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
      case 'agent:ensureAuditSession':
        return chatEngine.ensureAuditSession(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as ThreadSettings
        )
      case 'agent:startAssignment':
        return chatEngine.startAssignment(
          this.string(args[0]),
          this.string(args[1]),
          (args[2] as 'user' | 'internal') ?? 'user'
        )
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
          assignment.auditCycle?.status === 'report_ready'
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
        await this.threadManager.setStatus(projectId, threadId, 'awaiting_approval')
        return assignment
      }

      // ─── Brainstorm studio ──────────────────────────────────────────────
      case 'brainstorm:getActive':
        return this.brainstormEngine.getActive(this.string(args[0]), this.string(args[1]))
      case 'brainstorm:getWorkflow':
        return this.brainstormEngine.getWorkflowState(this.string(args[0]), this.string(args[1]))
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

      // ─── Repo metadata ──────────────────────────────────────────────────
      case 'repository:remoteOrigin':
        return this.repositoryService.getRemoteOrigin(this.string(args[0]))

      // ─── Electron-only helpers — the phone cannot use these, but the
      //     shared components call them; return a graceful no-op. ─────────
      case 'dialog:pickFile':
      case 'clipboard:saveImage':
        return null
      case 'shell:revealPath':
      case 'shell:openExternal':
        return undefined

      default:
        throw new Error(`Unknown remote channel: ${channel}`)
    }
  }

  private string(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('Expected a string argument')
    return value
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
  }

  private stringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError(`${label} must be an array of strings`)
    }
    return value
  }
}
