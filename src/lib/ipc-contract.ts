import type {
  AgentArtifact,
  AgentMessage,
  AgentModelSelection,
  AgentRole,
  AgentSessionStatus,
  AgentRunningProcess,
  TaskManagerProcess,
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
  AgentCapabilityCatalog,
  AgentCapabilitySource,
  NativeMcpContent,
  NativeSkillContent,
  AppConfig,
  AppConfigPatch,
  VisionModelRecord,
  BaseUrlProvider,
  BaseUrlProviderCopyClipboardRequest,
  BaseUrlProviderCreateRequest,
  BaseUrlProviderFetchModelsRequest,
  BaseUrlProviderUpdateRequest,
  DiscoveredBaseUrlModel,
  BrainstormContent,
  BrainstormDecisionAction,
  BrainstormPrototypeFidelity,
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
  EngineeringLifecycleDecision,
  EngineeringLifecycleState,
  EngineeringLifecycleTransitionResult,
  ScopedHarnessCommand,
  HeartbeatConfig,
  HistoryEntry,
  HistoryRole,
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  PermissionRequest,
  PermissionReply,
  PendingAgentQuestionRequest,
  Plan,
  Project,
  ProjectFileEntry,
  ProjectFileDropResult,
  ProjectFileInfo,
  ProjectFileTransferMode,
  ProjectTextFile,
  GitBranchInfo,
  GitCommitInfo,
  GitConflictAnalysis,
  GitConflictWorkFile,
  GitCredentialStatus,
  GitDiff,
  GitFileChange,
  GitHubAuthStatus,
  GitHubDeviceCode,
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverviewResult,
  GitHubPollResult,
  GitHubMutationResult,
  GitHubWorkflowRunDetail,
  GitIdentity,
  GitIdentityInput,
  GitRemoteInfo,
  GitStatus,
  GitStashEntry,
  HarnessUsage,
  MergeSummary,
  PrCreateInput,
  PrAgentReport,
  PrComposeReport,
  PrMergeMethod,
  PrReviewEvent,
  PrResolveOptions,
  PrState,
  PullRequestBundle,
  PullRequestComment,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestFile,
  PullRequestPage,
  PullRequestReference,
  PullRequestReviewResult,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  PrdContent,
  PrdDocument,
  PrdEntryChoice,
  PrdProvenance,
  PrdSectionId,
  PrdWorkflowState,
  ProviderAccountAuthStatus,
  ProviderAccountLoginHandoff,
  ProviderAccountLoginOptions,
  ProviderCatalog,
  ProviderConnectionInfo,
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  HarnessInstallInfo,
  HarnessManifestEntry,
  HarnessUninstallHandoff,
  OfferedProvider,
  AdoptableWorktreeInfo,
  RepositoryPreflightResult,
  ScopeBoard,
  ScopeBucket,
  ScopeAppearancePatch,
  ScopeCollapsePatch,
  ScopeCreateInput,
  ScopeLifecycleAction,
  ScopeLifecyclePreflight,
  ScopeMergeMode,
  ScopeMergeOutcome,
  ScopeMergePreflight,
  ScopeTarget,
  ScopeWorktreeCreateInput,
  ScopeWorktreeDefaults,
  ScopeWorktreeHealth,
  ScopeWorktreeSourceInfo,
  ManagedWorktreeDescriptor,
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
  ThreadContextUsage,
  AgentAccountUsage,
  AttachmentStorageScope,
  ThreadMessageCursor,
  ThreadMessagePage,
  UserMessageSummary,
  ThreadNote,
  ThreadSettings,
  ThreadStatus,
  UsageEfficiencyKpis,
  TurnCheckpointFileDiff,
  TurnCheckpointSummary,
  UtilityCatalog,
  UtilityBundleInstallRequest,
  UtilityCredentialInput,
  UtilityDefinition,
  UtilityDefinitionInput,
  UtilityDefinitionPatch,
  UtilitySetupReport,
  UtilityResolutionContext,
  UtilitySearchOptions,
  ResolvedUtility,
  SkillMarketDetail,
  SkillMarketInstallRequest,
  SkillMarketLeaderboard,
  SkillMarketSearchResult,
  SkillMarketView,
  CuaBridgeStatus,
  ComputerUsePipFrame,
  ComputerUsePipState
} from './types'
import type { WorkerNameSettings } from './assignment/worker-names'
import type { CioPromptId, CioPromptSetting } from './cio-prompts'

type Contract<Args extends unknown[], Result> = {
  args: Args
  result: Result
}

type NewSpecProvenance = Omit<SpecProvenance, 'createdAt' | 'parentVersion'>
type NewBrainstormProvenance = Omit<BrainstormProvenance, 'createdAt' | 'parentVersion'>
type NewPrdProvenance = Omit<PrdProvenance, 'createdAt' | 'parentVersion'>
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

