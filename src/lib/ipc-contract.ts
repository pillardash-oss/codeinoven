import type {
  AgentMessage,
  AgentModelSelection,
  AgentRole,
  AgentSessionStatus,
  AssignmentModelSelection,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentProvenance,
  AssignmentValidationResult,
  AuditGenerationRequest,
  AuditReport,
  AuditReportContent,
  AuditSectionId,
  AgentToolCatalog,
  AgentContextCapabilities,
  AgentCapabilitySource,
  NativeMcpContent,
  NativeSkillContent,
  AppConfig,
  AppConfigPatch,
  BaseUrlProvider,
  BaseUrlProviderCopyClipboardRequest,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderUpdateRequest,
  BrainstormContent,
  BrainstormDecisionAction,
  BrainstormDocument,
  BrainstormEntryChoice,
  BrainstormProvenance,
  BrainstormSectionId,
  BrainstormWorkflowState,
  CapturableSpecContextType,
  Checklist,
  ChecklistItem,
  CreateProjectInput,
  CreateThreadInput,
  EditorId,
  EditorInfo,
  EngineeringSpec,
  EngineeringSpecContent,
  ScopedHarnessCommand,
  HistoryEntry,
  HistoryRole,
  PermissionRequest,
  PermissionReply,
  PendingAgentQuestionRequest,
  Plan,
  Project,
  ProjectFileEntry,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  ProviderAccountAuthStatus,
  ProviderAccountLoginHandoff,
  ProviderAccountLoginOptions,
  ProviderCatalog,
  ProviderConnectionInfo,
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  HarnessInstallInfo,
  HarnessUninstallHandoff,
  OfferedProvider,
  RepositoryPreflightResult,
  ScopeBoard,
  ScopeSlice,
  SpecContextReference,
  SpecDecisionAction,
  SpecActionIntent,
  UserMessagePresentation,
  SpecGenerationRequest,
  SpecProvenance,
  SpecSectionId,
  SpecValidationIssue,
  SpecValidationResult,
  Thread,
  ThreadMessageCursor,
  ThreadMessagePage,
  ThreadSettings,
  ThreadStatus,
  TurnCheckpointFileDiff,
  TurnCheckpointSummary,
  UtilityCatalog,
  UtilityBundleInstallRequest,
  UtilityCredentialInput,
  UtilityDefinition,
  UtilityDefinitionInput,
  UtilityDefinitionPatch,
  UtilityResolutionContext,
  UtilitySearchOptions,
  ResolvedUtility,
  CuaBridgeStatus,
  ComputerUsePipFrame,
  ComputerUsePipState
} from './types'
import type { WorkerNameSettings } from './assignment/worker-names'

type Contract<Args extends unknown[], Result> = {
  args: Args
  result: Result
}

type NewSpecProvenance = Omit<SpecProvenance, 'createdAt' | 'parentVersion'>
type NewBrainstormProvenance = Omit<BrainstormProvenance, 'createdAt' | 'parentVersion'>
type NewAssignmentProvenance = Omit<AssignmentProvenance, 'createdAt' | 'parentVersion'>

/**
 * Compile-time contract for every renderer-invokable main-process operation.
 * Runtime handlers still validate untrusted values at the IPC boundary.
 */
export interface UpdaterStatus {
  canAutoUpdate: boolean
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'waiting'
  currentVersion?: string
  availableVersion?: string
  downloadProgress?: number
  errorMessage?: string
}

