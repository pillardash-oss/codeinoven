import type {
  AgentAccountUsage,
  AgentAccountUsageOverrides,
  AgentArtifact,
  AgentContextCapabilities,
  AgentMessage,
  AgentModelSelection,
  AgentRunningProcess,
  AgentSecretSubmission,
  AgentSessionStatus,
  AgentToolCatalog,
  AssignmentPlan,
  AttachmentStorageScope,
  AuditGenerationRequest,
  AuditReport,
  BrainstormDocument,
  BrainstormEntryChoice,
  BrainstormPrototypeFidelity,
  EngineeringSpec,
  EngineeringSpecContent,
  HeartbeatConfig,
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  PendingAgentQuestionRequest,
  PermissionReply,
  PermissionRequest,
  PrdDocument,
  PromptAssignmentTaskReference,
  PromptAttachment,
  PromptProjectReference,
  PromptReference,
  ProviderCatalog,
  ScopedHarnessCommand,
  SpecActionIntent,
  SpecGenerationRequest,
  Thread,
  ThreadNote,
  ThreadSettings,
  UserMessagePresentation
} from '../types'
import type { Contract } from './contract-helpers'

export const invokeAgentContract = {
  'agent:chooseBrainstormEntry': {} as Contract<
    [projectId: string, threadId: string, choice: BrainstormEntryChoice],
    BrainstormDocument | EngineeringSpec | null
  >,
  'agent:reviewBrainstorm': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      note: string,
      prototypeRequest?: { fidelity: BrainstormPrototypeFidelity; count?: number }
    ],
    BrainstormDocument
  >,
  'agent:finalizeBrainstorm': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note?: string],
    EngineeringSpec | BrainstormDocument
  >,
  'agent:generatePrd': {} as Contract<
    [
      projectId: string,
      threadId: string,
      settings: ThreadSettings,
      instructions: string,
      attachments: PromptAttachment[],
      userMessageId: string
    ],
    PrdDocument
  >,
  'agent:abort': {} as Contract<[projectId: string, threadId: string], void>,
  'agent:compact': {} as Contract<[projectId: string, threadId: string], void>,
  'agent:answerQuestion': {} as Contract<
    [projectId: string, threadId: string, requestId: string, answers: string[][]],
    void
  >,
  'agent:answerSecret': {} as Contract<
    [projectId: string, threadId: string, requestId: string, secrets: AgentSecretSubmission[]],
    void
  >,
  'agent:answerSecretAlternative': {} as Contract<
    [projectId: string, threadId: string, requestId: string, alternative: string],
    void
  >,
  'agent:dismissQuestion': {} as Contract<
    [projectId: string, threadId: string, requestId: string],
    void
  >,
  'agent:ensureSession': {} as Contract<
    [projectId: string, threadId: string, requestedDriverId?: string],
    string
  >,
  'agent:ensureInitialSpec': {} as Contract<[projectId: string, threadId: string], EngineeringSpec>,
  'agent:getSessionStatus': {} as Contract<
    [projectId: string, threadId: string],
    AgentSessionStatus | null
  >,
  'agent:dismissSessionError': {} as Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >,
  'agent:getChildSessionStatus': {} as Contract<
    [projectId: string, threadId: string, sessionId: string],
    AgentSessionStatus | null
  >,
  'agent:retryChildSession': {} as Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >,
  'agent:retryAssignmentWorker': {} as Contract<
    [projectId: string, coordinatorThreadId: string, workerThreadId: string],
    AssignmentPlan
  >,
  /** Switch a not-reporting worker back on and ask it to report to the Sr. Engineer. */
  'agent:reportWorkerToCoordinator': {} as Contract<
    [projectId: string, coordinatorThreadId: string, workerThreadId: string],
    AssignmentPlan
  >,
  'agent:resumeAssignmentAttention': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >,
  'agent:abortChildSession': {} as Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >,
  'agent:generateSpec': {} as Contract<
    [projectId: string, threadId: string, request: SpecGenerationRequest],
    EngineeringSpecContent
  >,
  'agent:generateAudit': {} as Contract<
    [projectId: string, threadId: string, request: AuditGenerationRequest],
    AuditReport
  >,
  'agent:generateIndependentAudit': {} as Contract<
    [projectId: string, threadId: string, request: AuditGenerationRequest],
    { report: AuditReport; auditorThread: Thread }
  >,
  'agent:startFreshIndependentAudit': {} as Contract<
    [projectId: string, threadId: string, request: AuditGenerationRequest],
    { report: AuditReport; auditorThread: Thread }
  >,
  'agent:deleteIndependentAuditorThread': {} as Contract<
    [projectId: string, threadId: string],
    void
  >,
  'agent:ensureIndependentAuditorThread': {} as Contract<
    [projectId: string, threadId: string, settings: ThreadSettings],
    Thread
  >,
  'agent:ensureImplementationAuditorThread': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
  >,
  'agent:ensureAssignmentAuditorThread': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
  >,
  'agent:generateAssignmentAudit': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    { report: AuditReport; auditorThread: Thread }
  >,
  /** `instructions` carries the user's own request when no Spec exists, so the
   *  Assignment is decomposed from the message that triggered it. */
  'agent:generateAssignmentDraft': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      settings: ThreadSettings,
      instructions?: string
    ],
    AssignmentPlan
  >,
  'agent:ensureAchievementScope': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    Thread
  >,
  'agent:ensureAchievementAuditorThread': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
  >,
  'agent:generateAchievementAudit': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    { report: AuditReport; auditorThread: Thread }
  >,
  'agent:submitAchievementAuditFeedback': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      reportId: string,
      reportVersion: number,
      notes: string
    ],
    Thread
  >,
  'agent:returnAchievementAuditToOffer': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    Thread
  >,
  'agent:submitAssignmentAuditFeedback': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      reportId: string,
      reportVersion: number,
      notes: string
    ],
    AssignmentPlan
  >,
  'agent:startAssignment': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >,
  'agent:stopAssignment': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >,
  'agent:resumeAssignment': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >,
  'agent:listCommands': {} as Contract<
    [projectId: string, threadId: string, harnessId?: string],
    ScopedHarnessCommand[]
  >,
  'agent:listQuestions': {} as Contract<
    [projectId: string, threadId: string],
    PendingAgentQuestionRequest[]
  >,
  'agent:updateQuestion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      requestId: string,
      questionIndex: number,
      answers: string[],
      nextQuestionIndex?: number
    ],
    PendingAgentQuestionRequest
  >,
  'agent:listPermissions': {} as Contract<
    [projectId: string, threadId: string],
    PermissionRequest[]
  >,
  'agent:listProviders': {} as Contract<[projectId: string], ProviderCatalog[]>,
  'agent:listProviderSnapshot': {} as Contract<[projectId: string], ProviderCatalog[]>,
  'agent:refreshProviderCatalog': {} as Contract<
    [projectId: string, force?: boolean],
    ProviderCatalog[]
  >,
  'agent:refreshAccountUsage': {} as Contract<
    [overrides?: AgentAccountUsageOverrides],
    AgentAccountUsage[]
  >,
  /** Redeem one banked Codex rate-limit reset credit. Destructive: resets the
   *  account's active usage windows and consumes one banked credit. */
  'agent:activateBankedReset': {} as Contract<
    [projectId: string, threadId: string],
    AgentAccountUsage | null
  >,
  'agent:getHarnessAuthStatus': {} as Contract<
    [projectId: string, harnessId: string, accountId?: string],
    boolean | null
  >,
  'agent:listTools': {} as Contract<
    [
      projectId?: string,
      harnessId?: string,
      providerId?: string,
      modelId?: string,
      force?: boolean
    ],
    AgentToolCatalog
  >,
  'agent:listContextCapabilities': {} as Contract<
    [projectId: string, threadId: string, harnessId?: string],
    AgentContextCapabilities
  >,
  'agent:listArtifacts': {} as Contract<[projectId: string, threadId: string], AgentArtifact[]>,
  'agent:listProcesses': {} as Contract<
    [projectId: string, threadId: string],
    AgentRunningProcess[]
  >,
  'agent:killProcess': {} as Contract<[projectId: string, threadId: string, pid: number], void>,
  'agent:killThreadProcesses': {} as Contract<[projectId: string, threadId: string], void>,
  'agent:loadMessages': {} as Contract<
    [projectId: string, threadId: string, limit?: number],
    AgentMessage[]
  >,
  'agent:loadSessionMessages': {} as Contract<
    [projectId: string, threadId: string, sessionId: string],
    AgentMessage[]
  >,
  'agent:loadTemporaryChatMessages': {} as Contract<[temporaryChatId: string], AgentMessage[]>,
  'agent:replyPermission': {} as Contract<
    [projectId: string, requestId: string, reply: PermissionReply, alternative?: string],
    void
  >,
  'agent:listImageDescriptorErrors': {} as Contract<
    [projectId: string, threadId: string],
    ImageDescriptorErrorRequest[]
  >,
  'agent:replyImageDescriptor': {} as Contract<
    [
      projectId: string,
      threadId: string,
      requestId: string,
      action: ImageDescriptorReplyAction,
      selection?: AgentModelSelection,
      imagePath?: string
    ],
    void
  >,
  'agent:runCommand': {} as Contract<
    [projectId: string, threadId: string, commandId: string, args: string],
    void
  >,
  'agent:sendPrompt': {} as Contract<
    [
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
    ],
    AgentMessage
  >,
  'agent:steerPrompt': {} as Contract<
    [
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
    ],
    AgentMessage
  >,
  'agent:sendTemporaryPrompt': {} as Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      text: string,
      attachments: PromptAttachment[],
      references: PromptReference[],
      initialContext: string | undefined,
      userMessageId: string | undefined,
      displayText: string | undefined
    ],
    AgentMessage
  >,
  'agent:steerTemporaryPrompt': {} as Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      text: string,
      attachments: PromptAttachment[],
      references: PromptReference[],
      userMessageId: string | undefined,
      displayText: string | undefined
    ],
    void
  >,
  'agent:closeTemporaryChat': {} as Contract<[temporaryChatId: string], void>,
  'agent:abortTemporaryChat': {} as Contract<
    [projectId: string, threadId: string, temporaryChatId: string],
    void
  >,
  'agent:getTemporaryChatStatus': {} as Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >,
  'agent:touchTemporaryChat': {} as Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >,
  'agent:truncateMessages': {} as Contract<
    [projectId: string, threadId: string, messageId: string],
    AgentMessage[]
  >,
  /**
   * Delete history around a message. `down` keeps only the messages before it
   * (truncate semantics). `single` removes the message and its turn's work
   * trace, splicing earlier and later messages together. `up` removes the
   * message and everything before it, keeping later messages.
   */
  'agent:deleteMessages': {} as Contract<
    [projectId: string, threadId: string, messageId: string, mode: 'down' | 'single' | 'up'],
    AgentMessage[]
  >,
  /** Delete history around a message inside a temporary side chat. Same mode
   *  semantics as `agent:deleteMessages`; the isolated harness session is
   *  replaced so the removed span can never reappear. */
  'agent:deleteTemporaryMessages': {} as Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      messageId: string,
      mode: 'down' | 'single' | 'up'
    ],
    AgentMessage[]
  >,
  'agent:discardSteer': {} as Contract<
    [projectId: string, threadId: string, messageId: string],
    void
  >,
  'attachment:saveText': {} as Contract<
    [scope: AttachmentStorageScope, text: string, existingPath?: string],
    string
  >,
  'heartbeat:list': {} as Contract<[], HeartbeatConfig[]>,
  'heartbeat:create': {} as Contract<
    [input: Omit<HeartbeatConfig, 'id' | 'lastRun'>],
    HeartbeatConfig
  >,
  'heartbeat:update': {} as Contract<
    [id: string, patch: Partial<Omit<HeartbeatConfig, 'id'>>],
    HeartbeatConfig
  >,
  'heartbeat:trigger': {} as Contract<[id: string], void>,
  'heartbeat:delete': {} as Contract<[id: string], boolean>,
  'heartbeat:toggle': {} as Contract<[id: string, enabled: boolean], HeartbeatConfig>,
  'note:get': {} as Contract<[projectId: string, threadId: string], ThreadNote | null>,
  'note:save': {} as Contract<[projectId: string, threadId: string, body: string], ThreadNote>,
  'note:delete': {} as Contract<[projectId: string, threadId: string], void>,
  /** Thread ids that currently have a note (renderer presence sync). */
  'note:list': {} as Contract<[], string[]>
}