/** Native browser content rectangle in BrowserWindow density-independent pixels. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Navigation state mirrored from an app-scoped browser WebContentsView. */
export interface BrowserPageState {
  tabId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** One row rendered by the native Ctrl+Tab overlay, fully display-ready. */
export interface NativeSwitcherThread {
  id: string
  title: string
  projectId: string
  /** Project icon as a data URL, or null for a fallback mark. */
  icon: string | null
  selected: boolean
}

export type NativeSwitcherTheme = 'light' | 'dark'

/**
 * Display payload for the native Ctrl+Tab overlay. The renderer resolves the
 * visible thread list, highlighting, and theme; the overlay only renders the
 * rows and reports input back through the main process.
 */
export interface NativeSwitcherPayload {
  threads: NativeSwitcherThread[]
  highlightedThreadId: string | null
  theme: NativeSwitcherTheme
  /** Width/height (density-independent px) hint for the dialog, unused by the
   *  full-window overlay page but kept for future sizing. */
  windowHeight: number
}

/** Ownership metadata for a browser tab requested by the main process. */
export interface BrowserOpenRequestContext {
  projectId: string
  threadId: string
  requestedTabId?: string
  reveal: boolean
}

/** A permission requested by a page inside the project-scoped browser session. */
export interface BrowserPermissionRequest {
  id: string
  tabId: string
  projectId: string
  origin: string
  permission: string
  mediaTypes: string[]
}

/**
 * How the user answered a browser permission prompt.
 * - `allow`: grant for this origin+permission for the app session (remembered).
 * - `allow-once`: grant only the request at hand; the next request re-prompts.
 * - `deny`: refuse and remember the denial so future requests auto-deny.
 * - `dismiss`: refuse only this request (e.g. closing the modal) without remembering.
 */
export type BrowserPermissionDecision = 'allow' | 'allow-once' | 'deny' | 'dismiss'

export type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error'

/** Where a renderer log line originated, for the durable log tag. */
export type RendererLogSource = 'error' | 'unhandledrejection' | 'console' | 'watchdog'

/** Renderer-level log levels forwarded to the main-process Logger. */
export type RendererLogLevel = 'dev' | 'info' | 'error'

/**
 * A renderer-originated log line forwarded to the main-process durable Logger.
 * Carries only the message/stack and origin label — no paths, user content, or
 * credentials; secrets are redacted by the main-process sink before write.
 */
export interface RendererLogEntry {
  level: RendererLogLevel
  message: string
  stack?: string
  source: RendererLogSource
  at: number
}

/** A console or runtime diagnostic emitted by one app-scoped browser tab. */
export interface BrowserConsoleEntry {
  id: string
  tabId: string
  level: BrowserConsoleLevel
  message: string
  sourceId: string
  lineNumber: number
  timestamp: number
}

/** Lifecycle state of a download started by an app-scoped browser tab. */
export type BrowserDownloadState = 'progressing' | 'interrupted' | 'completed' | 'cancelled'

/**
 * Metadata for a download started inside the app-scoped browser. Contains no
 * cookies, headers, or page content — only what the download manager needs to
 * render progress and offer cancel/pause/open/reveal actions.
 */
export interface BrowserDownload {
  id: string
  tabId: string
  projectId: string
  fileName: string
  url: string
  mimeType: string
  receivedBytes: number
  totalBytes: number
  speedBytes: number
  progress: number
  state: BrowserDownloadState
  paused: boolean
  savePath: string
  error: string
}

export interface IpcInvokeContract {
  'account:getLocalUsage': Contract<
    [range: import('./types').LocalProfileAnalyticsRange],
    import('./types').LocalProfileAnalytics
  >
  'account:getProfile': Contract<[], import('./types').AccountProfileState>
  'account:beginSignIn': Contract<
    [provider: import('./types').AccountAuthProvider],
    import('./types').AccountSignInStart
  >
  'account:syncProfile': Contract<[], import('./types').AccountProfileState>
  'account:signOut': Contract<[], void>
  'engineeringLifecycle:get': Contract<
    [projectId: string, threadId: string],
    EngineeringLifecycleState | null
  >
  'engineeringLifecycle:select': Contract<
    [
      projectId: string,
      threadId: string,
      input: import('./types').EngineeringLifecycleSelectionInput
    ],
    EngineeringLifecycleState
  >
  'engineeringLifecycle:start': Contract<
    [projectId: string, threadId: string, stage?: import('./types').EngineeringLifecycleStage],
    EngineeringLifecycleTransitionResult
  >
  'engineeringLifecycle:complete': Contract<
    [projectId: string, threadId: string, stage: import('./types').EngineeringLifecycleStage],
    EngineeringLifecycleState
  >
  'engineeringLifecycle:resume': Contract<
    [
      projectId: string,
      threadId: string,
      resumeToken: string,
      decision: EngineeringLifecycleDecision
    ],
    EngineeringLifecycleTransitionResult
  >
  'engineeringLifecycle:retry': Contract<
    [projectId: string, threadId: string, resumeToken: string],
    EngineeringLifecycleState
  >
  'engineeringLifecycle:cancel': Contract<
    [projectId: string, threadId: string, confirmed: true],
    EngineeringLifecycleState
  >
  'prd:ensureWorkflow': Contract<[projectId: string, threadId: string], PrdWorkflowState>
  'prd:getWorkflow': Contract<[projectId: string, threadId: string], PrdWorkflowState | null>
  'prd:chooseEntry': Contract<
    [projectId: string, threadId: string, choice: PrdEntryChoice],
    PrdWorkflowState
  >
  'prd:beginDrafting': Contract<[projectId: string, threadId: string], PrdWorkflowState>
  'prd:getActive': Contract<[projectId: string, threadId: string], PrdDocument | null>
  'prd:listVersions': Contract<[projectId: string, threadId: string, prdId: string], PrdDocument[]>
  'prd:createDraft': Contract<
    [projectId: string, threadId: string, content: PrdContent, provenance: NewPrdProvenance],
    PrdDocument
  >
  'prd:saveDraft': Contract<
    [projectId: string, threadId: string, prdId: string, version: number, content: PrdContent],
    PrdDocument
  >
  'prd:createVersion': Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      content: PrdContent,
      provenance: NewPrdProvenance
    ],
    PrdDocument
  >
  'prd:addAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      version: number,
      input: {
        section: PrdSectionId
        body: string
        author: string
        quote?: string
        startLine?: number
        endLine?: number
        startOffset?: number
        endOffset?: number
      }
    ],
    PrdDocument
  >
  'prd:updateAnnotation': Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    PrdDocument
  >
  'prd:resolveAnnotation': Contract<
    [projectId: string, threadId: string, prdId: string, version: number, annotationId: string],
    PrdDocument
  >
  'prd:finalize': Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    PrdDocument
  >
  'prd:openInEditor': Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >
  'prd:revealInFiles': Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >
  'prototypePreview:getOrigin': Contract<[], string | null>
  'prototypePreview:readChunk': Contract<
    [projectId: string, threadId: string, previewPath: string, offset: number],
    { base64: string; nextOffset: number; size: number; mime: string }
  >
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
  'brainstorm:resetWorkflow': Contract<[projectId: string, threadId: string], void>
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
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      note: string,
      prototypeRequest?: { fidelity: BrainstormPrototypeFidelity; count?: number }
    ],
    BrainstormDocument
  >
  'agent:finalizeBrainstorm': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note?: string],
    EngineeringSpec | BrainstormDocument
  >
  'agent:generatePrd': Contract<
    [
      projectId: string,
      threadId: string,
      settings: ThreadSettings,
      instructions: string,
      attachments: PromptAttachment[],
      userMessageId: string
    ],
    PrdDocument
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
        modelKeys?: string[]
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
        modelKeys?: string[]
        projectId?: string
        threadId?: string
      }
    ],
    import('./types').MemoryProposal
  >
  'memory:export': Contract<
    [kind: import('./types').MemoryExportKind, projectId?: string],
    string | null
  >
  'memory:import': Contract<[], import('./types').MemoryImportPreview | null>
  'memory:importApply': Contract<
    [
      preview: import('./types').MemoryImportPreview,
      kind: import('./types').MemoryExportKind,
      projectId?: string
    ],
    { added: number; skipped: number }
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
  'agent:dismissSessionError': Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >
  'agent:getChildSessionStatus': Contract<
    [projectId: string, threadId: string, sessionId: string],
    AgentSessionStatus | null
  >
  'agent:retryChildSession': Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >
  'agent:retryAssignmentWorker': Contract<
    [projectId: string, coordinatorThreadId: string, workerThreadId: string],
    AssignmentPlan
  >
  'agent:resumeAssignmentAttention': Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan
  >
  'agent:abortChildSession': Contract<
    [projectId: string, threadId: string, sessionId: string],
    void
  >
  'agent:generateSpec': Contract<
    [projectId: string, threadId: string, request: SpecGenerationRequest],
    EngineeringSpecContent
  >
  'agent:generateAudit': Contract<
    [projectId: string, threadId: string, request: AuditGenerationRequest],
    AuditReport
  >
  'agent:ensureImplementationAuditorThread': Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
    Thread
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
  'agent:stopAssignment': Contract<[projectId: string, coordinatorThreadId: string], AssignmentPlan>
  'agent:resumeAssignment': Contract<
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
  'agent:refreshProviderCatalog': Contract<[projectId: string, force?: boolean], ProviderCatalog[]>
  'agent:refreshAccountUsage': Contract<[projectId: string, threadId: string], AgentAccountUsage[]>
  'agent:getHarnessAuthStatus': Contract<[projectId: string, harnessId: string], boolean | null>
  'agent:listTools': Contract<
    [
      projectId?: string,
      harnessId?: string,
      providerId?: string,
      modelId?: string,
      force?: boolean
    ],
    AgentToolCatalog
  >
  'agent:listContextCapabilities': Contract<
    [projectId: string, threadId: string],
    AgentContextCapabilities
  >
  'agent:listArtifacts': Contract<[projectId: string, threadId: string], AgentArtifact[]>
  'agent:listProcesses': Contract<[projectId: string, threadId: string], AgentRunningProcess[]>
  'agent:killProcess': Contract<[projectId: string, threadId: string, pid: number], void>
  'agent:killThreadProcesses': Contract<[projectId: string, threadId: string], void>
  'taskManager:list': Contract<[], TaskManagerProcess[]>
  'taskManager:killProcess': Contract<[pid: number, force: boolean], void>
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
  'capabilities:listAll': Contract<[], AgentCapabilityCatalog>
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
  'agent:listImageDescriptorErrors': Contract<
    [projectId: string, threadId: string],
    ImageDescriptorErrorRequest[]
  >
  'agent:replyImageDescriptor': Contract<
    [
      projectId: string,
      threadId: string,
      requestId: string,
      action: ImageDescriptorReplyAction,
      selection?: AgentModelSelection,
      imagePath?: string
    ],
    void
  >
  'agent:runCommand': Contract<
    [projectId: string, threadId: string, commandId: string, args: string],
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
      references: PromptReference[],
      initialContext: string | undefined,
      userMessageId: string | undefined,
      displayText: string | undefined
    ],
    AgentMessage
  >
  'agent:steerTemporaryPrompt': Contract<
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
  >
  'agent:closeTemporaryChat': Contract<[temporaryChatId: string], void>
  'agent:abortTemporaryChat': Contract<
    [projectId: string, threadId: string, temporaryChatId: string],
    void
  >
  'agent:getTemporaryChatStatus': Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >
  'agent:touchTemporaryChat': Contract<
    [temporaryChatId: string],
    { active: boolean; expiresAt?: number }
  >
  'temporary-chat:convertToThread': Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      title?: string
    ],
    Thread
  >
  'agent:truncateMessages': Contract<
    [projectId: string, threadId: string, messageId: string],
    AgentMessage[]
  >
  /**
   * Delete history around a message. `down` keeps only the messages before it
   * (truncate semantics). `single` removes the message and its turn's work
   * trace, splicing earlier and later messages together. `up` removes the
   * message and everything before it, keeping later messages.
   */
  'agent:deleteMessages': Contract<
    [projectId: string, threadId: string, messageId: string, mode: 'down' | 'single' | 'up'],
    AgentMessage[]
  >
  'agent:discardSteer': Contract<[projectId: string, threadId: string, messageId: string], void>
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
  'checkpoint:activeSummary': Contract<
    [projectId: string, threadId: string],
    TurnCheckpointSummary | null
  >
  'checkpoint:liveDiff': Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >
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
  'checkpoint:redoPaths': Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >
  'config:get': Contract<[], AppConfig>
  'config:update': Contract<[patch: AppConfigPatch], AppConfig>
  'visionModels:list': Contract<[], VisionModelRecord[]>
  'config:syncAgentRole': Contract<[role: AgentRole, selection: AgentModelSelection], AppConfig>
  'cioPrompts:list': Contract<[], CioPromptSetting[]>
  'cioPrompts:save': Contract<[id: CioPromptId, template: string], CioPromptSetting[]>
  'cioPrompts:reset': Contract<[id: CioPromptId], CioPromptSetting[]>
  'workerNames:getSettings': Contract<[], WorkerNameSettings>
  'workerNames:saveCustom': Contract<[names: string[]], void>
  'dialog:pickFolder': Contract<[], string | null>
  'dialog:pickCloneDestination': Contract<[], string | null>
  'git:defaultClonePath': Contract<[url: string], string>
  'git:cloneHandoff': Contract<
    [input: { url: string; destination?: string }],
    { command: string; args: string[]; destination: string; repoName: string }
  >
  'clipboard:saveImage': Contract<[scope: AttachmentStorageScope], string | null>
  'attachment:saveText': Contract<
    [scope: AttachmentStorageScope, text: string, existingPath?: string],
    string
  >
  'attachment:beginRemoteUpload': Contract<
    [scope: AttachmentStorageScope, filename: string, size: number],
    string
  >
  'attachment:appendRemoteUpload': Contract<
    [uploadId: string, offset: number, base64Chunk: string],
    number
  >
  'attachment:finishRemoteUpload': Contract<[uploadId: string], string>
  'attachment:cancelRemoteUpload': Contract<[uploadId: string], void>
  'attachment:readRemoteChunk': Contract<
    [path: string, offset: number],
    { base64: string; nextOffset: number; size: number }
  >
  'remotePush:getPublicKey': Contract<[], string>
  'remotePush:subscribe': Contract<
    [
      subscription: {
        endpoint: string
        expirationTime: number | null
        keys: { p256dh: string; auth: string }
      }
    ],
    void
  >
  'remotePush:unsubscribe': Contract<[endpoint: string], void>
  'clipboard:writeText': Contract<[text: string], void>
  'clipboard:readText': Contract<[], string>
  'speech:getCapabilities': Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCapabilitySnapshot>
  >
  'speech:getCatalog': Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechModelCatalog>
  >
  'speech:beginCapture': Contract<
    [scope: import('./speech/types').SpeechScope, mimeType: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCaptureSessionInfo>
  >
  'speech:beginNativeCapture': Contract<
    [scope: import('./speech/types').SpeechScope],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCaptureSessionInfo>
  >
  'speech:recordPermissionFailure': Contract<
    [scope: import('./speech/types').SpeechScope, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:appendCapture': Contract<
    [sessionId: string, chunk: Uint8Array<ArrayBuffer>],
    import('./speech/types').SpeechResult<number>
  >
  'speech:finishCapture': Contract<
    [sessionId: string, durationMs: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:finishNativeCapture': Contract<
    [sessionId: string, durationMs: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:failCapture': Contract<
    [sessionId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:failNativeCapture': Contract<
    [sessionId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:markAttemptFailure': Contract<
    [attemptId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >
  'speech:transcribe': Contract<
    [
      attemptId: string,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      language: string,
      cleanupMode: import('./speech/types').SpeechCleanupMode
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >
  'speech:preloadAsr': Contract<
    [runtime: import('./speech/types').SpeechRuntime, artifactId: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:getHistory': Contract<
    [cursor?: string, limit?: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechHistoryPage>
  >
  'speech:enforceHistoryLimit': Contract<
    [limit: number],
    import('./speech/types').SpeechResult<void>
  >
  'speech:transcribeAudioToLlm': Contract<
    [
      attemptId: string,
      scope: import('./speech/types').SpeechScope,
      language: string,
      cleanupMode: import('./speech/types').SpeechCleanupMode
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >
  'speech:validateModelPath': Contract<
    [path: string, capability: import('./speech/types').SpeechCapability],
    import('./speech/types').SpeechResult<import('./speech/types').ModelPathValidationResult>
  >
  'speech:importModel': Contract<
    [path: string, capability?: import('./speech/types').SpeechCapability],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechInstalledArtifact>
  >
  'speech:unregisterModel': Contract<
    [artifactId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:downloadArtifact': Contract<
    [artifactId: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:cancelDownload': Contract<
    [artifactId: string],
    import('./speech/types').SpeechResult<boolean>
  >
  'speech:cancelJob': Contract<[jobId: string], import('./speech/types').SpeechResult<boolean>>
  'speech:getLessons': Contract<
    [scope?: import('./speech/types').SpeechScope],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson[]>
  >
  'speech:observeCorrection': Contract<
    [observation: import('./speech/types').SpeechLearningObservation],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson[]>
  >
  'speech:setLessonEnabled': Contract<
    [lessonId: string, enabled: boolean],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson>
  >
  'speech:deleteLesson': Contract<
    [lessonId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:getLlamaRuntimeStatus': Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLlamaRuntimeStatus>
  >
  'speech:downloadLlamaRuntime': Contract<[], import('./speech/types').SpeechResult<void>>
  'speech:requestConfirmation': Contract<
    [action: import('./speech/types').SpeechDestructiveAction, targetId: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechConfirmation>
  >
  'speech:deleteHistory': Contract<
    [attemptId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:deleteAllHistory': Contract<
    [confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:readAudio': Contract<
    [attemptId: string],
    import('./speech/types').SpeechResult<Uint8Array<ArrayBuffer>>
  >
  'speech:retryTranscription': Contract<
    [
      attemptId: string,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      language: string
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >
  'speech:deleteArtifact': Contract<
    [artifactId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >
  'speech:preparePlayback': Contract<
    [messageId: string, markdown: string, includeCodeBlocks: boolean],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechPreparedPlayback>
  >
  'speech:synthesizePlaybackSegment': Contract<
    [
      sessionId: string,
      segmentIndex: number,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      voiceId: string
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechSynthesizedSegment>
  >
  'speech:cancelPlayback': Contract<
    [sessionId?: string],
    import('./speech/types').SpeechResult<boolean>
  >
  'dialog:pickFile': Contract<[scope?: AttachmentStorageScope], string | null>
  'dialog:pickFiles': Contract<[scope?: AttachmentStorageScope], string[]>
  'dialog:pickImage': Contract<[], string | null>
  'diagnostics:export': Contract<[], string | null>
  /** Open the app-owned data directory in the operating system's file manager. */
  'storage:openDataDirectory': Contract<[], boolean>
  'file:read': Contract<[filePath: string], Uint8Array<ArrayBuffer> | null>
  'file:readAsDataUrl': Contract<[filePath: string], string | null>
  'file:readDocumentPreview': Contract<[filePath: string], string | null>
  'editors:detect': Contract<[], EditorInfo[]>
  'editors:getPreferred': Contract<[], EditorId>
  'editors:setPreferred': Contract<[editorId: EditorId], void>
  'git:status': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'git:diff': Contract<
    [projectId: string, relativePath: string, staged: boolean, scopeBucketId?: string],
    GitDiff
  >
  'git:analyzeConflict': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictAnalysis
  >
  'git:prepareConflictWorkFile': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictWorkFile
  >
  'git:saveConflictDraft': Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      stateJson: string,
      scopeBucketId?: string
    ],
    void
  >
  'git:saveConflictResolution': Contract<
    [projectId: string, relativePath: string, content: string, scopeBucketId?: string],
    GitStatus
  >
  'git:stage': Contract<[projectId: string, paths: string[], scopeBucketId?: string], GitStatus>
  'git:resolveConflicted': Contract<
    [projectId: string, path: string, scopeBucketId?: string],
    GitStatus
  >
  'git:unstage': Contract<[projectId: string, paths: string[], scopeBucketId?: string], GitStatus>
  'git:restoreFiles': Contract<
    [
      projectId: string,
      source: string,
      paths: string[],
      target: import('./types').GitRestoreTarget,
      scopeBucketId?: string
    ],
    GitStatus
  >
  'git:commit': Contract<[projectId: string, message: string, scopeBucketId?: string], GitStatus>
  'git:init': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'git:branches': Contract<[projectId: string, scopeBucketId?: string], GitBranchInfo[]>
  'git:checkout': Contract<[projectId: string, branch: string, scopeBucketId?: string], GitStatus>
  'git:createBranch': Contract<[projectId: string, name: string, scopeBucketId?: string], GitStatus>
  'git:createTrackingBranch': Contract<
    [projectId: string, remote: string, branch: string, localName: string, scopeBucketId?: string],
    GitStatus
  >
  'git:deleteBranch': Contract<
    [projectId: string, name: string, force?: boolean, scopeBucketId?: string],
    GitStatus
  >
  'git:log': Contract<
    [projectId: string, limit?: number, offset?: number, query?: string, scopeBucketId?: string],
    GitCommitInfo[]
  >
  'git:commitDiff': Contract<
    [projectId: string, hash: string, scopeBucketId?: string],
    GitFileChange[]
  >
  'git:commitFileDiff': Contract<
    [projectId: string, hash: string, path: string, scopeBucketId?: string],
    GitDiff
  >
  'git:amend': Contract<[projectId: string, message: string, scopeBucketId?: string], GitStatus>
  'git:reset': Contract<
    [
      projectId: string,
      mode: import('./types').GitResetMode,
      target?: string,
      scopeBucketId?: string
    ],
    GitStatus
  >
  'git:deleteCommit': Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    GitStatus
  >
  'git:getIdentity': Contract<[projectId: string, scopeBucketId?: string], GitIdentity>

  'git:setIdentity': Contract<
    [projectId: string, identity: GitIdentityInput, scopeBucketId?: string],
    GitIdentity
  >
  'git:remotes': Contract<[projectId: string, scopeBucketId?: string], GitRemoteInfo[]>
  'git:addRemote': Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >
  'git:setRemoteUrl': Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >
  'git:removeRemote': Contract<
    [projectId: string, name: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >
  'git:fetch': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'git:fetchBranch': Contract<
    [projectId: string, remote: string, branch: string, scopeBucketId?: string],
    GitStatus
  >
  'git:pull': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'git:pullIntegrate': Contract<
    [
      projectId: string,
      options: {
        remote?: string
        branch?: string
        strategy: import('./types').GitPullStrategy
      },
      scopeBucketId?: string
    ],
    GitStatus
  >
  'git:push': Contract<
    [
      projectId: string,
      options: { setUpstream: boolean; remote?: string; branch?: string },
      scopeBucketId?: string
    ],
    GitStatus
  >
  'git:getCredentialStatus': Contract<[projectId: string], GitCredentialStatus>
  'git:setCredential': Contract<[projectId: string, token: string], GitCredentialStatus>
  'git:removeCredential': Contract<[projectId: string], GitCredentialStatus>
  'git:merge': Contract<[projectId: string, target: string, scopeBucketId?: string], MergeSummary>
  'git:rebase': Contract<[projectId: string, target: string, scopeBucketId?: string], MergeSummary>
  'git:preparePrResolve': Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >
  'git:finishPrResolve': Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >
  'git:stash': Contract<
    [projectId: string, message?: string, paths?: string[], scopeBucketId?: string],
    GitStatus
  >
  'git:ignore': Contract<[projectId: string, paths: string[], scopeBucketId?: string], GitStatus>
  'git:discard': Contract<[projectId: string, paths: string[], scopeBucketId?: string], GitStatus>
  'git:stashList': Contract<[projectId: string, scopeBucketId?: string], GitStashEntry[]>
  'git:stashPop': Contract<[projectId: string, id?: string, scopeBucketId?: string], GitStatus>
  'git:stashDrop': Contract<[projectId: string, id?: string, scopeBucketId?: string], GitStatus>
  'git:stashDiff': Contract<
    [projectId: string, id: string, scopeBucketId?: string],
    GitFileChange[]
  >
  'git:stashFileDiff': Contract<
    [projectId: string, id: string, path: string, scopeBucketId?: string],
    GitDiff
  >
  'git:abortMerge': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'git:abortRebase': Contract<[projectId: string, scopeBucketId?: string], GitStatus>
  'pr:create': Contract<
    [projectId: string, input: PrCreateInput, scopeBucketId?: string],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:list': Contract<
    [projectId: string, owner: string, repo: string, state?: string],
    PullRequestReference[]
  >
  'pr:merge': Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      method: PrMergeMethod,
      commitTitle?: string,
      commitMessage?: string
    ],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:ready': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:compare': Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      base: string,
      head: string,
      scopeBucketId?: string
    ],
    PullRequestCompare
  >
  'pr:reopen': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:close': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:update': Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      title: string | undefined,
      body: string | undefined
    ],
    GitHubMutationResult<PullRequestReference>
  >
  'pr:page': Contract<
    [projectId: string, owner: string, repo: string, state: PrState, page: number],
    PullRequestPage
  >
  /**
   * Read one pull request's detail. Hitting the detail endpoint forces GitHub
   * to compute mergeability, so it is used as the authoritative mergeability
   * probe when a list payload reported `mergeable`/`mergeable_state` as null.
   */
  'pr:detail': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    PullRequestDetail
  >
  'deployment:overview': Contract<
    [projectId: string, owner: string, repo: string],
    GitHubDeploymentOverviewResult
  >
  'deployment:detail': Contract<
    [projectId: string, owner: string, repo: string, deploymentId: number],
    GitHubDeploymentDetail
  >
  'deployment:runDetail': Contract<
    [projectId: string, owner: string, repo: string, runId: number],
    GitHubWorkflowRunDetail
  >
  'deployment:jobLog': Contract<
    [projectId: string, owner: string, repo: string, jobId: number],
    GitHubDeploymentJobLog
  >
  /**
   * Read a project's cloud deployment config, or null when none exists. The
   * config is persisted by main under the CodeInOven config directory; the
   * renderer never touches the filesystem or Node APIs for it.
   */
  'cloudDeploy:getConfig': Contract<
    [projectId: string],
    import('./types').CloudDeploymentConfig | null
  >
  /**
   * Persist a project's cloud deployment config (selected providers + labelled
   * containers with credential references) and refresh the project's
   * has-deployments flag for panel visibility. Returns the stored config.
   */
  'cloudDeploy:saveConfig': Contract<
    [projectId: string, config: import('./types').CloudDeploymentConfig],
    import('./types').CloudDeploymentConfig
  >
  /** Remove a project's cloud deployment config and clear its has-deployments flag. */
  'cloudDeploy:clearConfig': Contract<[projectId: string], void>
  /** Update a container's label/id in a project's config. Returns the stored config. */
  'cloudDeploy:updateContainer': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string,
      patch: { label?: string; id?: string }
    ],
    import('./types').CloudDeploymentConfig
  >
  /** Remove a container from a project's config. Returns the stored config. */
  'cloudDeploy:removeContainer': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentConfig
  >
  /** List every provider account in the global registry. */
  'cloudDeploy:listAccounts': Contract<[], import('./types').CloudDeploymentAccountRegistry>
  /**
   * Create a new provider account in the GLOBAL registry and vault its token by
   * account id. The account is reusable across every project that attaches it.
   * The plaintext token is vaulted by main via `safeStorage` and never crosses
   * back to the renderer. Returns the sanitized account (no secret).
   */
  'cloudDeploy:createAccount': Contract<
    [
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountLabel: string,
      token: string,
      baseUrl?: string
    ],
    import('./types').CloudDeploymentProviderAccount
  >
  /** Update a global provider account's metadata (label, base URL, enabled). */
  'cloudDeploy:updateAccount': Contract<
    [
      accountId: string,
      patch: {
        label?: string
        baseUrl?: string
        enabled?: boolean
      }
    ],
    import('./types').CloudDeploymentProviderAccount
  >
  /**
   * Rotate a global provider account's secret. Update-only: the token is vaulted
   * and the current secret is never returned to the renderer. Returns the
   * sanitized account (secretRef cleared).
   */
  'cloudDeploy:rotateAccountSecret': Contract<
    [accountId: string, token: string],
    import('./types').CloudDeploymentProviderAccount
  >
  /** Remove a global provider account and its vaulted token. */
  'cloudDeploy:removeAccount': Contract<[accountId: string], void>
  /** Attach a global provider account to a project for a provider kind. */
  'cloudDeploy:attachAccount': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >
  /** Detach a global provider account from a project for a provider kind. */
  'cloudDeploy:detachAccount': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >
  /** Set which attached account is active for a provider within a project. */
  'cloudDeploy:setActiveAccount': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >
  /**
   * Fetch a provider-agnostic snapshot of a configured provider's containers.
   * The adapter is resolved by kind via the registry; `hasDeployments` drives
   * whether the Cloud Deployments panel is shown at all. Provider/credential
   * failures are returned as `accessError` rather than rejecting IPC.
   */
  'cloudDeploy:overview': Contract<
    [projectId: string, providerKind: import('./types').CloudDeploymentProviderKind],
    import('./types').CloudDeploymentResult
  >
  /**
   * List every container the account can see on the provider (not filtered to
   * this project's mappings), so the add-container flow can offer a picker.
   * Provider/credential failures are returned as `{ accessError }`.
   */
  'cloudDeploy:availableContainers': Contract<
    [projectId: string, providerKind: import('./types').CloudDeploymentProviderKind],
    import('./types').CloudDeploymentContainer[] | { accessError: string }
  >
  /**
   * Latest snapshot for one configured container, or null when the provider
   * cannot resolve it.
   */
  'cloudDeploy:containerStatus': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentContainer | null
  >
  /**
   * List the most recent deployments/builds for a container, newest first
   * (bounded to a UI window such as the last ten).
   */
  'cloudDeploy:deployments': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentDeployment[]
  >
  /** Capped raw log text for a container's latest deployment. */
  'cloudDeploy:containerLog': Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string,
      deploymentId?: string
    ],
    { containerId: string; deploymentId: string | null; log: string }
  >
  /** Everything the PR detail view needs, fetched in parallel in one round trip. */
  'pr:bundle': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    PullRequestBundle
  >
  'pr:commitFiles': Contract<
    [projectId: string, owner: string, repo: string, sha: string],
    PullRequestFile[]
  >
  /** Read back the agent's `.cio/git/pr/<number>/review.md`, if it wrote one. */
  'pr:agentReport': Contract<[projectId: string, pullNumber: number], PrAgentReport>
  'pr:comment': Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, body: string],
    GitHubMutationResult<PullRequestComment>
  >
  'pr:review': Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      event: PrReviewEvent,
      body: string
    ],
    PullRequestReviewResult
  >
  /** Create `.cio/git/pr/<number>/` for an agent review and return its absolute path. */
  'pr:reviewWorkspace': Contract<[projectId: string, pullNumber: number, threadId?: string], string>
  /** Run the PR-compose agent virtually and consume its temporary report. */
  'pr:composeWithAgent': Contract<
    [
      projectId: string,
      scopeBucketId: string,
      virtualTaskId: string,
      settings: ThreadSettings,
      input: import('./types').PrComposeInput
    ],
    PrComposeReport
  >
  'github:authStatus': Contract<[], GitHubAuthStatus>
  'github:startDeviceFlow': Contract<[], GitHubDeviceCode>
  'github:poll': Contract<[deviceCode: string], GitHubPollResult>
  'github:logout': Contract<[], GitHubAuthStatus>
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
  'scope:updateLayout': Contract<[projectId: string, orderedIds: string[]], ScopeBoard>
  'scope:updateAppearance': Contract<
    [projectId: string, bucketId: string, patch: ScopeAppearancePatch],
    ScopeBoard
  >
  'scope:updateCollapse': Contract<
    [projectId: string, bucketId: string, patch: ScopeCollapsePatch],
    ScopeBoard
  >
  'scope:create': Contract<
    [projectId: string, input: ScopeCreateInput],
    { board: ScopeBoard; bucket: ScopeBucket }
  >
  'scope:setArchive': Contract<[projectId: string, bucketId: string, archived: boolean], ScopeBoard>
  /** Pin or unpin a scope; pinned scopes are exempt from thread eviction. */
  'scope:setPinned': Contract<[projectId: string, bucketId: string, pinned: boolean], ScopeBoard>
  'scope:delete': Contract<[projectId: string, bucketId: string], ScopeBoard>
  /** Create an isolated managed worktree and attach it to a scope. */
  'scope:worktree:create': Contract<
    [target: ScopeTarget, input: ScopeWorktreeCreateInput],
    ManagedWorktreeDescriptor
  >
  /** Inspect the source checkout before creating a worktree. */
  'scope:worktree:sourceInfo': Contract<[projectId: string], ScopeWorktreeSourceInfo>
  /** Refresh the typed health state of a managed scope. */
  'scope:worktree:health': Contract<[target: ScopeTarget], ScopeWorktreeHealth>
  /** Repair an unhealthy managed scope according to its health category. */
  'scope:worktree:repair': Contract<[target: ScopeTarget], ScopeWorktreeHealth>
  /** Preview whether an existing Git worktree checkout can be adopted. */
  'scope:worktree:detectAdopt': Contract<
    [projectId: string, sourcePath: string],
    AdoptableWorktreeInfo
  >
  /** Adopt an existing raw Git worktree as a managed scope root. */
  'scope:worktree:adopt': Contract<
    [target: ScopeTarget, input: { sourcePath: string; runSetup: boolean }],
    ManagedWorktreeDescriptor
  >
  /** Compute a state-bound preflight and mint a single-use confirmation token. */
  'scope:worktree:preflight': Contract<
    [action: ScopeLifecycleAction, target: ScopeTarget, options?: { scopeBucketId?: string }],
    ScopeLifecyclePreflight
  >
  /** Consume a confirmation token to detach a managed worktree. */
  'scope:worktree:confirmDetach': Contract<[target: ScopeTarget, confirmationId: string], void>
  /** Consume a confirmation token to remove a managed worktree (optionally forced). */
  'scope:worktree:confirmRemove': Contract<
    [target: ScopeTarget, confirmationId: string, force: boolean],
    void
  >
  /** Consume a separate confirmation token to delete a managed scope's branch. */
  'scope:worktree:confirmDeleteBranch': Contract<
    [target: ScopeTarget, confirmationId: string],
    void
  >
  /** Fully delete a managed scope: worktree, bucket, and optionally branch. */
  'scope:worktree:confirmDeleteScope': Contract<
    [target: ScopeTarget, confirmationId: string, deleteBranch: boolean],
    void
  >
  /** Retry a failed/interrupted setup from its failed command. */
  'scope:worktree:retrySetup': Contract<
    [target: ScopeTarget, options: { runSetup: boolean }],
    ManagedWorktreeDescriptor
  >
  /** Preflight merging a managed scope into another scope and mint a token. */
  'scope:worktree:mergePreflight': Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode],
    ScopeMergePreflight
  >
  /** Consume a merge token to merge a scope and apply its post-merge mode. */
  'scope:worktree:confirmMerge': Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode, confirmationId: string],
    ScopeMergeOutcome
  >
  /** Update project-level managed-worktree defaults. */
  'scope:setWorktreeDefaults': Contract<
    [projectId: string, defaults: ScopeWorktreeDefaults],
    ScopeBoard
  >
  'history:load': Contract<[projectId: string, threadId: string, limit?: number], HistoryEntry[]>
  'notification:test': Contract<[], SystemNotificationTestResult>
  'notification:getPermissionStatus': Contract<[], SystemNotificationPermissionStatus>
  /**
   * Open the OS notification-settings pane (System Settings on macOS, Settings
   * on Windows). The target URL is a hard-coded, platform-specific allow-list
   * constant resolved in the main process — never renderer-supplied — so it is
   * safe to bypass the web-only external-URL validator. Returns false when the
   * platform has no notification-settings deep link.
   */
  'notification:openSettings': Contract<[], boolean>
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
  'projectFiles:list': Contract<
    [projectId: string, relativeDirectory: string, scopeBucketId?: string],
    ProjectFileEntry[]
  >
  'projectFiles:search': Contract<
    [projectId: string, query: string, category: 'all' | 'rules', scopeBucketId?: string],
    ProjectFileEntry[]
  >
  'projectFiles:resolveCitationPaths': Contract<
    [projectId: string, candidates: string[], scopeBucketId?: string],
    Record<string, string | null>
  >
  'projectFiles:resolveExternalCitationPaths': Contract<
    [absolutePaths: string[]],
    Record<string, boolean>
  >
  'projectFiles:create': Contract<
    [projectId: string, relativeDirectory: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >
  'projectFiles:createDirectory': Contract<
    [projectId: string, relativeDirectory: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >
  'projectFiles:delete': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    void
  >
  'projectFiles:info': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    ProjectFileInfo
  >
  'projectFiles:openInEditor': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    void
  >
  'projectFiles:openInEditorWith': Contract<
    [projectId: string, relativePath: string, editorId: EditorId, scopeBucketId?: string],
    void
  >
  'projectFiles:saveAs': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    string | null
  >
  'projectFiles:paste': Contract<
    [
      sourceProjectId: string,
      sourcePath: string,
      destinationProjectId: string,
      destinationDirectory: string,
      mode: ProjectFileTransferMode,
      sourceScopeBucketId?: string,
      destinationScopeBucketId?: string
    ],
    ProjectFileEntry
  >
  'projectFiles:importPaths': Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string
    ],
    ProjectFileEntry[]
  >
  'projectFiles:dropPaths': Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string
    ],
    ProjectFileDropResult[]
  >
  'projectFiles:read': Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    ProjectTextFile
  >
  'projectFiles:rename': Contract<
    [projectId: string, relativePath: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >
  'projectFiles:save': Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      expectedRevision: string,
      scopeBucketId?: string
    ],
    ProjectTextFile
  >
  'providers:check': Contract<[providerId: string], ProviderConnectionInfo>
  'providers:checkAll': Contract<[force?: boolean], ProviderConnectionInfo[]>
  'providers:getStatus': Contract<[], ProviderConnectionInfo[]>
  'harnessUpdates:check': Contract<[harnessId: string], HarnessUpdateStatus>
  'harnessUpdates:checkAll': Contract<[force?: boolean], HarnessUpdateStatus[]>
  'harnessUpdates:handoff': Contract<[harnessId: string], HarnessUpdateHandoff>
  'harnessInstall:getInfo': Contract<[harnessId: string], HarnessInstallInfo>
  'harnessUninstall:handoff': Contract<[harnessId: string], HarnessUninstallHandoff>
  'harnessManifest:list': Contract<[], HarnessManifestEntry[]>
  'harnessManifest:confirm': Contract<
    [input: { harnessId: string; behavior: string; value: boolean }],
    void
  >
  'harnessManifest:reset': Contract<[input: { harnessId: string; behavior: string }], void>
  'harnessAutoUpdate:list': Contract<[], Record<string, boolean>>
  'harnessAutoUpdate:set': Contract<[input: { harnessId: string; value: boolean }], void>
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
  'providerAccounts:setApiKey': Contract<
    [harnessId: string, providerId: string, apiKey: string],
    void
  >
  'providerAccounts:beginOAuthLogin': Contract<[harnessId: string, providerId: string], string>
  'providerAccounts:respondOAuthPrompt': Contract<[loginId: string, value: string], void>
  'providerAccounts:cancelOAuthLogin': Contract<[loginId: string], void>
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
  'baseUrlProviders:fetchModels': Contract<
    [input: BaseUrlProviderFetchModelsRequest],
    DiscoveredBaseUrlModel[]
  >
  'baseUrlProviders:fetchUsage': Contract<
    [harnessId: string, id: string],
    import('./types').CustomProviderUsage | null
  >
  'heartbeat:list': Contract<[], HeartbeatConfig[]>
  'heartbeat:create': Contract<[input: Omit<HeartbeatConfig, 'id' | 'lastRun'>], HeartbeatConfig>
  'heartbeat:update': Contract<
    [id: string, patch: Partial<Omit<HeartbeatConfig, 'id'>>],
    HeartbeatConfig
  >
  'heartbeat:delete': Contract<[id: string], boolean>
  'heartbeat:toggle': Contract<[id: string, enabled: boolean], HeartbeatConfig>
  'gateway:list': Contract<[], import('./gateway-types').GatewayStatus[]>
  'gateway:setEnabled': Contract<
    [pluginId: string, enabled: boolean],
    import('./gateway-types').GatewayStatus
  >
  'gateway:start': Contract<[pluginId: string], import('./gateway-types').GatewayStatus>
  'gateway:stop': Contract<[pluginId: string], import('./gateway-types').GatewayStatus>
  'gateway:uninstall': Contract<[pluginId: string], import('./gateway-types').GatewayStatus>
  'gateway:update': Contract<[pluginId: string], import('./gateway-types').GatewayStatus>
  'gateway:copyDashboardPassword': Contract<[pluginId: string], void>
  'gateway:refreshCatalog': Contract<
    [pluginId: string],
    import('./gateway-types').GatewayModelInfo[]
  >
  'utilities:list': Contract<[options?: UtilitySearchOptions], UtilityCatalog>
  'utilities:get': Contract<[id: string], UtilityDefinition | null>
  'utilities:create': Contract<[input: UtilityDefinitionInput], UtilityDefinition>
  'utilities:installBundle': Contract<[request: UtilityBundleInstallRequest], UtilityDefinition[]>
  'utilities:setupWithAgent': Contract<
    [projectId: string, taskId: string, settings: ThreadSettings, request: string],
    UtilitySetupReport
  >
  'utilities:searchSkillMarket': Contract<[query: string], SkillMarketSearchResult>
  'utilities:listSkillMarket': Contract<[view: SkillMarketView], SkillMarketLeaderboard>
  'utilities:getSkillMarketDetail': Contract<[id: string], SkillMarketDetail>
  'utilities:installMarketSkill': Contract<[request: SkillMarketInstallRequest], string>
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
    [id: string, projectId: string, columns: number, rows: number, scopeBucketId?: string],
    { id: string; pid: number }
  >
  'pty:createCommand': Contract<
    [id: string, command: string, args: string[], columns: number, rows: number],
    { id: string; pid: number }
  >
  'pty:createAction': Contract<
    [
      id: string,
      projectId: string,
      script: string,
      variables: Record<string, string>,
      columns: number,
      rows: number,
      scopeBucketId?: string
    ],
    { id: string; pid: number }
  >
  'pty:destroy': Contract<[id: string], void>
  'projectActions:list': Contract<[projectId: string], import('./project-actions').ProjectAction[]>
  'projectActions:save': Contract<
    [
      projectId: string,
      actionId: string | null,
      input: import('./project-actions').ProjectActionInput,
      insertAfterId?: string | null
    ],
    import('./project-actions').ProjectAction
  >
  'projectActions:delete': Contract<[projectId: string, actionId: string], boolean>
  'projectActions:reorder': Contract<
    [projectId: string, orderedIds: string[]],
    import('./project-actions').ProjectAction[]
  >
  'repository:init': Contract<[projectPath: string], RepositoryPreflightResult>
  'repository:preflight': Contract<[projectPath: string], RepositoryPreflightResult>
  'repository:remoteOrigin': Contract<[projectPath: string], string | null>
  'shell:openExternal': Contract<[url: string], void>
  'shell:revealPath': Contract<[path: string], boolean>
  /** Reveal an existing absolute path (e.g. an agent-cited file outside the
   *  project root) in the OS file manager. Existence is checked; no content is
   *  read or opened. Returns false when the path does not exist. */
  'shell:revealExternalPath': Contract<[path: string], boolean>
  /** Resolve website favicons for a list of hostnames. Returns a data URL per host, or null when none exists. */
  'web:favicon': Contract<[hostnames: string[]], Record<string, string | null>>
  'browser:show': Contract<
    [
      tabId: string,
      projectId: string,
      threadId: string,
      initialUrl: string,
      bounds: BrowserViewBounds
    ],
    BrowserPageState
  >
  'browser:hide': Contract<[tabId: string], void>
  'browser:navigate': Contract<[tabId: string, url: string], void>
  'browser:goBack': Contract<[tabId: string], void>
  'browser:goForward': Contract<[tabId: string], void>
  'browser:reload': Contract<[tabId: string], void>
  'browser:stop': Contract<[tabId: string], void>
  'browser:getConsole': Contract<[tabId: string], BrowserConsoleEntry[]>
  'browser:clearConsole': Contract<[tabId: string], void>
  'browser:clearData': Contract<[projectId: string], void>
  'browser:resolvePermission': Contract<
    [requestId: string, decision: BrowserPermissionDecision],
    void
  >
  'browser:destroy': Contract<[tabId: string], void>
  'browser:destroyThread': Contract<[projectId: string, threadId: string], void>
  'browser:destroyProject': Contract<[projectId: string], void>
  'browser:getDownloads': Contract<[projectId: string], BrowserDownload[]>
  'browser:cancelDownload': Contract<[id: string], void>
  'browser:pauseDownload': Contract<[id: string], void>
  'browser:resumeDownload': Contract<[id: string], void>
  'browser:openDownload': Contract<[id: string], void>
  'browser:revealDownload': Contract<[id: string], boolean>
  /** Open the native Ctrl+Tab overlay above the browser view with a fresh
   *  display payload. Only used while the native browser view is on screen;
   *  otherwise the renderer uses the DOM switcher. */
  'switcher:open': Contract<[payload: NativeSwitcherPayload], void>
  'switcher:close': Contract<[], void>
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
  'audit:openInEditor': Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >
  'audit:revealInFiles': Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >
  'brainstorm:openInEditor': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >
  'brainstorm:revealInFiles': Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >
  'thread:create': Contract<[input: CreateThreadInput], Thread>
  'thread:delete': Contract<[projectId: string, threadId: string], void>
  'thread:dismissSpecReview': Contract<
    [projectId: string, threadId: string, specId: string, specVersion: number],
    Thread
  >
  'thread:fork': Contract<
    [
      projectId: string,
      threadId: string,
      title: string,
      checkpointId?: string,
      messageId?: string,
      targetProjectId?: string
    ],
    Thread
  >
  'thread:get': Contract<[projectId: string, threadId: string], Thread | null>
  'thread:list': Contract<[projectId: string], Thread[]>
  'thread:listAll': Contract<[], Thread[]>
  /**
   * Bounded task listing for startup hydration. Never crosses the full task
   * history over IPC.
   * `projectId` (when given) is ordered first so the selected project's recent
   * active threads render before anything else.
   */
  'thread:listRecent': Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >
  /** Paged history for an explicit older-task request. */
  'thread:listHistoryPage': Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >
  'thread:reorder': Contract<[projectId: string, orderedIds: string[]], Thread[]>
  'thread:setSortOrder': Contract<[projectId: string, threadId: string, sortOrder: number], Thread>
  'thread:reorderPinned': Contract<[projectId: string, orderedPinnedIds: string[]], Thread[]>
  'thread:reorderPinnedGlobal': Contract<[orderedPinnedIds: string[]], Thread[]>
  'thread:reorderScope': Contract<
    [projectId: string, bucketId: string, slice: ScopeSlice, orderedIds: string[]],
    Thread[]
  >
  'thread:loadMessages': Contract<
    [projectId: string, threadId: string, before?: ThreadMessageCursor, limit?: number],
    ThreadMessagePage
  >
  'thread:exportTranscript': Contract<
    [projectId: string, threadId: string, options: import('./types').TranscriptExportOptions],
    import('./types').TranscriptExportResult | null
  >
  'thread:loadMessagesAround': Contract<
    [projectId: string, threadId: string, anchorId: string, limit: number],
    ThreadMessagePage
  >
  'thread:loadUserMessages': Contract<[projectId: string, threadId: string], UserMessageSummary[]>
  'thread:loadStreamParts': Contract<
    [projectId: string, threadId: string],
    import('./types').AgentPart[]
  >
  'thread:markRead': Contract<[projectId: string, threadId: string], Thread>
  /** Renderer → main composer draft transitions feeding the turn-grading timers. */
  'thread:draftActivity': Contract<[projectId: string, threadId: string, drafting: boolean], void>
  'thread:setPinned': Contract<[projectId: string, threadId: string, pinned: boolean], Thread>
  'thread:setContextUsage': Contract<
    [projectId: string, threadId: string, usage: ThreadContextUsage],
    void
  >
  'thread:harnessUsage': Contract<[projectId: string, threadId: string], HarnessUsage[]>
  'thread:efficiencyKpis': Contract<[projectId: string, threadId: string], UsageEfficiencyKpis>
  'thread:setStatus': Contract<[projectId: string, threadId: string, status: ThreadStatus], Thread>
  'note:get': Contract<[projectId: string, threadId: string], ThreadNote | null>
  'note:save': Contract<[projectId: string, threadId: string, body: string], ThreadNote>
  'note:delete': Contract<[projectId: string, threadId: string], void>
  /** Thread ids that currently have a note (renderer presence sync). */
  'note:list': Contract<[], string[]>
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
  'updater:check': Contract<[explicit?: boolean], UpdaterStatus>
  'updater:getStatus': Contract<[], UpdaterStatus>
  'updater:download': Contract<[], void>
  'updater:install': Contract<[], void>
  'remote:getStatus': Contract<[], RemoteModeStatus>
  'remote:ensureGateway': Contract<[], RemoteModeStatus>
  'remote:toggle': Contract<[enabled: boolean], RemoteModeStatus>
  'remote:listDevices': Contract<[], RemoteDeviceInfo[]>
  'remote:disconnectDevice': Contract<[deviceId: string], void>
  'remote:renameDevice': Contract<[deviceId: string, name: string], RemoteModeStatus>
  'remote:revokeDevice': Contract<[deviceId: string, reason: string], RemoteModeStatus>
  'remote:approveStepUp': Contract<[approvalId: string], boolean>
  'remote:rejectStepUp': Contract<[approvalId: string], boolean>
  'remote:listPendingApprovals': Contract<[], RemotePendingStepUpApproval[]>
  'remote:listAuditEvents': Contract<[limit: number], RemoteAuditEventInfo[]>
  'remote:beginCloudEnrollment': Contract<[], RemoteModeStatus>
  'remote:resetCloudEnrollment': Contract<[], RemoteModeStatus>
  'app:confirmClose': Contract<[], void>
  /** Resolves after post-paint feature IPC and harness services are registered. */
  'app:waitForFeatures': Contract<[], void>
  /**
   * Signalled by the renderer after its initial hydration completes so the main
   * process can timestamp the `renderer:hydrated` / `workspace:ready` startup
   * phases. Carries no payload.
   */
  'app:rendererReady': Contract<[], void>
  /**
   * Renderer forwards its own captured errors (uncaught exceptions, unhandled
   * rejections, console errors) to the main-process durable Logger. Fire and
   * forget; returns `void`.
   */
  'renderer:log': Contract<[entry: RendererLogEntry], void>
}

export interface ThreadClickedPayload {
  projectId: string
  threadId: string
}

/** One thread still being worked on, blocking the close. */
export interface CloseConfirmationThread {
  threadId: string
  title: string
  status: 'planning' | 'executing'
}

/** A project with at least one thread still being worked on. */
export interface CloseConfirmationProject {
  projectId: string
  projectName: string
  threadCount: number
  /** The exact threads blocking the close, most active first. */
  threads: CloseConfirmationThread[]
}

/** An open file with unsaved edits, blocking the close. */
export interface CloseConfirmationFile {
  projectId: string
  path: string
}

/** Sent when the user tries to close the app while threads are still working
 *  or files have unsaved edits. `files` is populated by the renderer, which
 *  owns the unsaved-editor state. */
export interface CloseConfirmationPayload {
  projects: CloseConfirmationProject[]
  files: CloseConfirmationFile[]
}

export type AgentNotificationKind = 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'

/** Where a notification originated: a project thread, the global chat (inbox),
 *  or a temporary (side) chat piped through a parent thread. */
export type NotificationSource = 'project' | 'chat' | 'temporary-chat'

export interface AgentNotificationPayload extends ThreadClickedPayload {
  id: string
  kind: AgentNotificationKind
  title: string
  body: string
  /** Origin of the notification, used by the panel to tag its source. */
  source: NotificationSource
  /** Name of the owning project (or the inbox "Chats" project for chats). */
  projectName: string
  /** Accent colour of the owning project, when known. */
  projectColor?: string
}

export type SystemNotificationTestResult =
  | { status: 'shown'; message: string }
  | { status: 'unsupported'; message: string }
  | { status: 'failed'; message: string }

/**
 * macOS notification authorization, queried on demand. On non-macOS platforms the
 * permission concept does not apply, so `platform` is `'other'`.
 */
export type SystemNotificationPermissionStatus =
  { platform: 'darwin'; status: 'granted' | 'denied' | 'prompt' } | { platform: 'other' }

/** Remote-mode keep-alive phase, mirroring the renderer's `KeepAlivePhase`. */
export type RemoteModePhase =
  'IDLE' | 'KEEP_ALIVE_ARMED' | 'KEEP_ALIVE_ACTIVE' | 'REMOTE_SESSION_LIVE'

export interface RemoteGatewayInfo {
  listening: boolean
  port: number
  /** The URL a phone can open to reach the installable PWA. */
  url: string | null
  /** Ordered Wi-Fi/Ethernet endpoint candidates for multi-homed desktops. */
  urls: string[]
}

export interface RemoteCloudStatus {
  configured: boolean
  state: 'disabled' | 'enrollment-pending' | 'connecting' | 'online' | 'offline' | 'error'
  apiOrigin: string | null
  desktopId: string | null
  enrollmentCode: string | null
  enrollmentExpiresAt: number | null
  lastError: string | null
}

/** A phone device known to the desktop (enrolled, connected, or revoked). */
export interface RemoteDeviceInfo {
  id: string
  /** Human-readable device name (reported by the phone or renamed on desktop). */
  name: string
  connectedAt: number
  transport: 'lan' | 'relay'
  /** Whether the device currently holds a live session. */
  connected: boolean
  /** Granted scope identifiers. */
  scopes: string[]
  /** SHA-256 fingerprint prefix of the device signing key. */
  fingerprint: string | null
  lastUsedAt: number | null
  /** Device authorization expiry (epoch ms). */
  expiresAt: number | null
  /** Signed credential lifetime expiry (epoch ms). */
  credentialExpiresAt: number | null
  revokedAt: number | null
  authVersion: number
  /** Whether the device may reach every project (local explicit choice). */
  allProjects: boolean
  /** Project ids allowed when `allProjects` is false. */
  projectIds: string[]
}

export interface RemoteModeStatus {
  remoteMode: boolean
  phase: RemoteModePhase
  blockedQuit: boolean
  gateway: RemoteGatewayInfo
  cloud: RemoteCloudStatus
  /** Connected phone devices, newest first. */
  devices: RemoteDeviceInfo[]
}

/** A pending single-use local step-up approval awaiting desktop disposition. */
export interface RemotePendingStepUpApproval {
  approvalId: string
  deviceId: string
  channel: string
  action: string
  resource: string | null
  expiresAt: number
}

/** A redacted security audit record — never contains secrets or content. */
export interface RemoteAuditEventInfo {
  id: string
  timestamp: number
  deviceId: string | null
  deviceName: string | null
  fingerprintPrefix: string | null
  channel: string | null
  projectId: string | null
  requiredScope: string | null
  decision: string
  reasonCode: string | null
  stepUpApprovalId: string | null
  authVersion: number | null
}

export interface IpcEventContract {
  /** Post-paint feature IPC, chat, and harness registration completed. */
  'app:featuresReady': []
  /** Emitted after browser sign-in changes the shared desktop account. */
  'account:profileChanged': [state: import('./types').AccountProfileState]
  'agent:processesChanged': [projectId: string, threadId: string]
  'taskManager:processesChanged': []
  'agent:temporaryChatExpired': [temporaryChatId: string]
  'thread:deleted': [projectId: string, threadId: string]
  /** Note presence changed for a thread (saved or deleted). */
  'note:changed': [projectId: string, threadId: string, hasNote: boolean]
  'notification:playSound': []
  'notification:show': [payload: AgentNotificationPayload]
  'notification:threadClicked': [payload: ThreadClickedPayload]
  /** macOS notification authorization changed (delivery outcome or re-verification). */
  'notification:permissionStatus': [status: SystemNotificationPermissionStatus]
  /** Emitted before the main process begins its shutdown disposal chain.
   *  The renderer should unsubscribe from IPC events and release resources. */
  'window:beforeQuit': []
  /** Emitted when the app is asked to close while threads are still working or
   *  files have unsaved edits. The renderer populates `files` from its editor
   *  state and either confirms the close or shows the confirmation modal. */
  'window:confirmClose': [payload: CloseConfirmationPayload]
  /**
   * Emitted when the user presses Cmd/Ctrl+W. The main process intercepts the
   * key (so the macOS "Close Window" menu accelerator never fires) and asks the
   * renderer to close the active in-app surface — modal, settings page, sidebar
   * panel, or thread. The shortcut never closes the native application window.
   */
  'window:closeShortcut': []
  /**
   * Emitted when the user presses Cmd/Ctrl+T while a terminal holds focus. The
   * main process intercepts the key (so ghostty-web never feeds it to the
   * shell) and asks the renderer to open a new terminal tab in the terminal
   * panel — right sidebar or bottom dock, whichever is active.
   */
  'window:newTerminalShortcut': []
  'updater:status': [status: UpdaterStatus]
  'updater:waiting-for-threads': [activeCount: number]
  'computerUse:pipFrame': [frame: ComputerUsePipFrame]
  'computerUse:pipState': [state: ComputerUsePipState]
  'browser:state': [state: BrowserPageState]
  'gateway:state': [status: import('./gateway-types').GatewayStatus]
  'browser:console': [entry: BrowserConsoleEntry]
  'browser:openRequested': [url: string, context?: BrowserOpenRequestContext]
  'browser:permissionRequested': [request: BrowserPermissionRequest]
  'browser:permissionResolved': [requestId: string]
  'browser:download': [download: BrowserDownload]
  /** Native Ctrl+Tab overlay asked the renderer to switch to a thread. */
  'switcher:select': [threadId: string]
  /** Native Ctrl+Tab overlay moved its highlight (so the renderer can preload
   *  that thread's messages). */
  'switcher:highlight': [threadId: string]
  /** Native Ctrl+Tab overlay was dismissed without a selection. */
  'switcher:closed': []
  /** Remote-mode status changes from the main process. */
  'remote:status': [status: RemoteModeStatus]
  /**
   * Pending single-use local step-up approvals awaiting desktop disposition.
   * Emitted whenever a high-risk remote operation requires local approval.
   */
  'remote:stepUpPending': [approvals: RemotePendingStepUpApproval[]]
  'speech:progress': [progress: import('./speech/types').SpeechProgressEvent]
  /** Live progress/prompt/completion updates for an in-app Pi OAuth sign-in. */
  'providerAccounts:oauthEvent': [
    payload:
      | { loginId: string; kind: 'event'; event: import('../lib/types').PiOAuthUiEvent }
      | {
          loginId: string
          kind: 'prompt'
          promptId: string
          prompt: import('../lib/types').PiOAuthUiPrompt
        }
      | { loginId: string; kind: 'complete'; providerId: string }
      | { loginId: string; kind: 'failed'; error: string }
  ]
}

export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['args']
export type InvokeResult<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['result']
export type EventArgs<Channel extends keyof IpcEventContract> = IpcEventContract[Channel]
