import type {
  AgentArtifact,
  AgentMessage,
  AgentModelSelection,
  AgentRole,
  AgentSessionStatus,
  AgentRunningProcess,
  TaskManagerSnapshot,
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
  HarnessAccount,
  PendingHarnessAccount,
  ProviderAccountLoginHandoff,
  ProviderAccountLoginOptions,
  ProviderCatalog,
  ProviderConnectionInfo,
  HarnessUpdateHandoff,
  HarnessUpdateStatus,
  HarnessInstallInfo,
  HarnessInstallHandoff,
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
  AgentAccountUsageOverrides,
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
  /** Favicon data URL reported by the page, or null until the page declares one. */
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** DevTools open/closed state for a browser tab. */
export interface BrowserDevToolsState {
  tabId: string
  open: boolean
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

/**
 * Selectable scopes for clearing an in-app browser session's stored state.
 * - `cookies`: HTTP cookies for visited sites.
 * - `site-data`: persistent site data (storage, service workers, IndexedDB)
 *   excluding cookies.
 * - `cache`: HTTP disk and memory caches.
 * - `permissions`: remembered permission grants and denials.
 */
export type BrowserSiteDataScope = 'cookies' | 'site-data' | 'cache' | 'permissions'

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

export const IPC_INVOKE_CONTRACT = {
  'account:getLocalUsage': {} as Contract<
    [range: import('./types').LocalProfileAnalyticsRange],
    import('./types').LocalProfileAnalytics
  >,
  'account:getProfile': {} as Contract<[], import('./types').AccountProfileState>,
  'account:beginSignIn': {} as Contract<
    [provider: import('./types').AccountAuthProvider],
    import('./types').AccountSignInStart
  >,
  'account:syncProfile': {} as Contract<[], import('./types').AccountProfileState>,
  'account:signOut': {} as Contract<[], void>,
  'engineeringLifecycle:get': {} as Contract<
    [projectId: string, threadId: string],
    EngineeringLifecycleState | null
  >,
  'engineeringLifecycle:select': {} as Contract<
    [
      projectId: string,
      threadId: string,
      input: import('./types').EngineeringLifecycleSelectionInput
    ],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:start': {} as Contract<
    [projectId: string, threadId: string, stage?: import('./types').EngineeringLifecycleStage],
    EngineeringLifecycleTransitionResult
  >,
  'engineeringLifecycle:complete': {} as Contract<
    [projectId: string, threadId: string, stage: import('./types').EngineeringLifecycleStage],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:resume': {} as Contract<
    [
      projectId: string,
      threadId: string,
      resumeToken: string,
      decision: EngineeringLifecycleDecision
    ],
    EngineeringLifecycleTransitionResult
  >,
  'engineeringLifecycle:retry': {} as Contract<
    [projectId: string, threadId: string, resumeToken: string],
    EngineeringLifecycleState
  >,
  'engineeringLifecycle:cancel': {} as Contract<
    [projectId: string, threadId: string, confirmed: true],
    EngineeringLifecycleState
  >,
  'prd:ensureWorkflow': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState>,
  'prd:getWorkflow': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState | null>,
  'prd:chooseEntry': {} as Contract<
    [projectId: string, threadId: string, choice: PrdEntryChoice],
    PrdWorkflowState
  >,
  'prd:beginDrafting': {} as Contract<[projectId: string, threadId: string], PrdWorkflowState>,
  'prd:getActive': {} as Contract<[projectId: string, threadId: string], PrdDocument | null>,
  'prd:listVersions': {} as Contract<
    [projectId: string, threadId: string, prdId: string],
    PrdDocument[]
  >,
  'prd:createDraft': {} as Contract<
    [projectId: string, threadId: string, content: PrdContent, provenance: NewPrdProvenance],
    PrdDocument
  >,
  'prd:saveDraft': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number, content: PrdContent],
    PrdDocument
  >,
  'prd:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      content: PrdContent,
      provenance: NewPrdProvenance
    ],
    PrdDocument
  >,
  'prd:addAnnotation': {} as Contract<
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
  >,
  'prd:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      prdId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    PrdDocument
  >,
  'prd:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number, annotationId: string],
    PrdDocument
  >,
  'prd:finalize': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    PrdDocument
  >,
  'prd:openInEditor': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >,
  'prd:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, prdId: string, version: number],
    string
  >,
  'prototypePreview:getOrigin': {} as Contract<[], string | null>,
  'prototypePreview:readChunk': {} as Contract<
    [projectId: string, threadId: string, previewPath: string, offset: number],
    { base64: string; nextOffset: number; size: number; mime: string }
  >,
  'brainstorm:ensureWorkflow': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState
  >,
  'brainstorm:getWorkflow': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormWorkflowState | null
  >,
  'brainstorm:chooseEntry': {} as Contract<
    [projectId: string, threadId: string, choice: BrainstormEntryChoice],
    BrainstormWorkflowState
  >,
  'brainstorm:resetWorkflow': {} as Contract<[projectId: string, threadId: string], void>,
  'brainstorm:getActive': {} as Contract<
    [projectId: string, threadId: string],
    BrainstormDocument | null
  >,
  'brainstorm:listVersions': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string],
    BrainstormDocument[]
  >,
  'brainstorm:createDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >,
  'brainstorm:saveDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      content: BrainstormContent
    ],
    BrainstormDocument
  >,
  'brainstorm:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      content: BrainstormContent,
      provenance: NewBrainstormProvenance
    ],
    BrainstormDocument
  >,
  'brainstorm:addAnnotation': {} as Contract<
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
  >,
  'brainstorm:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    BrainstormDocument
  >,
  'brainstorm:resolveAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      annotationId: string
    ],
    BrainstormDocument
  >,
  'brainstorm:addDecisionComment': {} as Contract<
    [
      projectId: string,
      threadId: string,
      brainstormId: string,
      version: number,
      action: BrainstormDecisionAction,
      body: string
    ],
    BrainstormDocument
  >,
  'brainstorm:finalize': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number, note?: string],
    BrainstormDocument
  >,
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
  'assignment:getActive': {} as Contract<
    [projectId: string, coordinatorThreadId: string],
    AssignmentPlan | null
  >,
  'assignment:listVersions': {} as Contract<
    [projectId: string, coordinatorThreadId: string, assignmentId: string],
    AssignmentPlan[]
  >,
  'assignment:saveDraft': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      content: AssignmentPlanContent,
      provenance: NewAssignmentProvenance
    ],
    AssignmentPlan
  >,
  'assignment:addAnnotation': {} as Contract<
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
  >,
  'assignment:updateAnnotation': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AssignmentPlan
  >,
  'assignment:resolveAnnotation': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      assignmentId: string,
      version: number,
      annotationId: string
    ],
    AssignmentPlan
  >,
  'assignment:updateUnlinkedWorkerModel': {} as Contract<
    [
      projectId: string,
      coordinatorThreadId: string,
      taskId: string,
      model: AssignmentModelSelection
    ],
    AssignmentPlan
  >,
  'assignment:validate': {} as Contract<
    [content: AssignmentPlanContent],
    AssignmentValidationResult
  >,
  'assignment:openInEditor': {} as Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >,
  'assignment:revealInFiles': {} as Contract<
    [projectId: string, coordinatorThreadId: string, content: AssignmentPlanContent],
    string
  >,
  'agent:abort': {} as Contract<[projectId: string, threadId: string], void>,
  'memory:getLayers': {} as Contract<
    [projectId: string, threadId: string],
    import('./types').BehaviorLayer[]
  >,
  'memory:getRaw': {} as Contract<[projectId?: string, threadId?: string], string>,
  'memory:saveRaw': {} as Contract<[markdown: string, projectId?: string, threadId?: string], void>,
  'memory:getEntries': {} as Contract<
    [projectId?: string, threadId?: string],
    import('./types').MemoryEntry[]
  >,
  'memory:saveEntries': {} as Contract<
    [entries: import('./types').MemoryEntry[], projectId?: string, threadId?: string],
    void
  >,
  'memory:getMergedEntries': {} as Contract<[projectId: string], import('./types').MemoryEntry[]>,
  'memory:addEntry': {} as Contract<
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
  >,
  'memory:removeEntry': {} as Contract<
    [entryId: string, projectId?: string, threadId?: string],
    boolean
  >,
  'memory:searchEntries': {} as Contract<
    [
      query: string,
      options?: {
        category?: import('./types').MemoryCategory
        priority?: import('./types').MemoryPriority
        projectId?: string
      }
    ],
    import('./types').MemoryEntry[]
  >,
  'memory:getPendingProposals': {} as Contract<
    [projectId?: string],
    import('./types').MemoryProposal[]
  >,
  'memory:approveProposal': {} as Contract<
    [proposalId: string, projectId?: string],
    import('./types').MemoryEntry | null
  >,
  'memory:rejectProposal': {} as Contract<[proposalId: string, projectId?: string], boolean>,
  'memory:createProposal': {} as Contract<
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
  >,
  'memory:export': {} as Contract<
    [kind: import('./types').MemoryExportKind, projectId?: string],
    string | null
  >,
  'memory:import': {} as Contract<[], import('./types').MemoryImportPreview | null>,
  'memory:importApply': {} as Contract<
    [
      preview: import('./types').MemoryImportPreview,
      kind: import('./types').MemoryExportKind,
      projectId?: string
    ],
    { added: number; skipped: number }
  >,
  'agent:compact': {} as Contract<[projectId: string, threadId: string], void>,
  'agent:answerQuestion': {} as Contract<
    [projectId: string, threadId: string, requestId: string, answers: string[][]],
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
  'agent:generateAssignmentDraft': {} as Contract<
    [projectId: string, coordinatorThreadId: string, settings: ThreadSettings],
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
    [projectId: string, threadId: string],
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
    [projectId: string, threadId: string],
    AgentContextCapabilities
  >,
  'agent:listArtifacts': {} as Contract<[projectId: string, threadId: string], AgentArtifact[]>,
  'agent:listProcesses': {} as Contract<
    [projectId: string, threadId: string],
    AgentRunningProcess[]
  >,
  'agent:killProcess': {} as Contract<[projectId: string, threadId: string, pid: number], void>,
  'agent:killThreadProcesses': {} as Contract<[projectId: string, threadId: string], void>,
  'taskManager:list': {} as Contract<[], TaskManagerSnapshot>,
  'taskManager:killProcess': {} as Contract<[pid: number, force: boolean], void>,
  'capabilities:readSkill': {} as Contract<
    [source: AgentCapabilitySource],
    NativeSkillContent | null
  >,
  'capabilities:updateSkill': {} as Contract<
    [source: AgentCapabilitySource, instructions: string],
    boolean
  >,
  'capabilities:deleteSkill': {} as Contract<[source: AgentCapabilitySource], boolean>,
  'capabilities:readMcp': {} as Contract<[source: AgentCapabilitySource], NativeMcpContent | null>,
  'capabilities:updateMcp': {} as Contract<
    [source: AgentCapabilitySource, content: NativeMcpContent],
    boolean
  >,
  'capabilities:deleteMcp': {} as Contract<[source: AgentCapabilitySource], boolean>,
  'capabilities:listAll': {} as Contract<[], AgentCapabilityCatalog>,
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
  'temporary-chat:convertToThread': {} as Contract<
    [
      projectId: string,
      threadId: string,
      temporaryChatId: string,
      settings: ThreadSettings,
      title?: string
    ],
    Thread
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
  'checklist:generate': {} as Contract<
    [projectId: string, threadId: string, planContent: string],
    Checklist
  >,
  'checklist:get': {} as Contract<[projectId: string, threadId: string], Checklist | null>,
  'checklist:updateItem': {} as Contract<
    [
      projectId: string,
      threadId: string,
      itemId: string,
      status: ChecklistItem['status'],
      evidence?: string
    ],
    Checklist | null
  >,
  'checkpoint:list': {} as Contract<[projectId: string, threadId: string], TurnCheckpointSummary[]>,
  'checkpoint:activeSummary': {} as Contract<
    [projectId: string, threadId: string],
    TurnCheckpointSummary | null
  >,
  'checkpoint:liveDiff': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >,
  'checkpoint:diff': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, path: string],
    TurnCheckpointFileDiff
  >,
  'checkpoint:rollback': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string],
    TurnCheckpointSummary[]
  >,
  'checkpoint:rollbackPaths': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >,
  'checkpoint:redoPaths': {} as Contract<
    [projectId: string, threadId: string, checkpointId: string, paths: string[]],
    TurnCheckpointSummary[]
  >,
  'config:get': {} as Contract<[], AppConfig>,
  'config:update': {} as Contract<[patch: AppConfigPatch], AppConfig>,
  'visionModels:list': {} as Contract<[], VisionModelRecord[]>,
  'config:syncAgentRole': {} as Contract<
    [role: AgentRole, selection: AgentModelSelection],
    AppConfig
  >,
  'cioPrompts:list': {} as Contract<[], CioPromptSetting[]>,
  'cioPrompts:save': {} as Contract<[id: CioPromptId, template: string], CioPromptSetting[]>,
  'cioPrompts:reset': {} as Contract<[id: CioPromptId], CioPromptSetting[]>,
  'workerNames:getSettings': {} as Contract<[], WorkerNameSettings>,
  'workerNames:saveCustom': {} as Contract<[names: string[]], void>,
  'dialog:pickFolder': {} as Contract<[], string | null>,
  'dialog:pickCloneDestination': {} as Contract<[], string | null>,
  'git:defaultClonePath': {} as Contract<[url: string], string>,
  'git:cloneHandoff': {} as Contract<
    [input: { url: string; destination?: string }],
    { command: string; args: string[]; destination: string; repoName: string }
  >,
  'clipboard:saveImage': {} as Contract<[scope: AttachmentStorageScope], string | null>,
  'attachment:saveText': {} as Contract<
    [scope: AttachmentStorageScope, text: string, existingPath?: string],
    string
  >,
  'attachment:beginRemoteUpload': {} as Contract<
    [scope: AttachmentStorageScope, filename: string, size: number],
    string
  >,
  'attachment:appendRemoteUpload': {} as Contract<
    [uploadId: string, offset: number, base64Chunk: string],
    number
  >,
  'attachment:finishRemoteUpload': {} as Contract<[uploadId: string], string>,
  'attachment:cancelRemoteUpload': {} as Contract<[uploadId: string], void>,
  'attachment:readRemoteChunk': {} as Contract<
    [path: string, offset: number],
    { base64: string; nextOffset: number; size: number }
  >,
  'remotePush:getPublicKey': {} as Contract<[], string>,
  'remotePush:subscribe': {} as Contract<
    [
      subscription: {
        endpoint: string
        expirationTime: number | null
        keys: { p256dh: string; auth: string }
      }
    ],
    void
  >,
  'remotePush:unsubscribe': {} as Contract<[endpoint: string], void>,
  'clipboard:writeText': {} as Contract<[text: string], void>,
  'clipboard:readText': {} as Contract<[], string>,
  'speech:getCapabilities': {} as Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCapabilitySnapshot>
  >,
  'speech:getCatalog': {} as Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechModelCatalog>
  >,
  'speech:beginCapture': {} as Contract<
    [scope: import('./speech/types').SpeechScope, mimeType: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCaptureSessionInfo>
  >,
  'speech:beginNativeCapture': {} as Contract<
    [scope: import('./speech/types').SpeechScope],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechCaptureSessionInfo>
  >,
  'speech:recordPermissionFailure': {} as Contract<
    [scope: import('./speech/types').SpeechScope, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:appendCapture': {} as Contract<
    [sessionId: string, chunk: Uint8Array<ArrayBuffer>],
    import('./speech/types').SpeechResult<number>
  >,
  'speech:finishCapture': {} as Contract<
    [sessionId: string, durationMs: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:finishNativeCapture': {} as Contract<
    [sessionId: string, durationMs: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:failCapture': {} as Contract<
    [sessionId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:failNativeCapture': {} as Contract<
    [sessionId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:markAttemptFailure': {} as Contract<
    [attemptId: string, message: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechRecordingAttempt>
  >,
  'speech:transcribe': {} as Contract<
    [
      attemptId: string,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      language: string,
      cleanupMode: import('./speech/types').SpeechCleanupMode
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >,
  'speech:preloadAsr': {} as Contract<
    [runtime: import('./speech/types').SpeechRuntime, artifactId: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:getHistory': {} as Contract<
    [cursor?: string, limit?: number],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechHistoryPage>
  >,
  'speech:enforceHistoryLimit': {} as Contract<
    [limit: number],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:transcribeAudioToLlm': {} as Contract<
    [
      attemptId: string,
      scope: import('./speech/types').SpeechScope,
      language: string,
      cleanupMode: import('./speech/types').SpeechCleanupMode
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >,
  'speech:validateModelPath': {} as Contract<
    [path: string, capability: import('./speech/types').SpeechCapability],
    import('./speech/types').SpeechResult<import('./speech/types').ModelPathValidationResult>
  >,
  'speech:importModel': {} as Contract<
    [path: string, capability?: import('./speech/types').SpeechCapability],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechInstalledArtifact>
  >,
  'speech:unregisterModel': {} as Contract<
    [artifactId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:downloadArtifact': {} as Contract<
    [artifactId: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:cancelDownload': {} as Contract<
    [artifactId: string],
    import('./speech/types').SpeechResult<boolean>
  >,
  'speech:cancelJob': {} as Contract<
    [jobId: string],
    import('./speech/types').SpeechResult<boolean>
  >,
  'speech:getLessons': {} as Contract<
    [scope?: import('./speech/types').SpeechScope],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson[]>
  >,
  'speech:observeCorrection': {} as Contract<
    [observation: import('./speech/types').SpeechLearningObservation],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson[]>
  >,
  'speech:setLessonEnabled': {} as Contract<
    [lessonId: string, enabled: boolean],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLesson>
  >,
  'speech:deleteLesson': {} as Contract<
    [lessonId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:getLlamaRuntimeStatus': {} as Contract<
    [],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechLlamaRuntimeStatus>
  >,
  'speech:downloadLlamaRuntime': {} as Contract<[], import('./speech/types').SpeechResult<void>>,
  'speech:requestConfirmation': {} as Contract<
    [action: import('./speech/types').SpeechDestructiveAction, targetId: string],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechConfirmation>
  >,
  'speech:deleteHistory': {} as Contract<
    [attemptId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:deleteAllHistory': {} as Contract<
    [confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:readAudio': {} as Contract<
    [attemptId: string],
    import('./speech/types').SpeechResult<Uint8Array<ArrayBuffer>>
  >,
  'speech:retryTranscription': {} as Contract<
    [
      attemptId: string,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      language: string
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechTranscriptionResult>
  >,
  'speech:deleteArtifact': {} as Contract<
    [artifactId: string, confirmationToken: string],
    import('./speech/types').SpeechResult<void>
  >,
  'speech:preparePlayback': {} as Contract<
    [messageId: string, markdown: string, includeCodeBlocks: boolean],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechPreparedPlayback>
  >,
  'speech:synthesizePlaybackSegment': {} as Contract<
    [
      sessionId: string,
      segmentIndex: number,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      voiceId: string
    ],
    import('./speech/types').SpeechResult<import('./speech/types').SpeechSynthesizedSegment>
  >,
  'speech:cancelPlayback': {} as Contract<
    [sessionId?: string],
    import('./speech/types').SpeechResult<boolean>
  >,
  /** Stage renderer-recorded audio bytes for the ephemeral Sound Playground. */
  'speech:playgroundStage': {} as Contract<
    [audio: Uint8Array<ArrayBuffer>, mimeType: string],
    import('./speech/types').SpeechResult<{ token: string; byteSize: number }>
  >,
  /** Import a user-picked audio file into the ephemeral Sound Playground. */
  'speech:playgroundImportPath': {} as Contract<
    [path: string],
    import('./speech/types').SpeechResult<{ token: string; byteSize: number; fileName: string }>
  >,
  'speech:playgroundReadAudio': {} as Contract<
    [token: string],
    import('./speech/types').SpeechResult<Uint8Array<ArrayBuffer>>
  >,
  'speech:playgroundTranscribe': {} as Contract<
    [
      token: string,
      runtime: import('./speech/types').SpeechRuntime,
      artifactId: string,
      language: string,
      cleanupMode: import('./speech/types').SpeechCleanupMode
    ],
    import('./speech/types').SpeechResult<{ rawTranscript: string; finalTranscript: string }>
  >,
  'speech:playgroundDiscard': {} as Contract<
    [token: string],
    import('./speech/types').SpeechResult<void>
  >,
  /** Read a user-picked text/PDF file for the Playground read-aloud section. */
  'speech:playgroundReadText': {} as Contract<
    [path: string],
    { text: string; fileName: string; truncated: boolean } | null
  >,
  'dialog:pickFile': {} as Contract<[scope?: AttachmentStorageScope], string | null>,
  'dialog:pickFiles': {} as Contract<[scope?: AttachmentStorageScope], string[]>,
  'dialog:pickImage': {} as Contract<[], string | null>,
  'diagnostics:export': {} as Contract<[], string | null>,
  /** Open the app-owned data directory in the operating system's file manager. */
  'storage:openDataDirectory': {} as Contract<[], boolean>,
  'file:read': {} as Contract<[filePath: string], Uint8Array<ArrayBuffer> | null>,
  'file:readAsDataUrl': {} as Contract<[filePath: string], string | null>,
  'file:readDocumentPreview': {} as Contract<[filePath: string], string | null>,
  'editors:detect': {} as Contract<[], EditorInfo[]>,
  'editors:getPreferred': {} as Contract<[], EditorId>,
  'editors:setPreferred': {} as Contract<[editorId: EditorId], void>,
  'git:status': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:diff': {} as Contract<
    [projectId: string, relativePath: string, staged: boolean, scopeBucketId?: string],
    GitDiff
  >,
  'git:analyzeConflict': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictAnalysis
  >,
  'git:prepareConflictWorkFile': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    GitConflictWorkFile
  >,
  'git:saveConflictDraft': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      stateJson: string,
      scopeBucketId?: string
    ],
    void
  >,
  'git:saveConflictResolution': {} as Contract<
    [projectId: string, relativePath: string, content: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:stage': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:resolveConflicted': {} as Contract<
    [projectId: string, path: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:unstage': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:restoreFiles': {} as Contract<
    [
      projectId: string,
      source: string,
      paths: string[],
      target: import('./types').GitRestoreTarget,
      scopeBucketId?: string
    ],
    GitStatus
  >,
  'git:commit': {} as Contract<
    [projectId: string, message: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:init': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:branches': {} as Contract<[projectId: string, scopeBucketId?: string], GitBranchInfo[]>,
  'git:defaultBranch': {} as Contract<[projectId: string, scopeBucketId?: string], string | null>,
  'git:checkout': {} as Contract<
    [projectId: string, branch: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:createBranch': {} as Contract<
    [projectId: string, name: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:createTrackingBranch': {} as Contract<
    [projectId: string, remote: string, branch: string, localName: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:deleteBranch': {} as Contract<
    [projectId: string, name: string, force?: boolean, scopeBucketId?: string],
    GitStatus
  >,
  'git:log': {} as Contract<
    [projectId: string, limit?: number, offset?: number, query?: string, scopeBucketId?: string],
    GitCommitInfo[]
  >,
  'git:commitDiff': {} as Contract<
    [projectId: string, hash: string, scopeBucketId?: string],
    GitFileChange[]
  >,
  'git:commitFileDiff': {} as Contract<
    [projectId: string, hash: string, path: string, scopeBucketId?: string],
    GitDiff
  >,
  'git:amend': {} as Contract<
    [projectId: string, message: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:reset': {} as Contract<
    [
      projectId: string,
      mode: import('./types').GitResetMode,
      target?: string,
      scopeBucketId?: string
    ],
    GitStatus
  >,
  'git:deleteCommit': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:getIdentity': {} as Contract<[projectId: string, scopeBucketId?: string], GitIdentity>,

  'git:setIdentity': {} as Contract<
    [projectId: string, identity: GitIdentityInput, scopeBucketId?: string],
    GitIdentity
  >,
  'git:remotes': {} as Contract<[projectId: string, scopeBucketId?: string], GitRemoteInfo[]>,
  'git:addRemote': {} as Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:setRemoteUrl': {} as Contract<
    [projectId: string, name: string, url: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:removeRemote': {} as Contract<
    [projectId: string, name: string, scopeBucketId?: string],
    GitRemoteInfo[]
  >,
  'git:fetch': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:fetchBranch': {} as Contract<
    [projectId: string, remote: string, branch: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:pull': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:pullIntegrate': {} as Contract<
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
  >,
  'git:push': {} as Contract<
    [
      projectId: string,
      options: { setUpstream: boolean; remote?: string; branch?: string },
      scopeBucketId?: string
    ],
    GitStatus
  >,
  'git:getCredentialStatus': {} as Contract<[projectId: string], GitCredentialStatus>,
  'git:setCredential': {} as Contract<[projectId: string, token: string], GitCredentialStatus>,
  'git:removeCredential': {} as Contract<[projectId: string], GitCredentialStatus>,
  'git:merge': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    MergeSummary
  >,
  'git:rebase': {} as Contract<
    [projectId: string, target: string, scopeBucketId?: string],
    MergeSummary
  >,
  'git:preparePrResolve': {} as Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >,
  'git:finishPrResolve': {} as Contract<
    [projectId: string, options: PrResolveOptions, scopeBucketId?: string],
    GitStatus
  >,
  'git:stash': {} as Contract<
    [projectId: string, message?: string, paths?: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:ignore': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:discard': {} as Contract<
    [projectId: string, paths: string[], scopeBucketId?: string],
    GitStatus
  >,
  'git:stashList': {} as Contract<[projectId: string, scopeBucketId?: string], GitStashEntry[]>,
  'git:stashPop': {} as Contract<
    [projectId: string, id?: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:stashDrop': {} as Contract<
    [projectId: string, id?: string, scopeBucketId?: string],
    GitStatus
  >,
  'git:stashDiff': {} as Contract<
    [projectId: string, id: string, scopeBucketId?: string],
    GitFileChange[]
  >,
  'git:stashFileDiff': {} as Contract<
    [projectId: string, id: string, path: string, scopeBucketId?: string],
    GitDiff
  >,
  'git:abortMerge': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'git:abortRebase': {} as Contract<[projectId: string, scopeBucketId?: string], GitStatus>,
  'pr:create': {} as Contract<
    [projectId: string, input: PrCreateInput, scopeBucketId?: string],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:list': {} as Contract<
    [projectId: string, owner: string, repo: string, state?: string],
    PullRequestReference[]
  >,
  'pr:merge': {} as Contract<
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
  >,
  'pr:ready': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:compare': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      base: string,
      head: string,
      scopeBucketId?: string
    ],
    PullRequestCompare
  >,
  'pr:reopen': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:close': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:update': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      title: string | undefined,
      body: string | undefined
    ],
    GitHubMutationResult<PullRequestReference>
  >,
  'pr:page': {} as Contract<
    [projectId: string, owner: string, repo: string, state: PrState, page: number],
    PullRequestPage
  >,
  /**
   * Read one pull request's detail. Hitting the detail endpoint forces GitHub
   * to compute mergeability, so it is used as the authoritative mergeability
   * probe when a list payload reported `mergeable`/`mergeable_state` as null.
   */
  'pr:detail': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    PullRequestDetail
  >,
  'deployment:overview': {} as Contract<
    [projectId: string, owner: string, repo: string],
    GitHubDeploymentOverviewResult
  >,
  'deployment:detail': {} as Contract<
    [projectId: string, owner: string, repo: string, deploymentId: number],
    GitHubDeploymentDetail
  >,
  'deployment:runDetail': {} as Contract<
    [projectId: string, owner: string, repo: string, runId: number],
    GitHubWorkflowRunDetail
  >,
  'deployment:jobLog': {} as Contract<
    [projectId: string, owner: string, repo: string, jobId: number],
    GitHubDeploymentJobLog
  >,
  /**
   * Read a project's cloud deployment config, or null when none exists. The
   * config is persisted by main under the CodeInOven config directory; the
   * renderer never touches the filesystem or Node APIs for it.
   */
  'cloudDeploy:getConfig': {} as Contract<
    [projectId: string],
    import('./types').CloudDeploymentConfig | null
  >,
  /**
   * Persist a project's cloud deployment config (selected providers + labelled
   * containers with credential references) and refresh the project's
   * has-deployments flag for panel visibility. Returns the stored config.
   */
  'cloudDeploy:saveConfig': {} as Contract<
    [projectId: string, config: import('./types').CloudDeploymentConfig],
    import('./types').CloudDeploymentConfig
  >,
  /** Remove a project's cloud deployment config and clear its has-deployments flag. */
  'cloudDeploy:clearConfig': {} as Contract<[projectId: string], void>,
  /** Update a container's label/id in a project's config. Returns the stored config. */
  'cloudDeploy:updateContainer': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string,
      patch: { label?: string; id?: string }
    ],
    import('./types').CloudDeploymentConfig
  >,
  /** Remove a container from a project's config. Returns the stored config. */
  'cloudDeploy:removeContainer': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentConfig
  >,
  /** List every provider account in the global registry. */
  'cloudDeploy:listAccounts': {} as Contract<[], import('./types').CloudDeploymentAccountRegistry>,
  /**
   * Create a new provider account in the GLOBAL registry and vault its token by
   * account id. The account is reusable across every project that attaches it.
   * The plaintext token is vaulted by main via `safeStorage` and never crosses
   * back to the renderer. Returns the sanitized account (no secret).
   */
  'cloudDeploy:createAccount': {} as Contract<
    [
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountLabel: string,
      token: string,
      baseUrl?: string
    ],
    import('./types').CloudDeploymentProviderAccount
  >,
  /** Update a global provider account's metadata (label, base URL, enabled). */
  'cloudDeploy:updateAccount': {} as Contract<
    [
      accountId: string,
      patch: {
        label?: string
        baseUrl?: string
        enabled?: boolean
      }
    ],
    import('./types').CloudDeploymentProviderAccount
  >,
  /**
   * Rotate a global provider account's secret. Update-only: the token is vaulted
   * and the current secret is never returned to the renderer. Returns the
   * sanitized account (secretRef cleared).
   */
  'cloudDeploy:rotateAccountSecret': {} as Contract<
    [accountId: string, token: string],
    import('./types').CloudDeploymentProviderAccount
  >,
  /** Remove a global provider account and its vaulted token. */
  'cloudDeploy:removeAccount': {} as Contract<[accountId: string], void>,
  /** Attach a global provider account to a project for a provider kind. */
  'cloudDeploy:attachAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >,
  /** Detach a global provider account from a project for a provider kind. */
  'cloudDeploy:detachAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >,
  /** Set which attached account is active for a provider within a project. */
  'cloudDeploy:setActiveAccount': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      accountId: string
    ],
    import('./types').CloudDeploymentConfig
  >,
  /**
   * Fetch a provider-agnostic snapshot of a configured provider's containers.
   * The adapter is resolved by kind via the registry; `hasDeployments` drives
   * whether the Cloud Deployments panel is shown at all. Provider/credential
   * failures are returned as `accessError` rather than rejecting IPC.
   */
  'cloudDeploy:overview': {} as Contract<
    [projectId: string, providerKind: import('./types').CloudDeploymentProviderKind],
    import('./types').CloudDeploymentResult
  >,
  /**
   * List every container the account can see on the provider (not filtered to
   * this project's mappings), so the add-container flow can offer a picker.
   * Provider/credential failures are returned as `{ accessError }`.
   */
  'cloudDeploy:availableContainers': {} as Contract<
    [projectId: string, providerKind: import('./types').CloudDeploymentProviderKind],
    import('./types').CloudDeploymentContainer[] | { accessError: string }
  >,
  /**
   * Latest snapshot for one configured container, or null when the provider
   * cannot resolve it.
   */
  'cloudDeploy:containerStatus': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentContainer | null
  >,
  /**
   * List the most recent deployments/builds for a container, newest first
   * (bounded to a UI window such as the last ten).
   */
  'cloudDeploy:deployments': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string
    ],
    import('./types').CloudDeploymentDeployment[]
  >,
  /** Capped raw log text for a container's latest deployment. */
  'cloudDeploy:containerLog': {} as Contract<
    [
      projectId: string,
      providerKind: import('./types').CloudDeploymentProviderKind,
      containerId: string,
      deploymentId?: string
    ],
    { containerId: string; deploymentId: string | null; log: string }
  >,
  /** Everything the PR detail view needs, fetched in parallel in one round trip. */
  'pr:bundle': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number],
    PullRequestBundle
  >,
  'pr:commitFiles': {} as Contract<
    [projectId: string, owner: string, repo: string, sha: string],
    PullRequestFile[]
  >,
  /** Read back the agent's `.cio/git/pr/<number>/review.md`, if it wrote one. */
  'pr:agentReport': {} as Contract<[projectId: string, pullNumber: number], PrAgentReport>,
  'pr:comment': {} as Contract<
    [projectId: string, owner: string, repo: string, pullNumber: number, body: string],
    GitHubMutationResult<PullRequestComment>
  >,
  'pr:review': {} as Contract<
    [
      projectId: string,
      owner: string,
      repo: string,
      pullNumber: number,
      event: PrReviewEvent,
      body: string
    ],
    PullRequestReviewResult
  >,
  /** Create `.cio/git/pr/<number>/` for an agent review and return its absolute path. */
  'pr:reviewWorkspace': {} as Contract<
    [projectId: string, pullNumber: number, threadId?: string],
    string
  >,
  /** Run the PR-compose agent virtually and consume its temporary report. */
  'pr:composeWithAgent': {} as Contract<
    [
      projectId: string,
      scopeBucketId: string,
      virtualTaskId: string,
      settings: ThreadSettings,
      input: import('./types').PrComposeInput
    ],
    PrComposeReport
  >,
  'github:authStatus': {} as Contract<[], GitHubAuthStatus>,
  'github:startDeviceFlow': {} as Contract<[], GitHubDeviceCode>,
  'github:poll': {} as Contract<[deviceCode: string], GitHubPollResult>,
  'github:logout': {} as Contract<[], GitHubAuthStatus>,
  'history:search': {} as Contract<
    [query: string, projectId?: string, limit?: number],
    HistoryEntry[]
  >,
  'project:search': {} as Contract<[query: string, limit?: number], Project[]>,
  'threads:search': {} as Contract<
    [query: string, options?: { projectId?: string; limit?: number }],
    import('./types').ThreadSearchResult[]
  >,
  'history:append': {} as Contract<
    [
      projectId: string,
      threadId: string,
      role: HistoryRole,
      content: string,
      metadata?: HistoryEntry['metadata']
    ],
    HistoryEntry
  >,
  'scope:get': {} as Contract<[projectId: string], ScopeBoard>,
  'scope:updateLayout': {} as Contract<[projectId: string, orderedIds: string[]], ScopeBoard>,
  'scope:updateAppearance': {} as Contract<
    [projectId: string, bucketId: string, patch: ScopeAppearancePatch],
    ScopeBoard
  >,
  'scope:updateCollapse': {} as Contract<
    [projectId: string, bucketId: string, patch: ScopeCollapsePatch],
    ScopeBoard
  >,
  'scope:create': {} as Contract<
    [projectId: string, input: ScopeCreateInput],
    { board: ScopeBoard; bucket: ScopeBucket }
  >,
  'scope:setArchive': {} as Contract<
    [projectId: string, bucketId: string, archived: boolean],
    ScopeBoard
  >,
  /** Pin or unpin a scope; pinned scopes are exempt from thread eviction. */
  'scope:setPinned': {} as Contract<
    [projectId: string, bucketId: string, pinned: boolean],
    ScopeBoard
  >,
  'scope:delete': {} as Contract<[projectId: string, bucketId: string], ScopeBoard>,
  /** Create an isolated managed worktree and attach it to a scope. */
  'scope:worktree:create': {} as Contract<
    [target: ScopeTarget, input: ScopeWorktreeCreateInput],
    ManagedWorktreeDescriptor
  >,
  /** Inspect the source checkout before creating a worktree. */
  'scope:worktree:sourceInfo': {} as Contract<[projectId: string], ScopeWorktreeSourceInfo>,
  /** Refresh the typed health state of a managed scope. */
  'scope:worktree:health': {} as Contract<[target: ScopeTarget], ScopeWorktreeHealth>,
  /** Repair an unhealthy managed scope according to its health category. */
  'scope:worktree:repair': {} as Contract<[target: ScopeTarget], ScopeWorktreeHealth>,
  /** Preview whether an existing Git worktree checkout can be adopted. */
  'scope:worktree:detectAdopt': {} as Contract<
    [projectId: string, sourcePath: string],
    AdoptableWorktreeInfo
  >,
  /** Adopt an existing raw Git worktree as a managed scope root. */
  'scope:worktree:adopt': {} as Contract<
    [target: ScopeTarget, input: { sourcePath: string; runSetup: boolean }],
    ManagedWorktreeDescriptor
  >,
  /** Compute a state-bound preflight and mint a single-use confirmation token. */
  'scope:worktree:preflight': {} as Contract<
    [action: ScopeLifecycleAction, target: ScopeTarget, options?: { scopeBucketId?: string }],
    ScopeLifecyclePreflight
  >,
  /** Consume a confirmation token to detach a managed worktree. */
  'scope:worktree:confirmDetach': {} as Contract<
    [target: ScopeTarget, confirmationId: string],
    void
  >,
  /** Consume a confirmation token to remove a managed worktree (optionally forced). */
  'scope:worktree:confirmRemove': {} as Contract<
    [target: ScopeTarget, confirmationId: string, force: boolean],
    void
  >,
  /** Consume a separate confirmation token to delete a managed scope's branch. */
  'scope:worktree:confirmDeleteBranch': {} as Contract<
    [target: ScopeTarget, confirmationId: string],
    void
  >,
  /** Fully delete a managed scope: worktree, bucket, and optionally branch. */
  'scope:worktree:confirmDeleteScope': {} as Contract<
    [target: ScopeTarget, confirmationId: string, deleteBranch: boolean],
    void
  >,
  /** Retry a failed/interrupted setup from its failed command. */
  'scope:worktree:retrySetup': {} as Contract<
    [target: ScopeTarget, options: { runSetup: boolean }],
    ManagedWorktreeDescriptor
  >,
  /** Preflight merging a managed scope into another scope and mint a token. */
  'scope:worktree:mergePreflight': {} as Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode],
    ScopeMergePreflight
  >,
  /** Consume a merge token to merge a scope and apply its post-merge mode. */
  'scope:worktree:confirmMerge': {} as Contract<
    [target: ScopeTarget, mergeTarget: ScopeTarget, mode: ScopeMergeMode, confirmationId: string],
    ScopeMergeOutcome
  >,
  /** Update project-level managed-worktree defaults. */
  'scope:setWorktreeDefaults': {} as Contract<
    [projectId: string, defaults: ScopeWorktreeDefaults],
    ScopeBoard
  >,
  'history:load': {} as Contract<
    [projectId: string, threadId: string, limit?: number],
    HistoryEntry[]
  >,
  'notification:test': {} as Contract<[], SystemNotificationTestResult>,
  'notification:getPermissionStatus': {} as Contract<[], SystemNotificationPermissionStatus>,
  /**
   * Open the OS notification-settings pane (System Settings on macOS, Settings
   * on Windows). The target URL is a hard-coded, platform-specific allow-list
   * constant resolved in the main process — never renderer-supplied — so it is
   * safe to bypass the web-only external-URL validator. Returns false when the
   * platform has no notification-settings deep link.
   */
  'notification:openSettings': {} as Contract<[], boolean>,
  'plan:approve': {} as Contract<[projectId: string, threadId: string], Plan | null>,
  'plan:get': {} as Contract<[projectId: string, threadId: string], Plan | null>,
  'plan:save': {} as Contract<[projectId: string, threadId: string, content: string], Plan>,
  'project:create': {} as Contract<[input: CreateProjectInput], Project>,
  'project:delete': {} as Contract<[projectId: string], void>,
  'project:ensureInbox': {} as Contract<[], Project>,
  'project:get': {} as Contract<[projectId: string], Project | null>,
  'project:getIcon': {} as Contract<[projectId: string], string | null>,
  'project:list': {} as Contract<[], Project[]>,
  'project:openInEditor': {} as Contract<[projectId: string], void>,
  'project:reorder': {} as Contract<[orderedIds: string[]], Project[]>,
  'project:setPinned': {} as Contract<[projectId: string, pinned: boolean], Project>,
  'project:setIcon': {} as Contract<[projectId: string, sourcePath: string], Project>,
  'project:clearIcon': {} as Contract<[projectId: string], Project>,
  'project:update': {} as Contract<
    [projectId: string, input: Partial<CreateProjectInput>],
    Project
  >,
  'projectFiles:list': {} as Contract<
    [projectId: string, relativeDirectory: string, scopeBucketId?: string],
    ProjectFileEntry[]
  >,
  'projectFiles:search': {} as Contract<
    [projectId: string, query: string, category: 'all' | 'rules', scopeBucketId?: string],
    ProjectFileEntry[]
  >,
  'projectFiles:resolveCitationPaths': {} as Contract<
    [projectId: string, candidates: string[], scopeBucketId?: string],
    Record<string, string | null>
  >,
  'projectFiles:resolveExternalCitationPaths': {} as Contract<
    [absolutePaths: string[]],
    Record<string, boolean>
  >,
  'projectFiles:create': {} as Contract<
    [projectId: string, relativeDirectory: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >,
  'projectFiles:createDirectory': {} as Contract<
    [projectId: string, relativeDirectory: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >,
  'projectFiles:delete': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    void
  >,
  'projectFiles:info': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    ProjectFileInfo
  >,
  'projectFiles:openInEditor': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    void
  >,
  'projectFiles:openInEditorWith': {} as Contract<
    [projectId: string, relativePath: string, editorId: EditorId, scopeBucketId?: string],
    void
  >,
  'projectFiles:saveAs': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    string | null
  >,
  'projectFiles:paste': {} as Contract<
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
  >,
  'projectFiles:importPaths': {} as Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string
    ],
    ProjectFileEntry[]
  >,
  'projectFiles:dropPaths': {} as Contract<
    [
      projectId: string,
      sourcePaths: string[],
      destinationDirectory: string,
      scopeBucketId?: string
    ],
    ProjectFileDropResult[]
  >,
  'projectFiles:read': {} as Contract<
    [projectId: string, relativePath: string, scopeBucketId?: string],
    /** null when the file cannot be read as text (binary, too large, missing). */
    ProjectTextFile | null
  >,
  'projectFiles:rename': {} as Contract<
    [projectId: string, relativePath: string, name: string, scopeBucketId?: string],
    ProjectFileEntry
  >,
  'projectFiles:save': {} as Contract<
    [
      projectId: string,
      relativePath: string,
      content: string,
      expectedRevision: string,
      scopeBucketId?: string
    ],
    ProjectTextFile
  >,
  'providers:check': {} as Contract<[providerId: string], ProviderConnectionInfo>,
  'providers:checkAll': {} as Contract<[force?: boolean], ProviderConnectionInfo[]>,
  'providers:getStatus': {} as Contract<[], ProviderConnectionInfo[]>,
  'harnessUpdates:check': {} as Contract<[harnessId: string], HarnessUpdateStatus>,
  'harnessUpdates:checkAll': {} as Contract<[force?: boolean], HarnessUpdateStatus[]>,
  'harnessUpdates:handoff': {} as Contract<[harnessId: string], HarnessUpdateHandoff>,
  'harnessInstall:getInfo': {} as Contract<[harnessId: string], HarnessInstallInfo>,
  'harnessInstall:handoff': {} as Contract<[harnessId: string], HarnessInstallHandoff>,
  'harnessUninstall:handoff': {} as Contract<[harnessId: string], HarnessUninstallHandoff>,
  'harnessManifest:list': {} as Contract<[], HarnessManifestEntry[]>,
  'harnessManifest:confirm': {} as Contract<
    [input: { harnessId: string; behavior: string; value: boolean }],
    void
  >,
  'harnessManifest:reset': {} as Contract<[input: { harnessId: string; behavior: string }], void>,
  'harnessAutoUpdate:list': {} as Contract<[], Record<string, boolean>>,
  'harnessAutoUpdate:set': {} as Contract<[input: { harnessId: string; value: boolean }], void>,
  'providerAccounts:getAuthStatus': {} as Contract<
    [harnessId: string, projectPath?: string],
    ProviderAccountAuthStatus
  >,
  'providerAccounts:list': {} as Contract<
    [harnessId?: string, refresh?: boolean],
    HarnessAccount[]
  >,
  'providerAccounts:prepare': {} as Contract<
    [harnessId: string, providerId?: string],
    PendingHarnessAccount
  >,
  'providerAccounts:inspectPending': {} as Contract<
    [pendingAccountId: string],
    ProviderAccountAuthStatus
  >,
  'providerAccounts:finalizePending': {} as Contract<
    [pendingAccountId: string, providerId: string, label?: string],
    HarnessAccount
  >,
  'providerAccounts:cancelPending': {} as Contract<[pendingAccountId: string], void>,
  'providerAccounts:rename': {} as Contract<[accountId: string, label: string], HarnessAccount>,
  'providerAccounts:remove': {} as Contract<[accountId: string], boolean>,
  'providerAccounts:beginLogin': {} as Contract<
    [harnessId: string, options?: ProviderAccountLoginOptions],
    ProviderAccountLoginHandoff
  >,
  'providerAccounts:listOffered': {} as Contract<[harnessId: string], OfferedProvider[]>,
  'providerAccounts:logout': {} as Contract<
    [harnessId: string, providerId?: string, accountId?: string],
    void
  >,
  'providerAccounts:setApiKey': {} as Contract<
    [harnessId: string, providerId: string, apiKey: string, accountId?: string],
    void
  >,
  'providerAccounts:beginOAuthLogin': {} as Contract<
    [harnessId: string, providerId: string, accountId?: string],
    string
  >,
  'providerAccounts:respondOAuthPrompt': {} as Contract<[loginId: string, value: string], void>,
  'providerAccounts:cancelOAuthLogin': {} as Contract<[loginId: string], void>,
  'providerAccounts:getHidden': {} as Contract<[harnessId: string], string[]>,
  'providerAccounts:setHidden': {} as Contract<
    [harnessId: string, providerId: string, hidden: boolean],
    string[]
  >,
  'baseUrlProviders:list': {} as Contract<[], BaseUrlProvider[]>,
  'baseUrlProviders:create': {} as Contract<[input: BaseUrlProviderCreateRequest], BaseUrlProvider>,
  'baseUrlProviders:update': {} as Contract<
    [harnessId: string, id: string, patch: BaseUrlProviderUpdateRequest],
    BaseUrlProvider
  >,
  'baseUrlProviders:delete': {} as Contract<[harnessId: string, id: string], boolean>,
  'baseUrlProviders:copyProviderToClipboard': {} as Contract<
    [input: BaseUrlProviderCopyClipboardRequest],
    void
  >,
  'baseUrlProviders:fetchModels': {} as Contract<
    [input: BaseUrlProviderFetchModelsRequest],
    DiscoveredBaseUrlModel[]
  >,
  'baseUrlProviders:fetchUsage': {} as Contract<
    [harnessId: string, id: string],
    import('./types').CustomProviderUsage | null
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
  'gateway:list': {} as Contract<[], import('./gateway-types').GatewayStatus[]>,
  'gateway:setEnabled': {} as Contract<
    [pluginId: string, enabled: boolean],
    import('./gateway-types').GatewayStatus
  >,
  'gateway:start': {} as Contract<[pluginId: string], import('./gateway-types').GatewayStatus>,
  'gateway:stop': {} as Contract<[pluginId: string], import('./gateway-types').GatewayStatus>,
  'gateway:uninstall': {} as Contract<[pluginId: string], import('./gateway-types').GatewayStatus>,
  'gateway:update': {} as Contract<[pluginId: string], import('./gateway-types').GatewayStatus>,
  'gateway:copyDashboardPassword': {} as Contract<[pluginId: string], void>,
  'gateway:refreshCatalog': {} as Contract<
    [pluginId: string],
    import('./gateway-types').GatewayModelInfo[]
  >,
  'utilities:list': {} as Contract<[options?: UtilitySearchOptions], UtilityCatalog>,
  'utilities:get': {} as Contract<[id: string], UtilityDefinition | null>,
  'utilities:create': {} as Contract<[input: UtilityDefinitionInput], UtilityDefinition>,
  'utilities:installBundle': {} as Contract<
    [request: UtilityBundleInstallRequest],
    UtilityDefinition[]
  >,
  'utilities:setupWithAgent': {} as Contract<
    [projectId: string, taskId: string, settings: ThreadSettings, request: string],
    UtilitySetupReport
  >,
  'utilities:searchSkillMarket': {} as Contract<[query: string], SkillMarketSearchResult>,
  'utilities:listSkillMarket': {} as Contract<[view: SkillMarketView], SkillMarketLeaderboard>,
  'utilities:getSkillMarketDetail': {} as Contract<[id: string], SkillMarketDetail>,
  'utilities:installMarketSkill': {} as Contract<[request: SkillMarketInstallRequest], string>,
  'utilities:update': {} as Contract<
    [id: string, patch: UtilityDefinitionPatch],
    UtilityDefinition
  >,
  'utilities:delete': {} as Contract<[id: string], boolean>,
  'utilities:setCredential': {} as Contract<
    [utilityId: string, input: UtilityCredentialInput],
    UtilityDefinition
  >,
  'utilities:removeCredential': {} as Contract<
    [utilityId: string, credentialId: string],
    UtilityDefinition
  >,
  'utilities:resolve': {} as Contract<[context: UtilityResolutionContext], ResolvedUtility[]>,
  'computerUse:getCuaStatus': {} as Contract<[], CuaBridgeStatus>,
  'computerUse:setCuaEnabled': {} as Contract<[enabled: boolean], CuaBridgeStatus>,
  'computerUse:pipGetState': {} as Contract<[], ComputerUsePipState>,
  'computerUse:pipBringToFront': {} as Contract<[], void>,
  'computerUse:pipDismiss': {} as Contract<[], void>,
  'pty:create': {} as Contract<
    [
      id: string,
      projectId: string,
      threadId: string,
      columns: number,
      rows: number,
      scopeBucketId?: string
    ],
    { id: string; pid: number }
  >,
  'pty:createCommand': {} as Contract<
    [
      id: string,
      command: string,
      args: string[],
      columns: number,
      rows: number,
      /** Kill the session after this many ms of zero output/input (e.g. hung updates). */
      idleTimeoutMs?: number,
      environment?: Record<string, string>
    ],
    { id: string; pid: number }
  >,
  'pty:createAction': {} as Contract<
    [
      id: string,
      projectId: string,
      threadId: string,
      script: string,
      variables: Record<string, string>,
      columns: number,
      rows: number,
      scopeBucketId?: string
    ],
    { id: string; pid: number }
  >,
  'pty:destroy': {} as Contract<[id: string], void>,
  'projectActions:list': {} as Contract<
    [projectId: string],
    import('./project-actions').ProjectAction[]
  >,
  'projectActions:save': {} as Contract<
    [
      projectId: string,
      actionId: string | null,
      input: import('./project-actions').ProjectActionInput,
      insertAfterId?: string | null
    ],
    import('./project-actions').ProjectAction
  >,
  'projectActions:delete': {} as Contract<[projectId: string, actionId: string], boolean>,
  'projectActions:reorder': {} as Contract<
    [projectId: string, orderedIds: string[]],
    import('./project-actions').ProjectAction[]
  >,
  'repository:init': {} as Contract<[projectPath: string], RepositoryPreflightResult>,
  'repository:preflight': {} as Contract<[projectPath: string], RepositoryPreflightResult>,
  'repository:remoteOrigin': {} as Contract<[projectPath: string], string | null>,
  'shell:openExternal': {} as Contract<[url: string], void>,
  'shell:revealPath': {} as Contract<[path: string], boolean>,
  /** Reveal an existing absolute path (e.g. an agent-cited file outside the
   *  project root) in the OS file manager. Existence is checked; no content is
   *  read or opened. Returns false when the path does not exist. */
  'shell:revealExternalPath': {} as Contract<[path: string], boolean>,
  /** Resolve website favicons for a list of hostnames. Returns a data URL per host, or null when none exists. */
  'web:favicon': {} as Contract<[hostnames: string[]], Record<string, string | null>>,
  'browser:show': {} as Contract<
    [
      tabId: string,
      projectId: string,
      threadId: string,
      initialUrl: string,
      bounds: BrowserViewBounds
    ],
    BrowserPageState
  >,
  'browser:hide': {} as Contract<[tabId: string], void>,
  'browser:navigate': {} as Contract<[tabId: string, url: string], void>,
  'browser:goBack': {} as Contract<[tabId: string], void>,
  'browser:goForward': {} as Contract<[tabId: string], void>,
  'browser:reload': {} as Contract<[tabId: string], void>,
  'browser:stop': {} as Contract<[tabId: string], void>,
  /** Toggle the web page's native DevTools. Returns whether it is now open. */
  'browser:toggleDevTools': {} as Contract<[tabId: string], boolean>,
  'browser:clearData': {} as Contract<[projectId: string], void>,
  'browser:clearSiteData': {} as Contract<
    [projectId: string, scopes: BrowserSiteDataScope[]],
    void
  >,
  'browser:resolvePermission': {} as Contract<
    [requestId: string, decision: BrowserPermissionDecision],
    void
  >,
  'browser:destroy': {} as Contract<[tabId: string], void>,
  'browser:destroyThread': {} as Contract<[projectId: string, threadId: string], void>,
  'browser:destroyProject': {} as Contract<[projectId: string], void>,
  'browser:getDownloads': {} as Contract<[projectId: string], BrowserDownload[]>,
  'browser:cancelDownload': {} as Contract<[id: string], void>,
  'browser:pauseDownload': {} as Contract<[id: string], void>,
  'browser:resumeDownload': {} as Contract<[id: string], void>,
  'browser:openDownload': {} as Contract<[id: string], void>,
  'browser:revealDownload': {} as Contract<[id: string], boolean>,
  /** Open the native Ctrl+Tab overlay above the browser view with a fresh
   *  display payload. Only used while the native browser view is on screen;
   *  otherwise the renderer uses the DOM switcher. */
  'switcher:open': {} as Contract<[payload: NativeSwitcherPayload], void>,
  'switcher:close': {} as Contract<[], void>,
  'spec:addAnnotation': {} as Contract<
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
  >,
  'spec:addDecisionComment': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      action: SpecDecisionAction,
      body: string
    ],
    EngineeringSpec
  >,
  'spec:approve': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >,
  'spec:captureContext': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      type: CapturableSpecContextType,
      selectedPath?: string
    ],
    EngineeringSpec | null
  >,
  'spec:createDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >,
  'spec:createVersion': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      content: EngineeringSpecContent,
      provenance: NewSpecProvenance
    ],
    EngineeringSpec
  >,
  'spec:dismissValidationIssue': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      issue: SpecValidationIssue
    ],
    EngineeringSpec
  >,
  'spec:exportMarkdown': {} as Contract<[spec: EngineeringSpec], string | null>,
  'spec:getActive': {} as Contract<[projectId: string, threadId: string], EngineeringSpec | null>,
  'spec:getContextAttachments': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    PromptAttachment[]
  >,
  'spec:importMarkdown': {} as Contract<
    [projectId: string, threadId: string, specId?: string],
    EngineeringSpec | null
  >,
  'spec:listVersions': {} as Contract<
    [projectId: string, threadId: string, specId: string],
    EngineeringSpec[]
  >,
  'spec:openInEditor': {} as Contract<[spec: EngineeringSpec], string>,
  'spec:revealInFiles': {} as Contract<[spec: EngineeringSpec], string>,
  'spec:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number, annotationId: string],
    EngineeringSpec
  >,
  'spec:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    EngineeringSpec
  >,
  'spec:saveDraft': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      content: EngineeringSpecContent
    ],
    EngineeringSpec
  >,
  'spec:setContext': {} as Contract<
    [
      projectId: string,
      threadId: string,
      specId: string,
      version: number,
      context: SpecContextReference[]
    ],
    EngineeringSpec
  >,
  'spec:setReview': {} as Contract<
    [projectId: string, threadId: string, specId: string, version: number],
    EngineeringSpec
  >,
  'spec:validate': {} as Contract<[spec: EngineeringSpec], SpecValidationResult>,
  'audit:getActive': {} as Contract<[projectId: string, threadId: string], AuditReport | null>,
  'audit:listVersions': {} as Contract<
    [projectId: string, threadId: string, reportId: string],
    AuditReport[]
  >,
  'audit:save': {} as Contract<[report: AuditReport, content: AuditReportContent], AuditReport>,
  'audit:addAnnotation': {} as Contract<
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
  >,
  'audit:updateAnnotation': {} as Contract<
    [
      projectId: string,
      threadId: string,
      reportId: string,
      version: number,
      annotationId: string,
      body: string
    ],
    AuditReport
  >,
  'audit:resolveAnnotation': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number, annotationId: string],
    AuditReport
  >,
  'audit:complete': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:dismiss': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:beginRework': {} as Contract<[projectId: string, threadId: string], Thread>,
  'audit:returnToOffer': {} as Contract<[projectId: string, threadId: string], AssignmentPlan>,
  'audit:openInEditor': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >,
  'audit:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, reportId: string, version: number],
    string
  >,
  'brainstorm:openInEditor': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >,
  'brainstorm:revealInFiles': {} as Contract<
    [projectId: string, threadId: string, brainstormId: string, version: number],
    string
  >,
  'thread:create': {} as Contract<[input: CreateThreadInput], Thread>,
  'thread:delete': {} as Contract<[projectId: string, threadId: string], void>,
  'thread:dismissSpecReview': {} as Contract<
    [projectId: string, threadId: string, specId: string, specVersion: number],
    Thread
  >,
  'thread:fork': {} as Contract<
    [
      projectId: string,
      threadId: string,
      title: string,
      checkpointId?: string,
      messageId?: string,
      targetProjectId?: string
    ],
    Thread
  >,
  'thread:get': {} as Contract<[projectId: string, threadId: string], Thread | null>,
  'thread:list': {} as Contract<[projectId: string], Thread[]>,
  'thread:listAll': {} as Contract<[], Thread[]>,
  /**
   * Bounded task listing for startup hydration. Never crosses the full task
   * history over IPC.
   * `projectId` (when given) is ordered first so the selected project's recent
   * active threads render before anything else.
   */
  'thread:listRecent': {} as Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >,
  /** Paged history for an explicit older-task request. */
  'thread:listHistoryPage': {} as Contract<
    [options: { projectId?: string; limit?: number; offset?: number }],
    Thread[]
  >,
  /**
   * Bounded per-project recent threads for first-paint hydration: at most
   * `RECENT_THREADS_PER_PROJECT` per project, with the inbox (Chats) project
   * capped at its configured thread_limit instead.
   */
  'thread:listRecentPerProject': {} as Contract<[], Thread[]>,
  /**
   * Paged threads for one project; the project filter is applied in SQL
   * before the limit so "load more" reaches older rows reliably.
   */
  'thread:listProjectPage': {} as Contract<
    [options: { projectId: string; limit?: number; offset?: number }],
    Thread[]
  >,
  'thread:reorder': {} as Contract<[projectId: string, orderedIds: string[]], Thread[]>,
  'thread:setSortOrder': {} as Contract<
    [projectId: string, threadId: string, sortOrder: number],
    Thread
  >,
  'thread:reorderPinned': {} as Contract<[projectId: string, orderedPinnedIds: string[]], Thread[]>,
  'thread:reorderPinnedGlobal': {} as Contract<[orderedPinnedIds: string[]], Thread[]>,
  'thread:reorderScope': {} as Contract<
    [projectId: string, bucketId: string, slice: ScopeSlice, orderedIds: string[]],
    Thread[]
  >,
  'thread:loadMessages': {} as Contract<
    [projectId: string, threadId: string, before?: ThreadMessageCursor, limit?: number],
    ThreadMessagePage
  >,
  'thread:exportTranscript': {} as Contract<
    [projectId: string, threadId: string, options: import('./types').TranscriptExportOptions],
    import('./types').TranscriptExportResult | null
  >,
  'thread:loadMessagesAround': {} as Contract<
    [projectId: string, threadId: string, anchorId: string, limit: number],
    ThreadMessagePage
  >,
  'thread:loadUserMessages': {} as Contract<
    [projectId: string, threadId: string],
    UserMessageSummary[]
  >,
  'thread:loadStreamParts': {} as Contract<
    [projectId: string, threadId: string],
    import('./types').AgentPart[]
  >,
  'thread:markRead': {} as Contract<[projectId: string, threadId: string], Thread>,
  /** Renderer → main composer draft transitions feeding the turn-grading timers. */
  'thread:draftActivity': {} as Contract<
    [projectId: string, threadId: string, drafting: boolean],
    void
  >,
  'thread:setPinned': {} as Contract<
    [projectId: string, threadId: string, pinned: boolean],
    Thread
  >,
  'thread:setContextUsage': {} as Contract<
    [projectId: string, threadId: string, usage: ThreadContextUsage],
    void
  >,
  'thread:harnessUsage': {} as Contract<[projectId: string, threadId: string], HarnessUsage[]>,
  'thread:efficiencyKpis': {} as Contract<
    [projectId: string, threadId: string],
    UsageEfficiencyKpis
  >,
  'thread:setStatus': {} as Contract<
    [projectId: string, threadId: string, status: ThreadStatus],
    Thread
  >,
  'note:get': {} as Contract<[projectId: string, threadId: string], ThreadNote | null>,
  'note:save': {} as Contract<[projectId: string, threadId: string, body: string], ThreadNote>,
  'note:delete': {} as Contract<[projectId: string, threadId: string], void>,
  /** Thread ids that currently have a note (renderer presence sync). */
  'note:list': {} as Contract<[], string[]>,
  'thread:update': {} as Contract<
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
  >,
  'thread:updateSettings': {} as Contract<
    [projectId: string, threadId: string, settings: ThreadSettings],
    Thread
  >,
  /** Enable/disable the independent (spec-less) audit; never inherited by forks. */
  'thread:setIndependentAudit': {} as Contract<
    [projectId: string, threadId: string, enabled: boolean],
    Thread
  >,
  'updater:check': {} as Contract<[explicit?: boolean], UpdaterStatus>,
  'updater:getStatus': {} as Contract<[], UpdaterStatus>,
  'updater:download': {} as Contract<[], void>,
  'updater:install': {} as Contract<[], void>,
  'remote:getStatus': {} as Contract<[], RemoteModeStatus>,
  'remote:ensureGateway': {} as Contract<[], RemoteModeStatus>,
  'remote:toggle': {} as Contract<[enabled: boolean], RemoteModeStatus>,
  'remote:listDevices': {} as Contract<[], RemoteDeviceInfo[]>,
  'remote:disconnectDevice': {} as Contract<[deviceId: string], void>,
  'remote:renameDevice': {} as Contract<[deviceId: string, name: string], RemoteModeStatus>,
  'remote:revokeDevice': {} as Contract<[deviceId: string, reason: string], RemoteModeStatus>,
  'remote:approveStepUp': {} as Contract<[approvalId: string], boolean>,
  'remote:rejectStepUp': {} as Contract<[approvalId: string], boolean>,
  'remote:listPendingApprovals': {} as Contract<[], RemotePendingStepUpApproval[]>,
  'remote:listAuditEvents': {} as Contract<[limit: number], RemoteAuditEventInfo[]>,
  'remote:beginCloudEnrollment': {} as Contract<[], RemoteModeStatus>,
  'remote:resetCloudEnrollment': {} as Contract<[], RemoteModeStatus>,
  'app:confirmClose': {} as Contract<[], void>,
  /** Resolves after post-paint feature IPC and harness services are registered. */
  'app:waitForFeatures': {} as Contract<[], void>,
  /**
   * Signalled by the renderer after its initial hydration completes so the main
   * process can timestamp the `renderer:hydrated` / `workspace:ready` startup
   * phases. Carries no payload.
   */
  'app:rendererReady': {} as Contract<[], void>,
  /**
   * Renderer forwards its own captured errors (uncaught exceptions, unhandled
   * rejections, console errors) to the main-process durable Logger. Fire and
   * forget; returns `void`.
   */
  'renderer:log': {} as Contract<[entry: RendererLogEntry], void>
}

/** Type-level view of the runtime invoke contract. */
export type IpcInvokeContract = typeof IPC_INVOKE_CONTRACT

export interface ThreadClickedPayload {
  projectId: string
  threadId: string
  /** Present when the click came from a temporary (side) chat notification, so
   *  the renderer can focus the side-chat panel after opening the parent
   *  thread. Omitted for regular thread notifications. */
  temporaryChatId?: string
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
/** Which bundled alert the renderer should play for a notification. */
export type NotificationSoundKind = 'default' | 'attention'

/** Where a notification originated: a project thread, the global chat (inbox)
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

export const IPC_EVENT_CONTRACT = {
  /** Post-paint feature IPC, chat, and harness registration completed. */
  'app:featuresReady': [] as [],
  /** Emitted after browser sign-in changes the shared desktop account. */
  'account:profileChanged': [] as unknown as [state: import('./types').AccountProfileState],
  'agent:processesChanged': [] as unknown as [projectId: string, threadId: string],
  /** Live agent lifecycle/stream event broadcast to every window. */
  'agent:event': [] as unknown as [event: import('./types').AgentEvent],
  'taskManager:processesChanged': [] as [],
  'agent:temporaryChatExpired': [] as unknown as [temporaryChatId: string],
  'thread:deleted': [] as unknown as [projectId: string, threadId: string],
  /** Live thread snapshot push so sidebar indicators react without polling. */
  'thread:updated': [] as unknown as [thread: Thread],
  /** Branch association changed for a thread. */
  'thread:branchUpdated': [] as unknown as [projectId: string, threadId: string, branch: string],
  /** Note presence changed for a thread (saved or deleted). */
  'note:changed': [] as unknown as [projectId: string, threadId: string, hasNote: boolean],
  'notification:playSound': [] as unknown as [kind: NotificationSoundKind],
  'notification:show': [] as unknown as [payload: AgentNotificationPayload],
  /** Transient in-app toast (error/info, optional navigation action). */
  'app:toast': [] as unknown as [
    payload: {
      message: string
      type: 'error' | 'info'
      projectId?: string
      threadId?: string
      action?: { label: string; projectId: string; threadId: string }
    }
  ],
  'notification:threadClicked': [] as unknown as [payload: ThreadClickedPayload],
  /** macOS notification authorization changed (delivery outcome or re-verification). */
  'notification:permissionStatus': [] as unknown as [status: SystemNotificationPermissionStatus],
  /** Emitted before the main process begins its shutdown disposal chain.
   *  The renderer should unsubscribe from IPC events and release resources. */
  'window:beforeQuit': [] as [],
  /** Emitted when the app is asked to close while threads are still working or
   *  files have unsaved edits. The renderer populates `files` from its editor
   *  state and either confirms the close or shows the confirmation modal. */
  'window:confirmClose': [] as unknown as [payload: CloseConfirmationPayload],
  /**
   * Emitted when the user presses Cmd/Ctrl+W. The main process intercepts the
   * key (so the macOS "Close Window" menu accelerator never fires) and asks the
   * renderer to close the active in-app surface — modal, settings page, sidebar
   * panel, or thread. The shortcut never closes the native application window.
   */
  'window:closeShortcut': [] as [],
  /**
   * Emitted when the user presses Cmd/Ctrl+T while a terminal holds focus. The
   * main process intercepts the key (so ghostty-web never feeds it to the
   * shell) and asks the renderer to open a new terminal tab in the terminal
   * panel — right sidebar or bottom dock, whichever is active.
   */
  'window:newTerminalShortcut': [] as [],
  /**
   * Emitted when the user presses the mouse's back side button. Windows and
   * Linux surface it as the `browser-backward` app command in the main process;
   * the main process forwards it here so the renderer can walk its own
   * in-app navigation history (the window has no native browser history).
   * On macOS the renderer instead sees a raw `mousedown`/`auxclick` with
   * button 3 — handled directly in App.svelte.
   */
  'window:historyBack': [] as [],
  /** Emitted when the user presses the mouse's forward side button. */
  'window:historyForward': [] as [],
  'updater:status': [] as unknown as [status: UpdaterStatus],
  'updater:waiting-for-threads': [] as unknown as [activeCount: number],
  'computerUse:pipFrame': [] as unknown as [frame: ComputerUsePipFrame],
  'computerUse:pipState': [] as unknown as [state: ComputerUsePipState],
  'browser:state': [] as unknown as [state: BrowserPageState],
  'gateway:state': [] as unknown as [status: import('./gateway-types').GatewayStatus],
  /** Live provider connection health/status snapshot. */
  'providers:status': [] as unknown as [payload: ProviderConnectionInfo[]],
  /** DevTools open state changed for a browser tab (open/closed). */
  'browser:devToolsChanged': [] as unknown as [state: BrowserDevToolsState],
  'browser:openRequested': [] as unknown as [url: string, context?: BrowserOpenRequestContext],
  'browser:permissionRequested': [] as unknown as [request: BrowserPermissionRequest],
  'browser:permissionResolved': [] as unknown as [requestId: string],
  'browser:download': [] as unknown as [download: BrowserDownload],
  /** Native Ctrl+Tab overlay asked the renderer to switch to a thread. */
  'switcher:select': [] as unknown as [threadId: string],
  /** Native Ctrl+Tab overlay moved its highlight (so the renderer can preload
   *  that thread's messages). */
  'switcher:highlight': [] as unknown as [threadId: string],
  /** Native Ctrl+Tab overlay was dismissed without a selection. */
  'switcher:closed': [] as [],
  /** Remote-mode status changes from the main process. */
  'remote:status': [] as unknown as [status: RemoteModeStatus],
  /**
   * Pending single-use local step-up approvals awaiting desktop disposition.
   * Emitted whenever a high-risk remote operation requires local approval.
   */
  'remote:stepUpPending': [] as unknown as [approvals: RemotePendingStepUpApproval[]],
  'speech:progress': [] as unknown as [progress: import('./speech/types').SpeechProgressEvent],
  /** Live progress/prompt/completion updates for an in-app Pi OAuth sign-in. */
  'providerAccounts:oauthEvent': [] as unknown as [
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

/** Type-level view of the runtime event contract. */
export type IpcEventContract = typeof IPC_EVENT_CONTRACT

export type InvokeChannel = keyof IpcInvokeContract
export type InvokeArgs<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['args']
export type InvokeResult<Channel extends InvokeChannel> = IpcInvokeContract[Channel]['result']
export type EventArgs<Channel extends keyof IpcEventContract> = IpcEventContract[Channel]
