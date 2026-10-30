import { trustedIpcMain as ipcMain } from '../../ipc/trusted-ipc-main'
import { Logger } from '../../system/logger'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import { instanceEventBus } from '../../system/instance-event-bus'
import { validateMcpProbeTarget } from '../../utilities/mcp-probe-input'
import type {
  AgentAccountUsageOverrides,
  AgentModelSelection,
  AgentCapabilitySource,
  NativeMcpContent,
  SkillRelocationRequest,
  AuditGenerationRequest,
  BrainstormEntryChoice,
  ImageDescriptorReplyAction,
  PermissionLevel,
  PermissionReply,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  ProviderCatalogRefreshOptions,
  AgentSecretSubmission,
  SpecGenerationRequest,
  SpecActionIntent,
  UserMessagePresentation,
  ThreadSettings,
  TurnStreamPartsQuery,
  BrainstormPrototypeFidelity
} from '../../../lib/types'
import { rawErrorMessage } from './chat-engine-errors'
import { withoutTransportParts } from './chat-engine-message-merge'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine lifecycle-boot: one concern, moved verbatim from the composition root. */
export class ChatEngineLifecycleBoot {
  constructor(private readonly host: ChatEngine) {}

  register(): void {
    // The cross-instance bus ships render-only stream events to sibling
    // instances. Resolving the conversation here is what lets a sibling window
    // bind a session it has never seen and render the turn from its first frame
    // instead of waiting for the shared row to catch up.
    instanceEventBus.setSessionOwnerResolver((sessionId) => {
      const info = this.host.sessionRegistry.get(sessionId)
      return info ? { projectId: info.projectId, threadId: info.threadId } : null
    })
    ipcMain.handle(
      'harnessRuntime:restart',
      (_, harnessId: unknown, options?: { force?: boolean }) =>
        this.host.restartHarnessRuntime(
          this.host.units['providers-harness'].requireHarnessId(harnessId),
          {
            force: options?.force === true
          }
        )
    )
    ipcMain.handle('agent:compact', (_, projectId: string, threadId: string) =>
      this.host.compactSession(projectId, threadId)
    )
    ipcMain.handle('agent:listProviders', (_, projectId: string) =>
      this.host.listProviders(projectId)
    )
    ipcMain.handle('agent:listProviderSnapshot', (_, projectId: string) =>
      this.host.listProviderSnapshot(projectId)
    )
    ipcMain.handle(
      'agent:refreshProviderCatalog',
      async (_, projectId: string, options: ProviderCatalogRefreshOptions = {}) =>
        this.host.refreshProviderCatalog(projectId, options)
    )
    ipcMain.handle(
      'agent:refreshModelContext',
      async (
        _,
        projectId: string,
        harnessId: string,
        providerId: string,
        modelId: string,
        accountId?: string
      ) => {
        projectId = validateEntityId(projectId, 'Project ID')
        harnessId = this.host.units['providers-harness'].requireHarnessId(harnessId)
        providerId = validateBoundedString(providerId, 'Provider ID', 1, 128)
        modelId = validateBoundedString(modelId, 'Model ID', 1, 256)
        if (accountId !== undefined) accountId = validateEntityId(accountId, 'Account ID')
        if (harnessId !== 'codex' || providerId !== 'openai') return null
        const driver = await this.host.driverForAccount(harnessId, accountId)
        if (!driver.modelContext) return null
        return driver.modelContext(
          await this.host.units['turns'].discoveryWorkingDirectory(projectId),
          modelId
        )
      }
    )
    ipcMain.handle('agent:refreshAccountUsage', (_, overrides?: AgentAccountUsageOverrides) =>
      this.host.refreshAccountUsage(overrides)
    )
    ipcMain.handle('agent:activateBankedReset', (_, projectId: string, threadId: string) =>
      this.host.activateBankedReset(projectId, threadId)
    )
    ipcMain.handle(
      'agent:getHarnessAuthStatus',
      (_, projectId: string, harnessId: string, accountId?: string) =>
        this.host.getHarnessAuthStatus(projectId, harnessId, accountId)
    )
    ipcMain.handle(
      'agent:listTools',
      (
        _,
        projectId?: string,
        harnessId?: string,
        providerId?: string,
        modelId?: string,
        force = false
      ) => this.host.listTools(projectId, harnessId, providerId, modelId, force)
    )
    ipcMain.handle(
      'agent:listContextCapabilities',
      (_, projectId: string, threadId: string, harnessId?: string) =>
        this.host.listContextCapabilities(projectId, threadId, harnessId)
    )
    ipcMain.handle('agent:listArtifacts', (_, projectId: string, threadId: string) =>
      this.host.listArtifacts(projectId, threadId)
    )
    ipcMain.handle('agent:listProcesses', (_, projectId: unknown, threadId: unknown) =>
      this.host.state.agentProcesses.list(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID')
      )
    )
    ipcMain.handle(
      'agent:killProcess',
      (_, projectId: unknown, threadId: unknown, pid: unknown) => {
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
          throw new TypeError('Process ID must be a positive integer')
        }
        return this.host.state.agentProcesses.killProcess(
          validateEntityId(projectId, 'Project ID'),
          validateEntityId(threadId, 'Thread ID'),
          pid
        )
      }
    )
    ipcMain.handle('agent:killThreadProcesses', (_, projectId: unknown, threadId: unknown) =>
      this.host.state.agentProcesses.killThread(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID')
      )
    )
    ipcMain.handle('taskManager:list', () => this.host.listTaskManagerProcesses())
    ipcMain.handle('taskManager:killProcess', (_, pid: unknown, force: unknown) => {
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new TypeError('Process ID must be a positive integer')
      }
      return this.host.killTaskManagerProcess(pid, force === true)
    })
    ipcMain.handle('taskManager:stopService', (_, id: unknown) => {
      if (typeof id !== 'string' || id.trim().length === 0) {
        throw new TypeError('Service id must be a non-empty string')
      }
      return this.host.stopTaskManagerService(id)
    })
    ipcMain.handle('capabilities:readSkill', (_, source: AgentCapabilitySource) =>
      this.host.state.capabilityDiscovery.readSkill(source)
    )
    ipcMain.handle(
      'capabilities:updateSkill',
      (_, source: AgentCapabilitySource, instructions: string) =>
        this.host.state.capabilityDiscovery.updateSkill(source, instructions)
    )
    ipcMain.handle(
      'capabilities:relocateSkill',
      async (_, source: AgentCapabilitySource, request: SkillRelocationRequest) => {
        if (source?.kind !== 'skill') throw new TypeError('A skill source is required')
        if (typeof request?.instructions !== 'string') {
          throw new TypeError('Skill instructions are required')
        }
        const harnessIds = Array.isArray(request.harnessIds)
          ? request.harnessIds.filter(
              (harnessId): harnessId is string =>
                typeof harnessId === 'string' && harnessId.trim().length > 0
            )
          : []
        if (harnessIds.length === 0) throw new TypeError('Select at least one harness')
        const projectId =
          typeof request.projectId === 'string' && request.projectId.trim().length > 0
            ? validateEntityId(request.projectId, 'Project ID')
            : ''
        const projectPath = projectId
          ? await this.host.units['turns'].resolveProjectPath(projectId)
          : undefined
        return this.host.state.capabilityDiscovery.relocateSkill(
          source,
          {
            harnessIds,
            instructions: request.instructions,
            ...(projectId ? { projectId } : {})
          },
          projectPath
        )
      }
    )
    ipcMain.handle('capabilities:deleteSkill', (_, source: AgentCapabilitySource) =>
      this.host.state.capabilityDiscovery.deleteSkill(source)
    )
    ipcMain.handle('capabilities:readMcp', (_, source: AgentCapabilitySource) =>
      this.host.state.capabilityDiscovery.readMcp(source)
    )
    ipcMain.handle(
      'capabilities:updateMcp',
      (_, source: AgentCapabilitySource, content: NativeMcpContent) =>
        this.host.state.capabilityDiscovery.updateMcp(source, content)
    )
    ipcMain.handle('capabilities:deleteMcp', (_, source: AgentCapabilitySource) =>
      this.host.state.capabilityDiscovery.deleteMcp(source)
    )
    ipcMain.handle('capabilities:listAll', () => this.host.listAllCapabilities())
    // A saved MCP configuration says nothing about whether its server answers:
    // the Utilities page and editor test the live connection through here.
    ipcMain.handle('utilities:testMcp', (_, target: unknown) =>
      this.host.state.mcpConnectionTest.test(validateMcpProbeTarget(target))
    )
    ipcMain.handle(
      'agent:ensureSession',
      (_, projectId: string, threadId: string, requestedDriverId?: string) =>
        this.host.ensureSession(projectId, threadId, requestedDriverId)
    )
    ipcMain.handle('agent:warmSession', (_, projectId: string, threadId: string) =>
      this.host.warmThreadSession(projectId, threadId)
    )
    ipcMain.handle(
      'agent:loadMessages',
      async (_, projectId: string, threadId: string, limit?: number) => {
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
          throw new TypeError('Message limit must be an integer between 1 and 100')
        }
        const messages = await this.host.loadMessages(projectId, threadId)
        return limit === undefined ? messages : messages.slice(-limit)
      }
    )
    ipcMain.handle(
      'agent:loadSessionMessages',
      (_, projectId: string, threadId: string, sessionId: string) =>
        this.host.loadSessionMessages(projectId, threadId, sessionId)
    )
    ipcMain.handle(
      'thread:loadStreamParts',
      (_, projectId: string, threadId: string, query?: TurnStreamPartsQuery) =>
        this.host.loadTurnStreamParts(projectId, threadId, query ?? {})
    )
    ipcMain.handle('agent:loadTemporaryChatMessages', async (_, temporaryChatId: string) =>
      (await this.host.loadTemporaryConversation(temporaryChatId)).map(withoutTransportParts)
    )
    ipcMain.handle('agent:getSessionStatus', (_, projectId: string, threadId: string) =>
      this.host.getSessionStatus(projectId, threadId)
    )
    ipcMain.handle(
      'agent:dismissSessionError',
      (_, projectId: string, threadId: string, sessionId: string) =>
        this.host.dismissSessionError(projectId, threadId, sessionId)
    )
    ipcMain.handle(
      'agent:getChildSessionStatus',
      (_, projectId: string, threadId: string, sessionId: string) =>
        this.host.getChildSessionStatus(projectId, threadId, sessionId)
    )
    ipcMain.handle(
      'agent:retryChildSession',
      (_, projectId: string, threadId: string, sessionId: string) =>
        this.host.retryChildSession(projectId, threadId, sessionId)
    )
    ipcMain.handle(
      'agent:retryAssignmentWorker',
      (_, projectId: string, coordinatorThreadId: string, workerThreadId: string) =>
        this.host.retryAssignmentWorker(projectId, coordinatorThreadId, workerThreadId)
    )
    ipcMain.handle(
      'agent:reportWorkerToCoordinator',
      (_, projectId: string, coordinatorThreadId: string, workerThreadId: string) =>
        this.host.reportWorkerToCoordinator(projectId, coordinatorThreadId, workerThreadId)
    )
    ipcMain.handle(
      'agent:resumeAssignmentAttention',
      (_, projectId: string, coordinatorThreadId: string) =>
        this.host.resumeAssignmentAttention(projectId, coordinatorThreadId)
    )
    ipcMain.handle(
      'agent:abortChildSession',
      (_, projectId: string, threadId: string, sessionId: string) =>
        this.host.abortChildSession(projectId, threadId, sessionId)
    )
    ipcMain.handle(
      'agent:truncateMessages',
      (_, projectId: string, threadId: string, messageId: string) =>
        this.host.truncateMessages(projectId, threadId, messageId)
    )
    ipcMain.handle(
      'agent:deleteMessages',
      (_, projectId: string, threadId: string, messageId: string, mode: 'down' | 'single' | 'up') =>
        this.host.deleteMessages(projectId, threadId, messageId, mode)
    )
    ipcMain.handle(
      'agent:deleteTemporaryMessages',
      (
        _,
        projectId: string,
        threadId: string,
        temporaryChatId: string,
        messageId: string,
        mode: 'down' | 'single' | 'up'
      ) => this.host.deleteTemporaryMessages(projectId, threadId, temporaryChatId, messageId, mode)
    )
    ipcMain.handle(
      'agent:discardSteer',
      (_, projectId: string, threadId: string, messageId: string) =>
        this.host.discardSteer(projectId, threadId, messageId)
    )
    ipcMain.handle(
      'agent:sendPrompt',
      (
        _,
        projectId: string,
        threadId: string,
        settings: ThreadSettings,
        text: string,
        attachments: PromptAttachment[],
        specAction: SpecActionIntent | undefined,
        userMessageId: string,
        promptContext?: string,
        promptReferences?: PromptReference[],
        projectReferences?: PromptProjectReference[],
        presentation?: UserMessagePresentation,
        taskReferences?: PromptAssignmentTaskReference[]
      ) =>
        this.host.sendPrompt(
          projectId,
          threadId,
          settings,
          text,
          attachments,
          specAction,
          userMessageId,
          promptContext,
          promptReferences,
          projectReferences,
          'user',
          presentation,
          taskReferences
        )
    )
    ipcMain.handle(
      'agent:chooseBrainstormEntry',
      (_, projectId: string, threadId: string, choice: BrainstormEntryChoice) =>
        this.host.chooseBrainstormEntry(projectId, threadId, choice)
    )
    ipcMain.handle(
      'agent:reviewBrainstorm',
      (
        _,
        projectId: string,
        threadId: string,
        brainstormId: string,
        version: number,
        note: string,
        prototypeRequest?: { fidelity: BrainstormPrototypeFidelity; count?: number }
      ) =>
        this.host.reviewBrainstorm(projectId, threadId, brainstormId, version, note, {
          prototypeRequest
        })
    )
    ipcMain.handle(
      'agent:finalizeBrainstorm',
      (
        _,
        projectId: string,
        threadId: string,
        brainstormId: string,
        version: number,
        note?: string
      ) => this.host.finalizeBrainstorm(projectId, threadId, brainstormId, version, note)
    )
    ipcMain.handle(
      'agent:generatePrd',
      (
        _,
        projectId: string,
        threadId: string,
        settings: ThreadSettings,
        instructions: string,
        attachments: PromptAttachment[],
        userMessageId: string
      ) =>
        this.host.generatePrd(
          projectId,
          threadId,
          settings,
          instructions,
          attachments,
          userMessageId
        )
    )
    ipcMain.handle(
      'agent:steerPrompt',
      async (
        _,
        projectId: string,
        threadId: string,
        text: string,
        attachments: PromptAttachment[],
        userMessageId: string,
        promptContext?: string,
        promptReferences?: PromptReference[],
        projectReferences?: PromptProjectReference[],
        presentation?: UserMessagePresentation,
        taskReferences?: PromptAssignmentTaskReference[]
      ) => {
        const message = await this.host.steerPrompt(
          projectId,
          threadId,
          text,
          attachments,
          userMessageId,
          promptContext,
          promptReferences,
          projectReferences,
          presentation,
          taskReferences
        )
        // Tell the renderer whether the steer is held for the undo window or
        // already reached the harness, so it anchors the running turn on the
        // right prompt. A held steer stays under the turn it steers; a
        // delivered one opens its own trace shell right away.
        const held = [...this.host.state.heldSteers.values()].some(
          (steer) => steer.userMessageId === userMessageId
        )
        return { message, held }
      }
    )
    ipcMain.handle(
      'agent:sendTemporaryPrompt',
      (
        _,
        projectId: string,
        threadId: string,
        temporaryChatId: string,
        settings: ThreadSettings,
        text: string,
        attachments: PromptAttachment[],
        references?: PromptReference[],
        initialContext?: string,
        userMessageId?: string,
        displayText?: string
      ) =>
        this.host.sendTemporaryPrompt(
          projectId,
          threadId,
          temporaryChatId,
          settings,
          text,
          attachments,
          references,
          initialContext,
          userMessageId,
          displayText
        )
    )
    ipcMain.handle(
      'agent:steerTemporaryPrompt',
      (
        _,
        projectId: string,
        threadId: string,
        temporaryChatId: string,
        settings: ThreadSettings,
        text: string,
        attachments: PromptAttachment[],
        references?: PromptReference[],
        userMessageId?: string,
        displayText?: string
      ) =>
        this.host.steerTemporaryPrompt(
          projectId,
          threadId,
          temporaryChatId,
          settings,
          text,
          attachments,
          references,
          userMessageId,
          displayText
        )
    )
    ipcMain.handle('agent:closeTemporaryChat', (_, temporaryChatId: string) =>
      this.host.closeTemporaryChat(temporaryChatId)
    )
    ipcMain.handle(
      'agent:abortTemporaryChat',
      (_, projectId: string, threadId: string, temporaryChatId: string) =>
        this.host.abortTemporaryChat(projectId, threadId, temporaryChatId)
    )
    ipcMain.handle('agent:getTemporaryChatStatus', (_, temporaryChatId: string) =>
      this.host.getTemporaryChatStatus(temporaryChatId)
    )
    ipcMain.handle('agent:touchTemporaryChat', (_, temporaryChatId: string) =>
      this.host.touchTemporaryChat(temporaryChatId)
    )
    ipcMain.handle(
      'temporary-chat:convertToThread',
      (
        _,
        projectId: string,
        threadId: string,
        temporaryChatId: string,
        settings: ThreadSettings,
        title?: string
      ) =>
        this.host.convertTemporaryChatToThread(
          projectId,
          threadId,
          temporaryChatId,
          settings,
          title
        )
    )
    ipcMain.handle('agent:abort', (_, projectId: string, threadId: string) =>
      this.host.abort(projectId, threadId)
    )
    ipcMain.handle(
      'agent:replyPermission',
      (_, projectId: string, requestId: string, reply: PermissionReply, alternative?: string) =>
        this.host.replyPermission(projectId, requestId, reply, alternative)
    )
    ipcMain.handle('agent:listPermissions', (_, projectId: string, threadId: string) =>
      this.host.listPermissions(projectId, threadId)
    )
    ipcMain.handle('agent:listImageDescriptorErrors', (_, projectId: string, threadId: string) =>
      this.host.listImageDescriptorErrors(projectId, threadId)
    )
    ipcMain.handle(
      'agent:replyImageDescriptor',
      (
        _,
        projectId: string,
        threadId: string,
        requestId: string,
        action: ImageDescriptorReplyAction,
        selection?: AgentModelSelection,
        imagePath?: string
      ) =>
        this.host.replyImageDescriptor(projectId, threadId, requestId, action, selection, imagePath)
    )
    ipcMain.handle(
      'agent:answerQuestion',
      (_, projectId: string, threadId: string, requestId: string, answers: string[][]) =>
        this.host.answerQuestion(projectId, threadId, requestId, answers)
    )
    ipcMain.handle(
      'agent:answerSecret',
      (
        _,
        projectId: string,
        threadId: string,
        requestId: string,
        secrets: AgentSecretSubmission[]
      ) => this.host.answerSecret(projectId, threadId, requestId, secrets)
    )
    ipcMain.handle(
      'agent:dismissQuestion',
      (_, projectId: string, threadId: string, requestId: string) =>
        this.host.dismissQuestion(projectId, threadId, requestId)
    )
    ipcMain.handle('agent:listQuestions', (_, projectId: string, threadId: string) =>
      this.host.listQuestions(projectId, threadId)
    )
    // A side chat opened from a card keeps the user active while it is in use,
    // so the card's countdown stays held. This carries no answer or decision.
    ipcMain.handle('agent:userActivity', () => this.host.noteUserActivity())
    ipcMain.handle(
      'agent:updateQuestion',
      (
        _,
        projectId: string,
        threadId: string,
        requestId: string,
        questionIndex: number,
        answers: string[],
        nextQuestionIndex?: number
      ) =>
        this.host.updateQuestion(
          projectId,
          threadId,
          requestId,
          questionIndex,
          answers,
          nextQuestionIndex
        )
    )
    ipcMain.handle(
      'agent:listCommands',
      (_, projectId: string, threadId: string, harnessId?: string) =>
        this.host.listCommands(projectId, threadId, harnessId)
    )
    ipcMain.handle(
      'agent:generateSpec',
      (_, projectId: string, threadId: string, request: SpecGenerationRequest) =>
        this.host.generateSpec(projectId, threadId, request)
    )
    ipcMain.handle(
      'agent:generateAudit',
      (_, projectId: string, threadId: string, request: AuditGenerationRequest) =>
        this.host.generateAudit(projectId, threadId, request)
    )
    ipcMain.handle(
      'agent:generateIndependentAudit',
      (_, projectId: string, threadId: string, request: AuditGenerationRequest) =>
        this.host.generateIndependentAudit(projectId, threadId, request)
    )
    ipcMain.handle(
      'agent:startFreshIndependentAudit',
      (_, projectId: string, threadId: string, request: AuditGenerationRequest) =>
        this.host.startFreshIndependentAudit(projectId, threadId, request)
    )
    ipcMain.handle(
      'agent:deleteIndependentAuditorThread',
      (_, projectId: string, threadId: string) =>
        this.host.deleteIndependentAuditorThread(projectId, threadId)
    )
    ipcMain.handle(
      'agent:ensureIndependentAuditorThread',
      (_, projectId: string, threadId: string, settings: ThreadSettings) =>
        this.host.ensureIndependentAuditorThread(projectId, threadId, settings)
    )
    ipcMain.handle(
      'agent:ensureImplementationAuditorThread',
      (_, projectId: string, coordinatorThreadId: string, settings: ThreadSettings) =>
        this.host.ensureImplementationAuditorThread(projectId, coordinatorThreadId, settings)
    )
    ipcMain.handle(
      'agent:ensureAssignmentAuditorThread',
      (_, projectId: string, coordinatorThreadId: string, settings: ThreadSettings) =>
        this.host.ensureAssignmentAuditorThread(projectId, coordinatorThreadId, settings)
    )
    ipcMain.handle(
      'agent:generateAssignmentAudit',
      (_, projectId: string, coordinatorThreadId: string, settings: ThreadSettings) =>
        this.host.generateAssignmentAudit(projectId, coordinatorThreadId, settings)
    )
    ipcMain.handle(
      'agent:generateAssignmentDraft',
      (
        _,
        projectId: string,
        coordinatorThreadId: string,
        settings: ThreadSettings,
        instructions?: string
      ) => this.host.generateAssignmentDraft(projectId, coordinatorThreadId, settings, instructions)
    )
    ipcMain.handle(
      'agent:ensureAchievementScope',
      (_, projectId: string, coordinatorThreadId: string) =>
        this.host.ensureAchievementScope(projectId, coordinatorThreadId)
    )
    ipcMain.handle(
      'agent:ensureAchievementAuditorThread',
      (_, projectId: string, coordinatorThreadId: string, settings: ThreadSettings) =>
        this.host.ensureAchievementAuditorThread(projectId, coordinatorThreadId, settings)
    )
    ipcMain.handle(
      'agent:generateAchievementAudit',
      (_, projectId: string, coordinatorThreadId: string, settings: ThreadSettings) =>
        this.host.generateAchievementAudit(projectId, coordinatorThreadId, settings)
    )
    ipcMain.handle(
      'agent:submitAchievementAuditFeedback',
      (
        _,
        projectId: string,
        coordinatorThreadId: string,
        reportId: string,
        reportVersion: number,
        feedback: string
      ) =>
        this.host.submitAchievementAuditFeedback(
          projectId,
          coordinatorThreadId,
          reportId,
          reportVersion,
          feedback
        )
    )
    ipcMain.handle(
      'agent:returnAchievementAuditToOffer',
      (_, projectId: string, coordinatorThreadId: string) =>
        this.host.returnAchievementAuditToOffer(projectId, coordinatorThreadId)
    )
    ipcMain.handle(
      'agent:submitAssignmentAuditFeedback',
      (
        _,
        projectId: string,
        coordinatorThreadId: string,
        reportId: string,
        reportVersion: number,
        feedback: string
      ) =>
        this.host.submitAssignmentAuditFeedback(
          projectId,
          coordinatorThreadId,
          reportId,
          reportVersion,
          feedback
        )
    )
    ipcMain.handle('agent:startAssignment', (_, projectId: string, coordinatorThreadId: string) =>
      this.host.startAssignment(projectId, coordinatorThreadId)
    )
    ipcMain.handle('agent:stopAssignment', (_, projectId: string, coordinatorThreadId: string) =>
      this.host.stopAssignment(projectId, coordinatorThreadId)
    )
    ipcMain.handle('agent:resumeAssignment', (_, projectId: string, coordinatorThreadId: string) =>
      this.host.resumeAssignment(projectId, coordinatorThreadId)
    )
    ipcMain.handle('agent:ensureInitialSpec', (_, projectId: string, threadId: string) =>
      this.host.ensureInitialSpec(projectId, threadId)
    )
    ipcMain.handle(
      'agent:runCommand',
      (_, projectId: string, threadId: string, commandId: string, args: string) =>
        this.host.runCommand(projectId, threadId, commandId, args)
    )
    this.host.units['lifecycle-shutdown'].syncIdleReaper()
    void this.host.restoreCoordinatorHandoffQueues().catch((error) =>
      Logger.error('Coordinator handoff queue recovery failed', {
        error: rawErrorMessage(error)
      })
    )
    void this.host.units['spec'].recoverReadyInitialSpecs()
    void this.host.units['brainstorm'].recoverInterruptedBrainstormEntries()
  }

  // ─── Session registry ─────────────────────────────────────────────────────

  registerSession(
    sessionId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    permissionLevel: PermissionLevel,
    driverId: string,
    activeTurnId?: string,
    ephemeral?: boolean
  ): void {
    const existing = this.host.sessionRegistry.get(sessionId)
    // Naming the very turn the session is already running is a refresh, not a
    // new turn: keep the attribution that turn has built up. Resetting it here
    // used to erase the turn's claimed paths and its shell-tool flag, and
    // completion then recorded no workspace changes at all for a turn that
    // really did edit files.
    const sameTurn = activeTurnId !== undefined && existing?.activeTurnId === activeTurnId
    const continuesTurn = activeTurnId === undefined || sameTurn
    this.host.sessionRegistry.set(sessionId, {
      sessionId,
      projectId,
      threadId,
      projectPath,
      permissionLevel,
      // A session id is owned by the harness that created it and never
      // moves: when the user switches harness, `ensureSession` binds a
      // fresh session id from the new driver and retires the old one. Preserve
      // the registered owner so a settings-derived re-registration (mid-run
      // harness switch) can never clobber which driver owns the session.
      driverId: existing?.driverId ?? driverId,
      accountId: existing?.accountId,
      activeTurnId: activeTurnId ?? existing?.activeTurnId,
      lastTurnId: activeTurnId ?? existing?.activeTurnId ?? existing?.lastTurnId,
      activeTurnUserMessageId: existing?.activeTurnUserMessageId,
      activeTurnOrigin: existing?.activeTurnOrigin,
      estimatedContextUsed: continuesTurn ? existing?.estimatedContextUsed : undefined,
      hasReportedTokenUsage: existing?.hasReportedTokenUsage,
      changedPaths: continuesTurn ? existing?.changedPaths : undefined,
      preciseChangedPaths: continuesTurn ? existing?.preciseChangedPaths : new Map(),
      changeSources: continuesTurn ? existing?.changeSources : new Map(),
      rejectedChangeSources: continuesTurn ? existing?.rejectedChangeSources : new Map(),
      userTouchedPaths: continuesTurn ? existing?.userTouchedPaths : undefined,
      openUnboundedTools: continuesTurn ? existing?.openUnboundedTools : new Set(),
      unboundedWindowToolIds: continuesTurn ? existing?.unboundedWindowToolIds : undefined,
      unboundedToolObserved: continuesTurn ? existing?.unboundedToolObserved : false,
      unboundedWindowStart: continuesTurn ? existing?.unboundedWindowStart : undefined,
      pendingWindowScans: continuesTurn ? existing?.pendingWindowScans : new Set(),
      ephemeral: ephemeral ?? existing?.ephemeral
    })
    this.host.state.agentProcesses.claimSession(sessionId, projectId, threadId)
    // A session re-registering means the project is in use again   make it
    // eligible for a future idle release. It is also the moment the idle reaper
    // becomes worth running: there is now a project to release, and possibly a
    // harness restart waiting for this session to free the harness up.
    this.host.state.releasedProjects.delete(projectId)
    this.host.units['lifecycle-shutdown'].syncIdleReaper()
  }
}