export interface IpcInvokeContract {
  'brainstorm:ensureWorkflow': Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState
  >
  'brainstorm:getWorkflow': Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState | null
  >
  'brainstorm:chooseEntry': Contract<
    [projectId: string, threadId: string, choice: BrainstormEntryChoice],
    BrainstormWorkflowState
  >
  'brainstorm:getActive': Contract<[projectId: string, threadId: string], BrainstormDocument | null>
  'brainstorm:listVersions': Contract<
    [projectId: string, threadId: string, brainstormId: string],
    BrainstormDocument[]
  >
  'brainstorm:createDraft': Contract<
    [
      projectId: string,
      threadId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >
  'brainstorm:saveDraft': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      content: BrainstormContent
    ],
    BrainstormDocument
  >
  'brainstorm:createVersion': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >
  'brainstorm:addAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      input: {
        section: BrainstormSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    BrainstormDocument
  >
  'brainstorm:updateAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    BrainstormDocument
  >
  'brainstorm:resolveAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string
    ],
    BrainstormDocument
  >
  'brainstorm:addDecisionComment': Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      action: BrainstormDecisionAction,
      body: string
    ],
    BrainstormDocument
  >
  'brainstorm:finalize': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note?: string],
    BrainstormDocument
  >
  'agent:chooseBrainstormEntry': Contract<
    [projectId: string, threadId: string, choice: BrainstormEntryChoice],
    BrainstormDocument | EngineeringSpec | null
  >
  'agent:reviewBrainstorm': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note: string],
    BrainstormDocument
  >
  'agent:finalizeBrainstorm': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note: string],
    EngineeringSpec
  >
  'assignment:getActive': Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan | null
  >
  'assignment:listVersions': Contract<
    [projectId: string, coordinatorThreadId: string, assignmentId: string],
    AssignmentPlan[]
  >
  'assignment:saveDraft': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      content: AssignmentPlanContent,
      provenance: NewAssignmentProvenance
    ],
    AssignmentPlan
  >
  'assignment:addAnnotation': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      input: {
        section: string
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    AssignmentPlan
  >
  'assignment:updateAnnotation': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AssignmentPlan
  >
  'assignment:resolveAnnotation': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string
    ],
    AssignmentPlan
  >
  'assignment:updateUnlinkedWorkerModel': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      taskId: string,
      model: AssignmentModelSelection
    ],
    AssignmentPlan
  >
  'assignment:validate': Contract<[content: AssignmentPlanContent], AssignmentValidationResult>
  'assignment:openInEditor': Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >
  'assignment:revealInFiles': Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >
  'agent:abort': Contract<[projectId: string, threadId: string], void>
  'memory:getLayers': Contract<
    [projectId: string, threadId: string],
    import('./types').BehaviorLayer[]
  >
  'memory:getRaw': Contract<[projectId?: string, threadId?: string], string>
  'memory:saveRaw': Contract<[markdown: string, projectId?: string, threadId?: string], void>
  'memory:getEntries': Contract<
    [projectId?: string, threadId?: string],
    import('./types').MemoryEntry[]
  >
  'memory:saveEntries': Contract<
    [entries: import('./types').MemoryEntry[], projectId?: string, threadId?: string],
    void
  >
  'memory:getMergedEntries': Contract<[projectId: string], import('./types').MemoryEntry[]>
  'memory:addEntry': Contract<
    [
      label: string,
      content: string,
      options?: {
        category?: import('./types').MemoryCategory
        priority?: import('./types').MemoryPriority
        scope?: import('./types').MemoryScope
        source?: import('./types').MemorySource
        projectId?: string
        threadId?: string
      }
    ],
    import('./types').MemoryEntry
  >
  'memory:removeEntry': Contract<[entryId: string, projectId?: string, threadId?: string], boolean>
  'memory:searchEntries': Contract<
    [
      query: string,
      options?: {
        category?: import('./types').MemoryCategory
        priority?: import('./types').MemoryPriority
        projectId?: string
      }
    ],
    import('./types').MemoryEntry[]
  >
  'memory:getPendingProposals': Contract<[projectId?: string], import('./types').MemoryProposal[]>
  'memory:approveProposal': Contract<
    [proposalId: string, projectId?: string],
    import('./types').MemoryEntry | null
  >
  'memory:rejectProposal': Contract<[proposalId: string, projectId?: string], boolean>
  'memory:createProposal': Contract<
    [
      label: string,
      content: string,
      options?: {
        category?: import('./types').MemoryCategory
        priority?: import('./types').MemoryPriority
        scope?: import('./types').MemoryScope
        projectId?: string
        threadId?: string
      }
    ],
    import('./types').MemoryProposal
  >
  'agent:compact': Contract<[projectId: string, threadId: string], void>
  'agent:answerQuestion': Contract<
    [projectId: string, threadId: string, requestId: string, answers: string[][]],
    void
  >
  'agent:dismissQuestion': Contract<[projectId: string, threadId: string, requestId: string], void>
  'agent:ensureSession': Contract<
    [projectId: string, threadId: string, requestedDriverId?: string],
    string
  >
  'agent:ensureInitialSpec': Contract<[projectId: string, threadId: string], EngineeringSpec>
  'agent:getSessionStatus': Contract<
    [projectId: string, threadId: string],
    AgentSessionStatus | null
  >
  'agent:generateSpec': Contract<
    [projectId: string, threadId: string, request: SpecGenerationRequest],
    EngineeringSpecContent
  >
  'agent:generateAudit': Contract<
    [projectId: string, threadId: string, request: AuditGenerationRequest],
    AuditReport
  >
  'agent:ensureAssignmentAuditorThread': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
  >
  'agent:generateAssignmentAudit': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    { report: AuditReport; auditorThread: Thread }
  >
  'agent:generateAssignmentDraft': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    AssignmentPlan
  >
  'agent:ensureAchievementScope': Contract<[projectId: string, coordinatorThreadId: string], Thread>
  'agent:ensureAchievementAuditorThread': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
  >
  'agent:generateAchievementAudit': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    { report: AuditReport; auditorThread: Thread }
  >
  'agent:submitAchievementAuditFeedback': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      reportId: string,
      reportVersion: number,
      notes: string
    ],
    Thread
  >
  'agent:returnAchievementAuditToOffer': Contract<
    [projectId: string, coordinatorThreadId: string],
    Thread
  >
  'agent:submitAssignmentAuditFeedback': Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      reportId: string,
      reportVersion: number,
      notes: string
    ],
    AssignmentPlan
  >
  'agent:startAssignment': Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >
  'agent:listCommands': Contract<[projectId: string, threadId: string], ScopedHarnessCommand[]>
  'agent:listQuestions': Contract<
    [projectId: string, threadId: string],
    PendingAgentQuestionRequest[]
  >
  'agent:updateQuestion': Contract<
    [
      projectId: string,
      threadId: string,
      requestId: string,
      questionIndex: number,
      answers: string[],
      nextQuestionIndex?: number
    ],
    PendingAgentQuestionRequest
  >
  'agent:listPermissions': Contract<[projectId: string, threadId: string], PermissionRequest[]>
  'agent:listProviders': Contract<[projectId: string], ProviderCatalog[]>
  'agent:listProviderSnapshot': Contract<[projectId: string], ProviderCatalog[]>
  'agent:refreshProviderCatalog': Contract<[projectId: string], ProviderCatalog[]>
  'agent:listTools': Contract<
    [projectId?: string, harnessId?: string, providerId?: string, modelId?: string],
    AgentToolCatalog
  >
  'agent:listContextCapabilities': Contract<
    [projectId: string, threadId: string],
    AgentContextCapabilities
  >
  'capabilities:readSkill': Contract<[source: AgentCapabilitySource], NativeSkillContent | null>
  'capabilities:updateSkill': Contract<
    [source: AgentCapabilitySource, instructions: string],
    boolean
  >
  'capabilities:deleteSkill': Contract<[source: AgentCapabilitySource], boolean>
  'capabilities:readMcp': Contract<[source: AgentCapabilitySource], NativeMcpContent | null>
  'capabilities:updateMcp': Contract<
    [source: AgentCapabilitySource, content: NativeMcpContent],
    boolean
  >
  'capabilities:deleteMcp': Contract<[source: AgentCapabilitySource], boolean>
  'agent:loadMessages': Contract<
    [projectId: string, threadId: string, limit?: number],
    AgentMessage[]
  >
  'agent:loadSessionMessages': Contract<
    [projectId: string, threadId: string, sessionId: string],
    AgentMessage[]
  >
  'agent:loadTemporaryChatMessages': Contract<[temporaryChatId: string], AgentMessage[]>
  'agent:replyPermission': Contract<
    [projectId: string, requestId: string, reply: PermissionReply, alternative?: string],
    void
  >
  'agent:runCommand': Contract<
    [projectId: string, threadId: string, command: string, args: string],
    void
  >
  'agent:sendPrompt': Contract<
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
  >
  'agent:steerPrompt': Contract<
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
  >
  'agent:sendTemporaryPrompt': Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      text: string,
      attachments: PromptAttachment[],
      selection: string | undefined,
      initialContext: string | undefined
    ],
    AgentMessage
  >
  'agent:closeTemporaryChat': Contract<[temporaryChatId: string], void>
  'agent:getTemporaryChatStatus': Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >
  'agent:ensureAuditSession': Contract<
    [projectId: string, threadId: string, temporaryChatId: string, settings: ThreadSettings],
    { sessionId: string; expiresAt: number }
  >
  'agent:touchTemporaryChat': Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >
  'agent:truncateMessages': Contract<
    [projectId: string, threadId: string, messageId: string],
    AgentMessage[]
  >
  'checklist:generate': Contract<
    [projectId: string, threadId: string, planContent: string],
    Checklist
  >
  'checklist:get': Contract<[projectId: string, threadId: string], Checklist | null>
  'checklist:updateItem': Contract<
    [
      projectId: string,
      threadId: string,
      itemId: string,
      status: ChecklistItem['status'],
      evidence?: string
    ],
    Checklist | null
  >
  'checkpoint:list': Contract<[projectId: string, threadId: string], TurnCheckpointSummary[]>
  'checkpoint:diff': Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >
  'checkpoint:rollback': Contract<
    [projectId: string, threadId: string, checkpointId: string],
    TurnCheckpointSummary[]
  >
  'checkpoint:rollbackPaths': Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >
  'config:get': Contract<[], AppConfig>
  'config:update': Contract<[patch: AppConfigPatch], AppConfig>
  'config:syncAgentRole': Contract<[role: AgentRole, selection: AgentModelSelection], AppConfig>
  'workerNames:getSettings': Contract<[], WorkerNameSettings>
  'workerNames:saveCustom': Contract<[names: string[]], void>
  'dialog:pickFolder': Contract<[], string | null>
  'clipboard:saveImage': Contract<[], string | null>
  'clipboard:writeText': Contract<[text: string], void>
  'clipboard:readText': Contract<[], string>
  'dialog:pickFile': Contract<[], string | null>
  'dialog:pickImage': Contract<[], string | null>
  'diagnostics:export': Contract<[], string | null>
  'file:readAsDataUrl': Contract<[filePath: string], string | null>
  'editors:detect': Contract<[], EditorInfo[]>
  'editors:getPreferred': Contract<[], EditorId>
  'editors:setPreferred': Contract<[editorId: EditorId], void>
  'history:search': Contract<[query: string, projectId?: string, limit?: number], HistoryEntry[]>
  'project:search': Contract<[query: string, limit?: number], Project[]>
  'threads:search': Contract<
    [query: string, options?: { projectId?: string; limit?: number }],
    import('./types').ThreadSearchResult[]
  >
  'history:append': Contract<
    [
      projectId: string,
      threadId: string,
      role: HistoryRole,
      content: string,
      metadata?: HistoryEntry['metadata']
    ],
    HistoryEntry
  >
  'scope:get': Contract<[projectId: string], ScopeBoard>
  'scope:save': Contract<[projectId: string, board: ScopeBoard], ScopeBoard>
  'history:load': Contract<[projectId: string, threadId: string, limit?: number], HistoryEntry[]>
  'notification:test': Contract<[], SystemNotificationTestResult>
  'plan:approve': Contract<[projectId: string, threadId: string], Plan | null>
  'plan:get': Contract<[projectId: string, threadId: string], Plan | null>
  'plan:save': Contract<[projectId: string, threadId: string, content: string], Plan>
  'project:create': Contract<[input: CreateProjectInput], Project>
  'project:delete': Contract<[projectId: string], void>
  'project:ensureInbox': Contract<[], Project>
  'project:get': Contract<[projectId: string], Project | null>
  'project:getIcon': Contract<[projectId: string], string | null>
  'project:list': Contract<[], Project[]>
  'project:openInEditor': Contract<[projectId: string], void>
  'project:reorder': Contract<[orderedIds: string[]], Project[]>
  'project:setPinned': Contract<[projectId: string, pinned: boolean], Project>
  'project:setIcon': Contract<[projectId: string, sourcePath: string], Project>
  'project:clearIcon': Contract<[projectId: string], Project>
  'project:update': Contract<[projectId: string, input: Partial<CreateProjectInput>], Project>
  'projectFiles:list': Contract<[projectId: string, relativeDirectory: string], ProjectFileEntry[]>
  'projectFiles:search': Contract<
    [projectId: string, query: string, category: 'all' | 'rules'],
    ProjectFileEntry[]
  >
  'projectFiles:resolveCitationPaths': Contract<
    [projectId: string, candidates: string[]],
    Record<string, string | null>
  >
  'projectFiles:create': Contract<
    [projectId: string, relativeDirectory: string, name: string],
    ProjectFileEntry
  >
  'projectFiles:delete': Contract<[projectId: string, relativePath: string], void>
  'projectFiles:info': Contract<[projectId: string, relativePath: string], ProjectFileInfo>
  'projectFiles:openInEditor': Contract<[projectId: string, relativePath: string], void>
  'projectFiles:paste': Contract<
    [
      sourceProjectId: string,
      sourcePath: string,
      destinationProjectId: string,
      destinationDirectory: string,
      mode: ProjectFileTransferMode
    ],
    ProjectFileEntry
  >
  'projectFiles:importPaths': Contract<
    [projectId: string, sourcePaths: string[], destinationDirectory: string],
    ProjectFileEntry[]
  >
  'projectFiles:read': Contract<[projectId: string, relativePath: string], ProjectTextFile>
  'projectFiles:rename': Contract<
    [projectId: string, relativePath: string, name: string],
    ProjectFileEntry
  >
  'projectFiles:save': Contract<
    [projectId: string, relativePath: string, content: string, expectedRevision: string],
    ProjectTextFile
  >
  'providers:check': Contract<[providerId: string], ProviderConnectionInfo>
  'providers:checkAll': Contract<[], ProviderConnectionInfo[]>
  'providers:getStatus': Contract<[], ProviderConnectionInfo[]>
  'harnessUpdates:check': Contract<[harnessId: string], HarnessUpdateStatus>
  'harnessUpdates:checkAll': Contract<[], HarnessUpdateStatus[]>
  'harnessUpdates:handoff': Contract<[harnessId: string], HarnessUpdateHandoff>
  'harnessInstall:getInfo': Contract<[harnessId: string], HarnessInstallInfo>
  'harnessUninstall:handoff': Contract<[harnessId: string], HarnessUninstallHandoff>
  'providerAccounts:getAuthStatus': Contract<
    [harnessId: string, projectPath?: string],
    ProviderAccountAuthStatus
  >
  'providerAccounts:beginLogin': Contract<
    [harnessId: string, options?: ProviderAccountLoginOptions],
    ProviderAccountLoginHandoff
  >
  'providerAccounts:listOffered': Contract<[harnessId: string], OfferedProvider[]>
  'providerAccounts:logout': Contract<[harnessId: string, providerId?: string], void>
  'providerAccounts:getHidden': Contract<[harnessId: string], string[]>
  'providerAccounts:setHidden': Contract<
    [harnessId: string, providerId: string, hidden: boolean],
    string[]
  >
  'baseUrlProviders:list': Contract<[], BaseUrlProvider[]>
  'baseUrlProviders:create': Contract<[input: BaseUrlProviderCreateRequest], BaseUrlProvider>
  'baseUrlProviders:update': Contract<
    [harnessId: string, id: string, patch: BaseUrlProviderUpdateRequest],
    BaseUrlProvider
  >
  'baseUrlProviders:delete': Contract<[harnessId: string, id: string], boolean>
  'baseUrlProviders:copyProviderToClipboard': Contract<
    [input: BaseUrlProviderCopyClipboardRequest],
    void
  >
  'utilities:list': Contract<[options?: UtilitySearchOptions], UtilityCatalog>
  'utilities:get': Contract<[id: string], UtilityDefinition | null>
  'utilities:create': Contract<[input: UtilityDefinitionInput], UtilityDefinition>
  'utilities:installBundle': Contract<[request: UtilityBundleInstallRequest], UtilityDefinition[]>
  'utilities:update': Contract<[id: string, patch: UtilityDefinitionPatch], UtilityDefinition>
  'utilities:delete': Contract<[id: string], boolean>
  'utilities:setCredential': Contract<
    [utilityId: string, input: UtilityCredentialInput],
    UtilityDefinition
  >
  'utilities:removeCredential': Contract<
    [utilityId: string, credentialId: string],
    UtilityDefinition
  >
  'utilities:resolve': Contract<[context: UtilityResolutionContext], ResolvedUtility[]>
  'computerUse:getCuaStatus': Contract<[], CuaBridgeStatus>
  'computerUse:setCuaEnabled': Contract<[enabled: boolean], CuaBridgeStatus>
  'computerUse:pipGetState': Contract<[], ComputerUsePipState>
  'computerUse:pipBringToFront': Contract<[], void>
  'computerUse:pipDismiss': Contract<[], void>
  'pty:create': Contract<
    [id: string, projectId: string, columns: number, rows: number],
    { id: string; pid: number }
  >
  'pty:createCommand': Contract<
    [id: string, command: string, args: string[], columns: number, rows: number],
    { id: string; pid: number }
  >
  'pty:destroy': Contract<[id: string], void>
  'repository:init': Contract<[projectPath: string], RepositoryPreflightResult>
  'repository:preflight': Contract<[projectPath: string], RepositoryPreflightResult>
  'shell:openExternal': Contract<[url: string], void>
  'shell:revealPath': Contract<[path: string], boolean>
  'spec:addAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      input: {
        section: SpecSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    EngineeringSpec
  >
  'spec:addDecisionComment': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      action: SpecDecisionAction,
      body: string
    ],
    EngineeringSpec
  >
  'spec:approve': Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >
  'spec:captureContext': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      type: CapturableSpecContextType,
      selectedPath?: string
    ],
    EngineeringSpec | null
  >
  'spec:createDraft': Contract<
    [
      projectId: string,
      threadId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >
  'spec:createVersion': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >
  'spec:dismissValidationIssue': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      issue: SpecValidationIssue
    ],
    EngineeringSpec
  >
  'spec:exportMarkdown': Contract<[spec: EngineeringSpec], string | null>
  'spec:getActive': Contract<[projectId: string, threadId: string], EngineeringSpec | null>
  'spec:getContextAttachments': Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    PromptAttachment[]
  >
  'spec:importMarkdown': Contract<
    [projectId: string, threadId: string, specId?: string],
    EngineeringSpec | null
  >
  'spec:listVersions': Contract<
    [projectId: string, threadId: string, specId: string],
    EngineeringSpec[]
  >
  'spec:openInEditor': Contract<[spec: EngineeringSpec], string>
  'spec:revealInFiles': Contract<[spec: EngineeringSpec], string>
  'spec:resolveAnnotation': Contract<
    [projectId: string, threadId: string, specId: string, version: number, annotationId: string],
    EngineeringSpec
  >
  'spec:updateAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    EngineeringSpec
  >
  'spec:saveDraft': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      content: EngineeringSpecContent
    ],
    EngineeringSpec
  >
  'spec:setContext': Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      context: SpecContextReference[]
    ],
    EngineeringSpec
  >
  'spec:setReview': Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >
  'spec:validate': Contract<[spec: EngineeringSpec], SpecValidationResult>
  'audit:getActive': Contract<[projectId: string, threadId: string], AuditReport | null>
  'audit:listVersions': Contract<
    [projectId: string, threadId: string, reportId: string],
    AuditReport[]
  >
  'audit:save': Contract<[report: AuditReport, content: AuditReportContent], AuditReport>
  'audit:addAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      reportId: string,
      version: number,
      input: {
        section: AuditSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    AuditReport
  >
  'audit:updateAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      reportId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AuditReport
  >
  'audit:resolveAnnotation': Contract<
    [projectId: string, threadId: string, reportId: string, version: number, annotationId: string],
    AuditReport
  >
  'audit:complete': Contract<[projectId: string, threadId: string], Thread>
  'audit:beginRework': Contract<[projectId: string, threadId: string], Thread>
  'audit:returnToOffer': Contract<[projectId: string, threadId: string], AssignmentPlan>
  'thread:create': Contract<[input: CreateThreadInput], Thread>
  'thread:delete': Contract<[projectId: string, threadId: string], void>
  'thread:dismissSpecReview': Contract<
    [projectId: string, threadId: string, specId: string, specVersion: number],
    Thread
  >
  'thread:fork': Contract<
    [projectId: string, threadId: string, title: string, checkpointId?: string, messageId?: string],
    Thread
  >
  'thread:get': Contract<[projectId: string, threadId: string], Thread | null>
  'thread:list': Contract<[projectId: string], Thread[]>
  'thread:listAll': Contract<[], Thread[]>
  'thread:reorder': Contract<[projectId: string, orderedIds: string[]], Thread[]>
  'thread:reorderScope': Contract<
    [projectId: string, bucketId: string, slice: ScopeSlice, orderedIds: string[]],
    Thread[]
  >
  'thread:loadMessages': Contract<
    [projectId: string, threadId: string, before?: ThreadMessageCursor, limit?: number],
    ThreadMessagePage
  >
  'thread:markRead': Contract<[projectId: string, threadId: string], Thread>
  'thread:setArchived': Contract<[projectId: string, threadId: string, archived: boolean], Thread>
  'thread:setPinned': Contract<[projectId: string, threadId: string, pinned: boolean], Thread>
  'thread:setStatus': Contract<[projectId: string, threadId: string, status: ThreadStatus], Thread>
  'thread:update': Contract<
    [
      projectId: string,
      threadId: string,
      input: Partial<
        Pick<
          Thread,
          | 'title'
          | 'titleSource'
          | 'providerId'
          | 'workingDirectory'
          | 'scopeBucketId'
          | 'lastActivity'
          | 'read'
        >
      >
    ],
    Thread
  >
  'thread:updateSettings': Contract<
    [projectId: string, threadId: string, settings: ThreadSettings],
    Thread
  >
  'updater:check': Contract<[], UpdaterStatus>
  'updater:getStatus': Contract<[], UpdaterStatus>
  'updater:download': Contract<[], void>
  'updater:install': Contract<[], void>
  'app:confirmClose': Contract<[], void>
}

export interface ThreadClickedPayload {
  projectId: string
  threadId: string
}

/** A project with at least one thread still being worked on. */
export interface CloseConfirmationProject {
  projectId: string
  projectName: string
  threadCount: number
}

/** Sent when the user tries to close the app while threads are still working. */
export interface CloseConfirmationPayload {
  projects: CloseConfirmationProject[]
}

export type AgentNotificationKind = 'completed' | 'attention' | 'error'

export interface AgentNotificationPayload extends ThreadClickedPayload {
  id: string
  kind: AgentNotificationKind
  title: string
  body: string
}

export type SystemNotificationTestResult =
  | { status: 'shown'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

export interface IpcEventContract {
  'agent:temporaryChatExpired': [temporaryChatId: string]
  'notification:playSound': []
  'notification:show': [payload: AgentNotificationPayload]
  'notification:threadClicked': [payload: ThreadClickedPayload]
  /** Emitted before the main process begins its shutdown disposal chain.
   *  The renderer should unsubscribe from IPC events and release resources. */
  'window:beforeQuit': []
  /** Emitted when the app is asked to close while threads are still working. */
  'window:confirmClose': [payload: CloseConfirmationPayload]
  'updater:status': [status: UpdaterStatus]
  'updater:waiting-for-threads': [activeCount: number]
  'computerUse:pipFrame': [frame: ComputerUsePipFrame]
  'computerUse:pipState': [state: ComputerUsePipState]
}

export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['args']
export type InvokeResult<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['result']
export type EventArgs<Channel extends keyof IpcEventContract> = IpcEventContract[Channel]
