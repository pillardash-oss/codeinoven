import { wireChatEngine } from './chat-engine/chat-engine-wiring'
import type { DonRuntime } from './chat-engine-don'
import { ChatEngineState } from './chat-engine/chat-engine-state'
import type { ThreadTransferRelease } from './thread-transfer-service/thread-transfer-workers'
import type { HandoffReleaseDetails } from '../system/instance-handoff-bus'
import { ThreadCreationCoordinator } from './thread-creation-coordinator'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { CheckpointManager } from '../storage/checkpoint-manager'
import type { SearchSummaryRequest } from '../search/thread-search-summary'
import type { ProjectFingerprint } from '../git/change-tracking-service'
import type { HarnessDriver } from '../drivers/driver.interface'
import type { Database } from '../database/database'
import type { TypesafeDecisionService } from '../typesafe/typesafe-decision-service'
import type { StorageEngine } from '../storage/storage-engine'
import type {
  SpeechRemoteCleanupInput,
  SpeechRemoteCleanupOutput,
  SpeechRemoteLearningInput,
  SpeechAudioTranscribeInput,
  SpeechAudioTranscribeOutput
} from '../speech/speech-service'
import type { SpeechExtractedLesson } from '../../lib/speech/types'
import type { PendingRetryRecord, RetrySchedulerService } from '../system/retry-scheduler-service'
import type { ConnectivitySource } from '../system/connectivity-service'
import type { HeartbeatSchedulerService } from '../system/heartbeat-scheduler-service'
import { type AgentSecretResolution } from '../utilities/agent-secret-service'
import { type OrchestrationRuntime } from './chat-engine-orchestration'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import { type EffectiveExperts } from '../../lib/experts'
import type { ExpertSettingsService } from '../design/expert-settings-service'
import { McpOAuthService } from '../utilities/mcp-oauth/mcp-oauth-service'
import type { ReapOrphansOptions, ReapOrphansResult } from '../agents/agent-process-service'
import {
  type DesignAssignmentRunRequest,
  type DesignAssignmentRunResult
} from '../design/design-assignment-executor'
import type { AssignmentWorkerScopeProvisioner } from '../../lib/engines/assignment-worker-scope'
import type {
  BrowserUtilityExecutor,
  DesignCapabilityExecutor,
  EngineeringToolContext,
  FollowUpExecutor,
  PawnToolContext,
  VideoCapabilityExecutor,
  ScopeToolExecutor,
  SecretRequestContext,
  McpSignInContext,
  UtilitySuggestionContext
} from '../utilities/utility-orchestration-service'
import type { EngineeringToolOperation } from '../../lib/engineering-tools'
import { type UtilitySuggestionResolution } from '../../lib/utility-suggestion'
import { type AgentMcpSignInResolution } from '../../lib/mcp-sign-in'
import type {
  ImageDescriptorExecutorRequest,
  ImageDescriptorResult
} from '../providers/image-descriptor-provider'
import type { ImageDescriptorBatchCapability } from '../services/image-descriptor'
import type {
  AgentAccountUsage,
  AgentAccountUsageOverrides,
  AgentArtifact,
  AgentEvent,
  AgentMessage,
  AgentModelSelection,
  AgentQuestionRequest,
  AgentProviderIssue,
  AgentSessionStatus,
  AgentToolCatalog,
  AgentContextCapabilities,
  AgentCapabilityCatalog,
  AgentCapabilitySource,
  AgentRunningProcess,
  TaskManagerSnapshot,
  AssignmentDraftStart,
  AssignmentPlan,
  AssignmentPlanContent,
  AuditGenerationRequest,
  AuditReport,
  BrainstormDocument,
  BrainstormEntryChoice,
  PrdDocument,
  PendingAgentQuestionRequest,
  EngineeringSpec,
  EngineeringSpecContent,
  HarnessRuntimeRestartResult,
  ImageDescriptorErrorRequest,
  ImageDescriptorReplyAction,
  PermissionLevel,
  PermissionReply,
  PermissionRequest,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  ProviderCatalog,
  ProviderCatalogRefreshOptions,
  AgentSecretSubmission,
  AgentSecretDraft,
  AgentUtilitySuggestionEntry,
  AgentMcpSignInTarget,
  SpecGenerationRequest,
  SpecActionIntent,
  UserMessagePresentation,
  ScopedHarnessCommand,
  ThreadStatus,
  Thread,
  ThreadSettings,
  ThreadTransferResult,
  TurnCheckpointSummary,
  TurnStreamPartsChange,
  TurnStreamPartsPage,
  TurnStreamPartsQuery,
  TurnStreamCompletedTurns,
  ThinkingLevel,
  BrainstormPrototypeFidelity,
  Assistant,
  AssistantAgents
} from '../../lib/types'
import { ModelPricingService } from '../providers/model-pricing-service'
import { isQuestionAnswerRecord } from '../../lib/question-answers'
import type {
  AutoAnswerReport,
  PendingQuestionInfo,
  SessionInfo,
  VirtualTaskOptions
} from './chat-engine/chat-engine-types'
import { buildChatEngineUnits } from './chat-engine/chat-engine-units'
import type { DirectReplyInput } from './chat-engine/chat-engine-direct-reply'

export {
  CITATION_SYSTEM_INSTRUCTION,
  MERMAID_OUTPUT_INSTRUCTION,
  DEPLOYMENT_URL_SYSTEM_INSTRUCTION,
  DEPLOYMENT_URL_SPEC_INSTRUCTION,
  SPEC_BRAINSTORM_SYSTEM_PROMPT,
  SPEC_IMPLEMENT_SYSTEM_PROMPT,
  BRAINSTORM_DOCUMENT_WRITE_TOOLS,
  brainstormDocumentWriteEnabled,
  composeTurnSystemPrompt,
  composeBrainstormSystemPrompt
} from './chat-engine/chat-engine-prompts'
export { changedPathsFromTool } from './chat-engine/chat-engine-changes'
export {
  mergeProviderCatalogs,
  mergeAgentMessages,
  stampHarnessId,
  stampAccount,
  restoreMirrorThinkingLevel,
  restoreMirrorAccount,
  restoreMirrorOven
} from './chat-engine/chat-engine-message-merge'
export {
  textForMessage,
  formatBrainstormInterviewDecisions,
  formatHistoryHandoff,
  formatHistoryPointer,
  formatHistoryRecap,
  selectHistoryTail
} from './chat-engine/chat-engine-message-text'
export { parseGeneratedSpecContent } from './chat-engine/chat-engine-generated-artifacts'
export { assertHarnessRequestCapabilities } from './chat-engine/chat-engine-constants'
export type { VirtualTaskOptions } from './chat-engine/chat-engine-types'

/**
 * ChatEngine   orchestrates harness drivers and exposes the unified `agent:*`
 * IPC surface consumed by the renderer.
 *
 * Responsibilities:
 * - Route requests to the correct HarnessDriver based on providerId
 * - Maintain the session registry (sessionId → project/thread/permission info)
 * - Apply the permission policy (auto / ask / readonly)
 * - Mirror completed conversations to thread storage for offline history
 * - Inject the engineering-mode system prompt when enabled
 *
 * The renderer subscribes to `agent:event` for streaming AgentEvents; this
 * class broadcasts driver events to all windows through a bounded stream buffer.
 */

/** An open user-activity window for one in-app terminal, rooted in that
 *  terminal's worktree so it can only ever apply to turns in the same root. */
export interface UserTerminalWindow {
  /** Baseline fingerprint of the terminal's own worktree, captured at first keystroke. */
  fingerprint: Promise<ProjectFingerprint | null>
  /** Real path of the terminal's worktree, resolved once at window open. */
  projectRoot: Promise<string | null>
  lastInput: number
  timer: NodeJS.Timeout
}

/**
 * A user message that opens or steers a logical turn.
 *
 * An app-issued continuation prompt (origin `orchestrator`, persisted hidden)
 * re-prompts the same session to finish the work it already streamed, and the
 * activity-only notices (compaction, sub-agent envelopes) ride mid-turn. None
 * of them is a new logical turn, so none may move the boundary that scopes the
 * working trace   moving it past the stream is what emptied a live trace.
 *
 * This mirrors the renderer's `isActivityOnlyUserMessage`, which keeps the same
 * messages transparent to turn grouping.
 */
/**
 * Read a pawn model override the way an agent would write it: `provider/model-id`
 * or a bare model id. Only the fields it names are replaced, so a bare model id
 * keeps the spawner's provider, account and harness.
 */
export function pawnModelOverride(
  value: unknown
): { providerId: string; modelId: string } | { modelId: string } | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const separator = trimmed.indexOf('/')
  if (separator <= 0 || separator === trimmed.length - 1) return { modelId: trimmed }
  return {
    providerId: trimmed.slice(0, separator),
    modelId: trimmed.slice(separator + 1)
  }
}

/**
 * The thinking levels a pawn may be asked for. `ultra` stays out deliberately: it
 * is a model runtime level the pickers offer, not one an agent should hand a
 * background worker by default.
 */
const PAWN_THINKING_LEVELS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

/**
 * Read a pawn thinking-level override, rejecting anything the app does not model
 * as a level rather than passing an unknown string to a harness.
 */
export function pawnThinkingOverride(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return PAWN_THINKING_LEVELS.has(trimmed) ? (trimmed as ThinkingLevel) : undefined
}

export function isTurnBoundaryPrompt(message: AgentMessage): boolean {
  if (message.origin === 'orchestrator') return false
  // The app's record of an answered question resumes the provider turn that
  // asked it, so it must not move the working trace's boundary either. Reading
  // it as a boundary closed the turn the reader was watching and started a
  // second trace under the answer.
  if (isQuestionAnswerRecord(message)) return false
  return !(
    message.parts.length > 0 &&
    message.parts.every((part) => part.type === 'compaction' || part.type === 'subagent')
  )
}

export class ChatEngine {
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  readonly units = buildChatEngineUnits(this)
  readonly state = new ChatEngineState(this)
  /**
   * How long a "can the TypeSafe capability answer?" reading is reused.
   *
   * Read only when deciding whether the deterministic memory gate may widen, so a
   * stale value costs at most one widened turn. Shorter than the capability's own
   * key-resolution cache, so a key stored in Settings qualifies without a restart.
   */
  static readonly TYPESAFE_ANSWERABLE_TTL_MS = 30_000

  /** Frame-aligned (16ms) stream coalescing: token deltas still batch per
   *  frame to bound IPC traffic, but no longer stack into perceptible ~50ms
   *  pauses between visible output. */
  static readonly STREAM_BROADCAST_INTERVAL_MS = 16

  static readonly TEMPORARY_CHAT_INACTIVITY_MS = 3 * 60 * 60 * 1000

  static readonly AUDIT_RUN_TIMEOUT_MS = 30 * 60 * 1000
  static readonly CATALOG_DRIVER_BUDGET_MS = 800

  /** Root for every disposable working directory a local harness turn needs.
   *  Such a turn never reads the project's files, and a remote (Oven) project's
   *  path exists only on the Oven, so it can never use that path as its cwd. */
  static readonly EPH_CWD_DIR = 'eph-cwd'

  /** Parsed stream-log entries held per thread before the oldest is evicted. */
  static readonly TURN_STREAM_CACHE_LIMIT = 16

  /**
   * Size a thread's durable stream log may reach before it is compacted to the
   * current turn.
   *
   * Well above any single turn's events, far below the hundreds of megabytes a
   * long-lived thread accumulated while the file was never trimmed.
   */
  static readonly TURN_STREAM_COMPACT_BYTES = 32 * 1024 * 1024

  public drivers = new Map<string, HarnessDriver>()

  public sessionRegistry = new Map<string, SessionInfo>()

  public pendingQuestions = new Map<string, PendingQuestionInfo>()
  /** Settles a delegated teammate's question in the conversation that began the work. */
  private delegatedQuestionHandler: ((pending: PendingQuestionInfo) => void) | null = null

  /**
   * Max consecutive forced continuations before an Assignment stall surfaces.
   *
   * One repeat is a nudge for a coordinator that ended its turn early. A second
   * no-op repeat always answered the same way (the thread log for one Assignment
   * shows three identical turns in a row before the notice), so the app surfaces
   * the stall to the user instead of spending another turn on it.
   */
  static readonly MAX_ASSIGNMENT_CONTINUATION_STALLS = 1

  public handledIdleSessions = new Set<string>()

  public threadManager!: ThreadManager

  public checkpointManager!: CheckpointManager

  /** Latest provider lifecycle state, retained across renderer remounts. */
  public sessionStatuses = new Map<string, AgentSessionStatus>()

  /** How long to wait without SSE activity before checking provider history. */
  static readonly SESSION_ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000

  // 5 minutes

  /** How long a session that is demonstrably still working (an in-flight shell
   *  tool or a running sub-agent) may stay silent before the watchdog re-checks
   *  instead of aborting it. Long CLI actions legitimately emit no events for
   *  far longer than the activity window, so silence alone must not kill them. */
  static readonly SILENT_WORK_GRACE_MS = 30 * 60 * 1000

  // 30 minutes

  /** Total harness silence after which "it is still working" stops being a
   *  reason to wait. A driver that reports itself busy keeps the turn alive for
   *  as long as it keeps reporting *something*, but a half-open provider stream
   *  leaves it busy with no output at all, and without this ceiling the watchdog
   *  re-arms its grace window forever and parks the thread invisibly for hours.
   *  Past the ceiling the silence is surfaced as a retryable failure instead. */
  static readonly SILENT_STALL_CEILING_MS = 60 * 60 * 1000

  // 60 minutes

  /**
   * How long the answer path waits for a session to finish its idle
   * finalization before resuming it with the user's decision.
   *
   * When a driver can no longer accept the reply (its pending-UI map was
   * cleared by a process restart, eviction, or teardown) the engine falls back
   * to resuming the session itself, and this wait joins the process exit's
   * history mirror. That wait must be bounded: a session parked on the very
   * question the app no longer holds emits no idle of its own, so an unbounded
   * join parks forever and leaves the answer card stuck on "Sending…".
   */
  static readonly INACTIVE_QUESTION_RESUME_WAIT_MS = 10 * 1000

  // 10 seconds

  // 3 minutes

  /**
   * How long after a user interaction the user is still considered "active".
   * While the user is active, pending questions will not auto-answer.
   */
  static readonly USER_ACTIVITY_GRACE_PERIOD_MS = 60_000

  // 1 minute

  /**
   * When the user is active, how often to re-check whether they have become
   * inactive so pending questions can start their countdown.
   */
  static readonly INACTIVITY_CHECK_INTERVAL_MS = 15_000

  // 15 seconds

  /**
   * How long a project must be fully idle (no working turns, no pending input,
   * no in-flight work) before its harness resources are released to free
   * memory and any agent-spawned processes. Strictly longer than the session
   * watchdog so a stalled turn is always resolved as an error first.
   */
  static readonly IDLE_PROJECT_GRACE_MS = 10 * 60 * 1000

  // 10 minutes

  /** How often the idle-resource reaper inspects projects. */
  static readonly IDLE_REAP_INTERVAL_MS = 60_000

  // 1 minute

  /**
   * How often a running instance reclaims harness processes orphaned by an
   * instance that died while this one kept running. The startup reap only runs
   * once, so without this sweep such an orphan stays resident (holding its port
   * and memory) until the next launch.
   */
  static readonly ORPHAN_SWEEP_INTERVAL_MS = 5 * 60_000

  /** The workstation tools' implementation and the dispatches awaiting a report. */
  public orchestration: OrchestrationRuntime | null = null

  /**
   * Don's capability implementation and the handoffs awaiting an answer.
   *
   * Attached by the bootstrap, because it owns both the assistant directory and the
   * config the user's name lives in, while the chat engine owns thread creation,
   * prompt sending and the turn that settles a delegated run.
   */
  public don: DonRuntime | null = null

  /**
   * Read the HEAD commit of one checkout, for a run's starting point.
   *
   * A narrow port rather than a Git dependency: the engine records where a run
   * begins (so its receipt has a range) but never reads history itself, and the
   * service that owns Git is wired in where Git already lives. Absent leaves a
   * run with no base, which its receipt reports as `no-base` instead of guessing.
   */
  gitHeadCommit?: (projectPath: string) => Promise<string | null>

  constructor(
    public storage: StorageEngine,
    public database: Database,
    public computerUsePip?: import('../utilities/computer-use-pip-service').ComputerUsePipService,
    public harnessManifest?: import('../agents/harness-manifest-service').HarnessManifestService,
    public threadCreation?: ThreadCreationCoordinator,
    processJournalPath?: string,
    public scopeRoots?: import('../../lib/engines/thread-manager').ThreadScopeRootProvider,
    public modelPricing?: ModelPricingService
  ) {
    wireChatEngine(
      this,
      storage,
      database,
      computerUsePip,
      harnessManifest,
      threadCreation,
      processJournalPath
    )
  }
  async driverForAccount(harnessId: string, accountId?: string): Promise<HarnessDriver> {
    return this.units['providers-accounts'].driverForAccount(harnessId, accountId)
  }
  async removeHarnessAccount(accountId: string): Promise<boolean> {
    return this.units['providers-accounts'].removeHarnessAccount(accountId)
  }
  async requestBrowserActionApproval(
    request: import('../browser/browser-service').BrowserAgentActionApproval
  ): Promise<import('../browser/browser-service').BrowserAgentActionDecision> {
    return this.units['misc'].requestBrowserActionApproval(request)
  }
  setBrowserUtilityExecutor(executor: BrowserUtilityExecutor | null): void {
    return this.units['utilities'].setBrowserUtilityExecutor(executor)
  }
  /**
   * Register the app-owned follow-up capability. The app supplies it after paint
   * because it owns the persisted wake and the clock that fires it, while the
   * engine only knows how to start a turn on the thread that gets woken.
   */
  setFollowUpExecutor(executor: FollowUpExecutor | null): void {
    return this.units['utilities'].setFollowUpExecutor(executor)
  }
  setExpertSettings(settings: ExpertSettingsService | null): void {
    return this.units['utilities-mcp'].setExpertSettings(settings)
  }
  async expertsForThread(threadId: string): Promise<EffectiveExperts> {
    return this.units['utilities-mcp'].expertsForThread(threadId)
  }
  setDesignPreviewExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['media-visual'].setDesignPreviewExecutor(executor)
  }
  setDesignMediaExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['media-visual'].setDesignMediaExecutor(executor)
  }
  setMediaGenerationExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['media-visual'].setMediaGenerationExecutor(executor)
  }
  setVideoPreviewExecutor(executor: VideoCapabilityExecutor | null): void {
    return this.units['media-visual'].setVideoPreviewExecutor(executor)
  }
  setVideoCaptureExecutor(executor: VideoCapabilityExecutor | null): void {
    return this.units['media-visual'].setVideoCaptureExecutor(executor)
  }
  async applyUtilityRegistryChange(utilityId: string): Promise<void> {
    return this.units['utilities'].applyUtilityRegistryChange(utilityId)
  }

  /**
   * The one MCP OAuth service, so the Utilities page authorizes exactly the
   * grant a turn's gateway uses.
   */
  get mcpOAuth(): McpOAuthService {
    return this.state.mcpOAuthService
  }
  setScopeToolService(executor: ScopeToolExecutor | null): void {
    return this.units['utilities-tools'].setScopeToolService(executor)
  }
  setAssignmentWorkerScopeProvisioner(provisioner: AssignmentWorkerScopeProvisioner | null): void {
    return this.units['assignment-workers'].setAssignmentWorkerScopeProvisioner(provisioner)
  }
  setPrototypePreviewRegistrar(
    registrar: ((previewSlug: string, canonicalRoot: string) => Promise<void>) | null
  ): void {
    return this.units['turns'].setPrototypePreviewRegistrar(registrar)
  }
  attachThreadTransferPreflight(
    preflight: (projectId: string, threadId: string) => Promise<ThreadTransferResult>
  ): () => void {
    return this.units['threads-title'].attachThreadTransferPreflight(preflight)
  }
  register(): void {
    return this.units['lifecycle-boot'].register()
  }
  async answerQuestion(
    projectId: string,
    threadId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    return this.units['questions-ask'].answerQuestion(projectId, threadId, requestId, answers)
  }
  async answerSecret(
    projectId: string,
    threadId: string,
    requestId: string,
    secrets: AgentSecretSubmission[]
  ): Promise<void> {
    return this.units['secrets'].answerSecret(projectId, threadId, requestId, secrets)
  }
  async requestUtilitySecrets(
    input: Record<string, unknown>,
    context: SecretRequestContext
  ): Promise<AgentSecretResolution> {
    return this.units['secrets'].requestUtilitySecrets(input, context)
  }
  async requestUtilitySuggestion(
    entry: AgentUtilitySuggestionEntry,
    context: UtilitySuggestionContext
  ): Promise<UtilitySuggestionResolution> {
    return this.units['utilities'].requestUtilitySuggestion(entry, context)
  }
  async requestMcpSignIn(
    target: AgentMcpSignInTarget,
    context: McpSignInContext
  ): Promise<AgentMcpSignInResolution> {
    return this.units['mcp-sign-in'].requestMcpSignIn(target, context)
  }
  async dismissQuestion(projectId: string, threadId: string, requestId: string): Promise<void> {
    return this.units['questions-ask'].dismissQuestion(projectId, threadId, requestId)
  }
  async listQuestions(projectId: string, threadId: string): Promise<PendingAgentQuestionRequest[]> {
    return this.units['questions-ask'].listQuestions(projectId, threadId)
  }
  async updateQuestion(
    projectId: string,
    threadId: string,
    requestId: string,
    questionIndex: number,
    answers: string[],
    nextQuestionIndex?: number
  ): Promise<PendingAgentQuestionRequest | null> {
    return this.units['questions-ask'].updateQuestion(
      projectId,
      threadId,
      requestId,
      questionIndex,
      answers,
      nextQuestionIndex
    )
  }
  async updateSecretDraft(
    projectId: string,
    threadId: string,
    requestId: string,
    questionIndex: number,
    draft: AgentSecretDraft,
    nextQuestionIndex?: number
  ): Promise<PendingAgentQuestionRequest | null> {
    return this.units['questions-ask'].updateSecretDraft(
      projectId,
      threadId,
      requestId,
      questionIndex,
      draft,
      nextQuestionIndex
    )
  }
  async terminateActiveConnections(): Promise<void> {
    return this.units['lifecycle-shutdown'].terminateActiveConnections()
  }
  async terminateActiveWork(): Promise<void> {
    return this.units['lifecycle-shutdown'].terminateActiveWork()
  }
  reapOrphanProcesses(options?: ReapOrphansOptions): Promise<ReapOrphansResult> {
    return this.units['processes'].reapOrphanProcesses(options)
  }
  async dispose(): Promise<void> {
    return this.units['lifecycle-shutdown'].dispose()
  }
  async rememberAuthoredWorkKind(
    projectId: string,
    threadId: string,
    kind: AuthoredWorkKind
  ): Promise<void> {
    return this.units['providers-accounts'].rememberAuthoredWorkKind(projectId, threadId, kind)
  }
  async listProviders(projectId: string, force = false): Promise<ProviderCatalog[]> {
    return this.units['providers-catalog'].listProviders(projectId, force)
  }
  async invalidateProviderCatalogs(): Promise<void> {
    return this.units['providers-catalog'].invalidateProviderCatalogs()
  }
  refreshOpenCodeHarness(): void {
    return this.units['providers-catalog'].refreshOpenCodeHarness()
  }
  async refreshAcpHarnesses(): Promise<void> {
    return this.units['providers-catalog'].refreshAcpHarnesses()
  }
  async restartHarnessRuntime(
    harnessId: string,
    options: { force?: boolean } = {}
  ): Promise<HarnessRuntimeRestartResult> {
    return this.units['providers-harness'].restartHarnessRuntime(harnessId, options)
  }
  async refreshAccountUsage(overrides?: AgentAccountUsageOverrides): Promise<AgentAccountUsage[]> {
    return this.units['providers-catalog'].refreshAccountUsage(overrides)
  }
  async activateBankedReset(
    projectId: string,
    threadId: string
  ): Promise<AgentAccountUsage | null> {
    return this.units['turns'].activateBankedReset(projectId, threadId)
  }
  async getHarnessAuthStatus(
    projectId: string,
    harnessId: string,
    accountId?: string
  ): Promise<boolean | null> {
    return this.units['providers-accounts'].getHarnessAuthStatus(projectId, harnessId, accountId)
  }
  async refreshProviderCatalog(
    projectId: string,
    options: ProviderCatalogRefreshOptions = {}
  ): Promise<ProviderCatalog[]> {
    return this.units['providers-catalog'].refreshProviderCatalog(projectId, options)
  }
  async listProviderSnapshot(projectId: string): Promise<ProviderCatalog[]> {
    return this.units['providers-catalog'].listProviderSnapshot(projectId)
  }
  async listTools(
    projectId?: string,
    harnessId?: string,
    providerId?: string,
    modelId?: string,
    force = false
  ): Promise<AgentToolCatalog> {
    return this.units['utilities-tools'].listTools(projectId, harnessId, providerId, modelId, force)
  }
  async listContextCapabilities(
    projectId: string,
    threadId: string,
    harnessId?: string
  ): Promise<AgentContextCapabilities> {
    return this.units['utilities-tools'].listContextCapabilities(projectId, threadId, harnessId)
  }
  async listAllCapabilities(): Promise<AgentCapabilityCatalog> {
    return this.units['utilities-tools'].listAllCapabilities()
  }
  async warmThreadSession(projectId: string, threadId: string): Promise<boolean> {
    return this.units['thread-lifecycle'].warmThreadSession(projectId, threadId)
  }
  async ensureSession(
    projectId: string,
    threadId: string,
    requestedDriverId?: string
  ): Promise<string> {
    return this.units['turns-sessions'].ensureSession(projectId, threadId, requestedDriverId)
  }
  async loadMessages(projectId: string, threadId: string): Promise<AgentMessage[]> {
    return this.units['messages-load'].loadMessages(projectId, threadId)
  }
  async cleanupSpeechTranscript(
    input: SpeechRemoteCleanupInput
  ): Promise<SpeechRemoteCleanupOutput> {
    return this.units['speech'].cleanupSpeechTranscript(input)
  }
  async learnSpeechLessons(
    input: SpeechRemoteLearningInput
  ): Promise<SpeechExtractedLesson[] | null> {
    return this.units['speech'].learnSpeechLessons(input)
  }
  async summarizeSearchThread(input: SearchSummaryRequest): Promise<string> {
    return this.units['transcripts'].summarizeSearchThread(input)
  }
  async transcribeSpeechAudio(
    input: SpeechAudioTranscribeInput
  ): Promise<SpeechAudioTranscribeOutput> {
    return this.units['speech'].transcribeSpeechAudio(input)
  }
  async listArtifacts(projectId: string, threadId: string): Promise<AgentArtifact[]> {
    return this.units['media-artifacts'].listArtifacts(projectId, threadId)
  }
  listProcesses(projectId: string, threadId: string): Promise<AgentRunningProcess[]> {
    return this.units['processes'].listProcesses(projectId, threadId)
  }
  async hasActiveProcessesInScope(projectId: string, scopeBucketId?: string): Promise<boolean> {
    return this.units['processes'].hasActiveProcessesInScope(projectId, scopeBucketId)
  }
  killProcess(projectId: string, threadId: string, pid: number): Promise<void> {
    return this.units['processes'].killProcess(projectId, threadId, pid)
  }
  killThreadProcesses(projectId: string, threadId: string): Promise<void> {
    return this.units['processes'].killThreadProcesses(projectId, threadId)
  }
  async listTaskManagerProcesses(): Promise<TaskManagerSnapshot> {
    return this.units['processes'].listTaskManagerProcesses()
  }
  killTaskManagerProcess(pid: number, force: boolean): Promise<void> {
    return this.units['processes'].killTaskManagerProcess(pid, force)
  }
  setPtyStopAnnouncer(announcer: ((pid: number) => boolean) | null): void {
    return this.units['processes'].setPtyStopAnnouncer(announcer)
  }
  stopTaskManagerService(id: string): Promise<void> {
    return this.units['processes'].stopTaskManagerService(id)
  }
  trackPtyProcess(
    scopeId: string | undefined,
    projectId: string | undefined,
    threadId: string | undefined,
    pid: number,
    command: string,
    cwd: string
  ): void {
    return this.units['processes'].trackPtyProcess(scopeId, projectId, threadId, pid, command, cwd)
  }
  recordUserFileSave(projectId: string, relativePath: string): void {
    return this.units['messages-write'].recordUserFileSave(projectId, relativePath)
  }
  recordUserTerminalInput(projectId: string, projectPath: string): void {
    return this.units['processes'].recordUserTerminalInput(projectId, projectPath)
  }
  deleteSkill(source: AgentCapabilitySource): Promise<boolean> {
    return this.units['utilities-mcp'].deleteSkill(source)
  }
  deleteMcp(source: AgentCapabilitySource): Promise<boolean> {
    return this.units['utilities-mcp'].deleteMcp(source)
  }
  async loadSessionMessages(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentMessage[]> {
    return this.units['messages-load'].loadSessionMessages(projectId, threadId, sessionId)
  }
  async getChildSessionStatus(
    projectId: string,
    threadId: string,
    sessionId: string
  ): Promise<AgentSessionStatus | null> {
    return this.units['assignment-workers'].getChildSessionStatus(projectId, threadId, sessionId)
  }
  async retryChildSession(projectId: string, threadId: string, sessionId: string): Promise<void> {
    return this.units['assignment-workers'].retryChildSession(projectId, threadId, sessionId)
  }
  async retryAssignmentWorker(
    projectId: string,
    coordinatorThreadId: string,
    workerThreadId: string
  ): Promise<AssignmentPlan> {
    return this.units['assignment-workers'].retryAssignmentWorker(
      projectId,
      coordinatorThreadId,
      workerThreadId
    )
  }
  async reportWorkerToCoordinator(
    projectId: string,
    coordinatorThreadId: string,
    workerThreadId: string
  ): Promise<AssignmentPlan> {
    return this.units['assignment-workers'].reportWorkerToCoordinator(
      projectId,
      coordinatorThreadId,
      workerThreadId
    )
  }
  async resumeAssignmentAttention(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<AssignmentPlan> {
    return this.units['assignment'].resumeAssignmentAttention(projectId, coordinatorThreadId)
  }
  async abortChildSession(projectId: string, threadId: string, sessionId: string): Promise<void> {
    return this.units['assignment-workers'].abortChildSession(projectId, threadId, sessionId)
  }
  async getSessionStatus(projectId: string, threadId: string): Promise<AgentSessionStatus | null> {
    return this.units['turns-sessions'].getSessionStatus(projectId, threadId)
  }
  async dismissSessionError(projectId: string, threadId: string, sessionId: string): Promise<void> {
    return this.units['turns-sessions'].dismissSessionError(projectId, threadId, sessionId)
  }
  activeSessionCount(): number {
    return this.units['turns-sessions'].activeSessionCount()
  }
  workingSessionCount(): number {
    return this.units['turns-sessions'].workingSessionCount()
  }
  async reconcileUnverifiedWork(): Promise<number> {
    return this.units['turns-sessions'].reconcileUnverifiedWork()
  }
  async assistantAuthoringInstruction(
    projectId: string,
    threadId: string,
    thread: Thread | null | undefined
  ): Promise<string | undefined> {
    return this.units['assistant-authoring'].assistantAuthoringInstruction(
      projectId,
      threadId,
      thread
    )
  }
  async readAssistantCheckpoint(assistantId: string): Promise<string | null> {
    return this.units['assistant-authoring'].readAssistantCheckpoint(assistantId)
  }
  assistantRunHiddenContext(thread: Thread | null | undefined): string | undefined {
    return this.units['assistant-authoring'].assistantRunHiddenContext(thread)
  }
  assistantPersonaLayers(thread: Thread | null | undefined): string | undefined {
    return this.units['assistant-authoring'].assistantPersonaLayers(thread)
  }
  async truncateMessages(
    projectId: string,
    threadId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    return this.units['messages-write'].truncateMessages(projectId, threadId, messageId)
  }
  async deleteMessages(
    projectId: string,
    threadId: string,
    messageId: string,
    mode: 'down' | 'single' | 'up'
  ): Promise<AgentMessage[]> {
    return this.units['threads-delete'].deleteMessages(projectId, threadId, messageId, mode)
  }
  async deleteTemporaryMessages(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    messageId: string,
    mode: 'down' | 'single' | 'up'
  ): Promise<AgentMessage[]> {
    return this.units['temporary-chats'].deleteTemporaryMessages(
      projectId,
      threadId,
      temporaryChatId,
      messageId,
      mode
    )
  }
  async discardSteer(projectId: string, threadId: string, userMessageId: string): Promise<void> {
    return this.units['turns-steer'].discardSteer(projectId, threadId, userMessageId)
  }
  async steerPrompt(
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
  ): Promise<AgentMessage> {
    return this.units['turns-steer'].steerPrompt(
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
  }
  async restoreCoordinatorHandoffQueues(): Promise<void> {
    return this.units['assignment'].restoreCoordinatorHandoffQueues()
  }
  /**
   * Answer one conversation from inside the conversation that collected it.
   *
   * The words are delivered to the thread that spoke them and recorded in the
   * conversation the user typed them in, so a group chat reads as one inbox.
   */
  async sendDirectReply(input: DirectReplyInput): Promise<AgentMessage> {
    return this.units['direct-reply'].send(input)
  }
  async sendPrompt(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    specAction?: SpecActionIntent,
    userMessageId?: string,
    promptContext?: string,
    promptReferences?: PromptReference[],
    projectReferences?: PromptProjectReference[],
    origin: 'user' | 'internal' = 'user',
    presentation?: UserMessagePresentation,
    taskReferences?: PromptAssignmentTaskReference[],
    /** Persist this internal prompt as a visible user turn. Used by the
     *  Assignment worker dispatch so the task that started a worker reads as
     *  the first user prompt in its conversation. */
    visiblePrompt = false
  ): Promise<AgentMessage> {
    return this.units['turns-send-prompt'].sendPrompt(
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
      origin,
      presentation,
      taskReferences,
      visiblePrompt
    )
  }
  async sendTemporaryPrompt(
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
  ): Promise<AgentMessage | undefined> {
    return this.units['temporary-chats'].sendTemporaryPrompt(
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
  }
  async runVirtualTask(
    projectId: string,
    virtualTaskId: string,
    settings: ThreadSettings,
    title: string,
    text: string,
    options: VirtualTaskOptions = {}
  ): Promise<AgentMessage> {
    return this.units['misc'].runVirtualTask(
      projectId,
      virtualTaskId,
      settings,
      title,
      text,
      options
    )
  }
  async steerTemporaryPrompt(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    settings: ThreadSettings,
    text: string,
    attachments: PromptAttachment[],
    references?: PromptReference[],
    userMessageId?: string,
    displayText?: string
  ): Promise<void> {
    return this.units['temporary-chats'].steerTemporaryPrompt(
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
  }
  async abortTemporaryChat(
    projectId: string,
    threadId: string,
    temporaryChatId: string
  ): Promise<void> {
    return this.units['temporary-chats'].abortTemporaryChat(projectId, threadId, temporaryChatId)
  }
  async closeTemporaryChat(temporaryChatId: string): Promise<void> {
    return this.units['temporary-chats'].closeTemporaryChat(temporaryChatId)
  }
  async convertTemporaryChatToThread(
    projectId: string,
    threadId: string,
    temporaryChatId: string,
    settings: ThreadSettings,
    title?: string
  ): Promise<Thread> {
    return this.units['temporary-chats'].convertTemporaryChatToThread(
      projectId,
      threadId,
      temporaryChatId,
      settings,
      title
    )
  }
  async loadTemporaryChatMessages(temporaryChatId: string): Promise<AgentMessage[]> {
    return this.units['temporary-chats'].loadTemporaryChatMessages(temporaryChatId)
  }
  async loadTemporaryConversation(temporaryChatId: string): Promise<AgentMessage[]> {
    return this.units['temporary-chats'].loadTemporaryConversation(temporaryChatId)
  }
  getTemporaryChatStatus(temporaryChatId: string): {
    active: boolean
    expiresAt?: number
  } {
    return this.units['temporary-chats'].getTemporaryChatStatus(temporaryChatId)
  }
  touchTemporaryChat(temporaryChatId: string): {
    active: boolean
    expiresAt?: number
  } {
    return this.units['temporary-chats'].touchTemporaryChat(temporaryChatId)
  }
  async executeImageDescriptor(
    request: ImageDescriptorExecutorRequest
  ): Promise<ImageDescriptorResult[]> {
    return this.units['media-visual'].executeImageDescriptor(request)
  }
  async imageDescriptorBatchCapability(
    request: ImageDescriptorExecutorRequest,
    selection: AgentModelSelection
  ): Promise<ImageDescriptorBatchCapability> {
    return this.units['utilities-gateway'].imageDescriptorBatchCapability(request, selection)
  }
  async runDesignAssignment(
    request: DesignAssignmentRunRequest
  ): Promise<DesignAssignmentRunResult> {
    return this.units['assignment-run'].runDesignAssignment(request)
  }
  async abort(
    projectId: string,
    threadId: string,
    options: { reason?: 'user' | 'transfer' } = {}
  ): Promise<void> {
    return this.units['turns-dispatch'].abort(projectId, threadId, options)
  }
  async releaseThreadForTransfer(
    projectId: string,
    threadId: string
  ): Promise<ThreadTransferRelease> {
    return this.units['threads-title'].releaseThreadForTransfer(projectId, threadId)
  }
  async releaseIdleCodexThreadForTransfer(
    projectId: string,
    threadId: string
  ): Promise<{ owner: boolean; released: boolean; reason?: string }> {
    return this.units['threads-title'].releaseIdleCodexThreadForTransfer(projectId, threadId)
  }
  async releaseWorkflowForTransfer(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<{ released: boolean; reason?: string }> {
    return this.units['threads-title'].releaseWorkflowForTransfer(projectId, coordinatorThreadId)
  }
  async adoptTransferredThread(
    projectId: string,
    threadId: string,
    released?: HandoffReleaseDetails
  ): Promise<ThreadTransferResult> {
    return this.units['threads-title'].adoptTransferredThread(projectId, threadId, released)
  }
  async adoptTransferredWorkflow(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<ThreadTransferResult> {
    return this.units['threads-title'].adoptTransferredWorkflow(projectId, coordinatorThreadId)
  }
  async resolveTransferTarget(
    projectId: string,
    threadId: string
  ): Promise<{ rootThreadId: string; ownerPid: number | null }> {
    return this.units['threads-title'].resolveTransferTarget(projectId, threadId)
  }
  async deleteThreadSession(projectId: string, threadId: string): Promise<void> {
    return this.units['threads-delete'].deleteThreadSession(projectId, threadId)
  }
  async replyPermission(
    projectId: string,
    requestId: string,
    reply: PermissionReply,
    alternative?: string
  ): Promise<void> {
    return this.units['permissions'].replyPermission(projectId, requestId, reply, alternative)
  }
  async listPermissions(projectId: string, threadId: string): Promise<PermissionRequest[]> {
    return this.units['permissions'].listPermissions(projectId, threadId)
  }
  async listImageDescriptorErrors(
    projectId: string,
    threadId: string
  ): Promise<ImageDescriptorErrorRequest[]> {
    return this.units['media-artifacts'].listImageDescriptorErrors(projectId, threadId)
  }
  async replyImageDescriptor(
    projectId: string,
    threadId: string,
    requestId: string,
    action: ImageDescriptorReplyAction,
    selection?: AgentModelSelection,
    imagePath?: string
  ): Promise<void> {
    return this.units['media-visual'].replyImageDescriptor(
      projectId,
      threadId,
      requestId,
      action,
      selection,
      imagePath
    )
  }
  async listCommands(
    projectId: string,
    threadId: string,
    harnessId?: string
  ): Promise<ScopedHarnessCommand[]> {
    return this.units['runtime-agents'].listCommands(projectId, threadId, harnessId)
  }
  async startAssignment(
    projectId: string,
    coordinatorThreadId: string,
    origin: 'user' | 'internal' = 'user'
  ): Promise<AssignmentPlan> {
    return this.units['assignment-run'].startAssignment(projectId, coordinatorThreadId, origin)
  }
  async stopAssignment(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    return this.units['assignment'].stopAssignment(projectId, coordinatorThreadId)
  }
  async resumeAssignment(projectId: string, coordinatorThreadId: string): Promise<AssignmentPlan> {
    return this.units['assignment'].resumeAssignment(projectId, coordinatorThreadId)
  }
  async chooseBrainstormEntry(
    projectId: string,
    threadId: string,
    choice: BrainstormEntryChoice
  ): Promise<BrainstormDocument | EngineeringSpec | null> {
    return this.units['brainstorm'].chooseBrainstormEntry(projectId, threadId, choice)
  }
  async reviewBrainstorm(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note: string,
    options: {
      sessionTurn?: boolean
      /** When set, forces prototype artifact generation for this revision. */
      prototypeRequest?: { fidelity: BrainstormPrototypeFidelity; count?: number }
    } = {}
  ): Promise<BrainstormDocument> {
    return this.units['brainstorm-review'].reviewBrainstorm(
      projectId,
      threadId,
      brainstormId,
      version,
      note,
      options
    )
  }
  async generatePrd(
    projectId: string,
    threadId: string,
    settings: ThreadSettings,
    instructions: string,
    attachments: PromptAttachment[],
    userMessageId: string
  ): Promise<PrdDocument> {
    return this.units['prd'].generatePrd(
      projectId,
      threadId,
      settings,
      instructions,
      attachments,
      userMessageId
    )
  }
  async finalizeBrainstorm(
    projectId: string,
    threadId: string,
    brainstormId: string,
    version: number,
    note = ''
  ): Promise<EngineeringSpec | BrainstormDocument> {
    return this.units['brainstorm'].finalizeBrainstorm(
      projectId,
      threadId,
      brainstormId,
      version,
      note
    )
  }
  async generateSpec(
    projectId: string,
    threadId: string,
    request: SpecGenerationRequest
  ): Promise<EngineeringSpecContent> {
    return this.units['spec-authoring'].generateSpec(projectId, threadId, request)
  }

  /**
   * How long a foreground pawn agent call waits inline for its thread to answer.
   *
   * A gateway call is carried by a harness transport that allows
   * `gatewayHarnessTimeoutMs` for it (the app's human-decision deadline plus a
   * margin, `src/lib/gateway-timeout.ts`), and a pawn runs whole tasks, so it can
   * easily outlive that. The inline wait stays under the transport's allowance on
   * purpose: a call that is still running when this budget expires answers
   * `running` and reports back by steering the spawner, instead of holding a tool
   * call open past the transport's deadline.
   */
  static readonly PAWN_FOREGROUND_WAIT_MS = 5 * 60_000

  /**
   * How long the completion waiter for a pawn's thread stays armed, foreground
   * or background. A pawn that outlives this is reported as failed rather than
   * left silent.
   */
  static readonly PAWN_RUN_TIMEOUT_MS = 60 * 60_000
  async runPawnTool(input: Record<string, unknown>, context: PawnToolContext): Promise<unknown> {
    return this.units['assignment-workers'].runPawnTool(input, context)
  }
  async runEngineeringTool(
    operation: EngineeringToolOperation,
    input: Record<string, unknown>,
    context: EngineeringToolContext
  ): Promise<unknown> {
    return this.units['utilities-tools'].runEngineeringTool(operation, input, context)
  }
  async generateAssignmentDraft(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings,
    instructions?: string
  ): Promise<AssignmentPlan> {
    return this.units['assignment'].generateAssignmentDraft(
      projectId,
      coordinatorThreadId,
      settings,
      instructions
    )
  }
  /** Start or join the thread's Assignment draft without waiting for it. */
  async requestAssignmentDraft(input: {
    projectId: string
    coordinatorThreadId: string
    settings: ThreadSettings
    instructions?: string
    sessionId: string
  }): Promise<AssignmentDraftStart> {
    return this.units['assignment'].requestAssignmentDraft(input)
  }
  /** Persist a task graph the agent authored, cancelling the app's own generation. */
  async submitAgentAssignmentDraft(input: {
    projectId: string
    coordinatorThreadId: string
    content: AssignmentPlanContent
    sessionId: string
    harnessId: string
    providerId: string
    modelId: string
  }): Promise<AssignmentPlan> {
    return this.units['assignment'].submitAgentAssignmentDraft(input)
  }
  /** A user Stop ends the draft run and leaves its card honest about it. */
  stopAssignmentDraftRun(projectId: string, coordinatorThreadId: string): void {
    this.units['assignment'].stopAssignmentDraftRun(projectId, coordinatorThreadId)
  }
  /** Retry a failed draft by continuing the session it preserved. */
  async retryAssignmentDraft(input: {
    projectId: string
    coordinatorThreadId: string
  }): Promise<AssignmentDraftStart> {
    return this.units['assignment'].retryAssignmentDraft(input)
  }
  async generateAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<AuditReport> {
    return this.units['audit'].generateAudit(projectId, threadId, request)
  }
  async ensureImplementationAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    return this.units['audit'].ensureImplementationAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
  }
  async generateIndependentAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    return this.units['audit'].generateIndependentAudit(projectId, threadId, request)
  }
  async deleteIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<void> {
    return this.units['audit'].deleteIndependentAuditorThread(projectId, coordinatorThreadId)
  }
  async startFreshIndependentAudit(
    projectId: string,
    threadId: string,
    request: AuditGenerationRequest
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    return this.units['audit'].startFreshIndependentAudit(projectId, threadId, request)
  }
  async ensureIndependentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    return this.units['audit'].ensureIndependentAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
  }
  async ensureAchievementScope(projectId: string, coordinatorThreadId: string): Promise<Thread> {
    return this.units['runtime-workflows'].ensureAchievementScope(projectId, coordinatorThreadId)
  }
  async ensureAchievementAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    return this.units['audit'].ensureAchievementAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
  }
  async ensureAssignmentAuditorThread(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<Thread> {
    return this.units['audit'].ensureAssignmentAuditorThread(
      projectId,
      coordinatorThreadId,
      settings
    )
  }
  async generateAssignmentAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    return this.units['audit'].generateAssignmentAudit(projectId, coordinatorThreadId, settings)
  }
  async generateAchievementAudit(
    projectId: string,
    coordinatorThreadId: string,
    settings: ThreadSettings
  ): Promise<{ report: AuditReport; auditorThread: Thread }> {
    return this.units['audit'].generateAchievementAudit(projectId, coordinatorThreadId, settings)
  }
  async submitAchievementAuditFeedback(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number,
    feedback: string
  ): Promise<Thread> {
    return this.units['audit'].submitAchievementAuditFeedback(
      projectId,
      coordinatorThreadId,
      reportId,
      reportVersion,
      feedback
    )
  }
  async returnAchievementAuditToOffer(
    projectId: string,
    coordinatorThreadId: string
  ): Promise<Thread> {
    return this.units['audit'].returnAchievementAuditToOffer(projectId, coordinatorThreadId)
  }
  async submitAssignmentAuditFeedback(
    projectId: string,
    coordinatorThreadId: string,
    reportId: string,
    reportVersion: number,
    feedback: string
  ): Promise<AssignmentPlan> {
    return this.units['audit'].submitAssignmentAuditFeedback(
      projectId,
      coordinatorThreadId,
      reportId,
      reportVersion,
      feedback
    )
  }
  async resumePendingWork(): Promise<void> {
    return this.units['runtime-connectivity'].resumePendingWork()
  }
  async resumeRecoveredThreads(recovered: Thread[]): Promise<void> {
    return this.units['thread-lifecycle'].resumeRecoveredThreads(recovered)
  }
  async ensureInitialSpec(projectId: string, threadId: string): Promise<EngineeringSpec> {
    return this.units['spec'].ensureInitialSpec(projectId, threadId)
  }
  async runCommand(
    projectId: string,
    threadId: string,
    commandId: string,
    args: string
  ): Promise<void> {
    return this.units['runtime-agents'].runCommand(projectId, threadId, commandId, args)
  }
  async compactSession(projectId: string, threadId: string): Promise<void> {
    return this.units['turns-sessions'].compactSession(projectId, threadId)
  }
  async resolve(
    projectId: string,
    driverId: string,
    threadId?: string,
    accountId?: string
  ): Promise<{ driver: HarnessDriver; projectPath: string }> {
    return this.units['turns'].resolve(projectId, driverId, threadId, accountId)
  }
  async resolveThreadPath(projectId: string, threadId: string): Promise<string> {
    return this.units['thread-lifecycle'].resolveThreadPath(projectId, threadId)
  }
  registerPendingQuestion(
    driverId: string,
    projectId: string,
    threadId: string,
    projectPath: string,
    request: AgentQuestionRequest,
    timeoutMs: number
  ): PendingQuestionInfo {
    return this.units['questions'].registerPendingQuestion(
      driverId,
      projectId,
      threadId,
      projectPath,
      request,
      timeoutMs
    )
  }
  noteUserActivity(): void {
    return this.units['misc'].noteUserActivity()
  }
  handleDriverEvent(driverId: string, event: AgentEvent, sourceDriver?: HarnessDriver): void {
    return this.units['turns'].handleDriverEvent(driverId, event, sourceDriver)
  }
  async persistTurnStreamEvent(
    owner: SessionInfo,
    event: Extract<AgentEvent, { type: 'message.part.updated' | 'message.part.delta' }>
  ): Promise<void> {
    return this.units['messages-write'].persistTurnStreamEvent(owner, event)
  }
  async loadTurnStreamParts(
    projectId: string,
    threadId: string,
    query: TurnStreamPartsQuery = {}
  ): Promise<TurnStreamPartsPage | TurnStreamPartsChange | TurnStreamCompletedTurns> {
    return this.units['messages-load'].loadTurnStreamParts(projectId, threadId, query)
  }
  async reannounceAssignmentAudit(plan: AssignmentPlan): Promise<void> {
    return this.units['audit'].reannounceAssignmentAudit(plan)
  }
  broadcast(event: AgentEvent): void {
    return this.units['runtime-workflows'].broadcast(event)
  }
  connectionRestored(): void {
    return this.units['runtime-connectivity'].connectionRestored()
  }
  attachConnectivity(connectivity: ConnectivitySource): () => void {
    return this.units['runtime-connectivity'].attachConnectivity(connectivity)
  }
  attachRetryScheduler(scheduler: RetrySchedulerService): void {
    return this.units['runtime-connectivity'].attachRetryScheduler(scheduler)
  }
  attachAssistantAgentsResolver(resolver: (task: Thread) => AssistantAgents | undefined): void {
    return this.units['assistant-authoring'].attachAssistantAgentsResolver(resolver)
  }
  attachAssistantRunSettledRecorder(
    recorder: ((threadId: string, status: ThreadStatus) => void) | null
  ): void {
    return this.units['assistant-authoring'].attachAssistantRunSettledRecorder(recorder)
  }
  attachAutoAnswerRecorder(recorder: ((report: AutoAnswerReport) => void) | null): void {
    return this.units['messages-write'].attachAutoAnswerRecorder(recorder)
  }
  async createAssistantRunThread(input: {
    task: Thread
    title: string
    settings?: ThreadSettings
  }): Promise<Thread> {
    return this.units['assistant-authoring'].createAssistantRunThread(input)
  }
  /**
   * Open the Getting started conversation of a teammate the orchestrator hired,
   * with the request that caused the hire already in it.
   */
  async openRecruitedAssistantConversation(input: {
    assistant: Assistant
    purpose: string
    request?: string
    settings: ThreadSettings
    /** The conversation that asked for the hire, when an assistant did. */
    initiator?: { projectId: string; threadId: string }
  }): Promise<Thread> {
    return this.units['assistant-authoring'].openRecruitedAssistantConversation(input)
  }
  /**
   * Install Don's runtime and hand its executor to the utility gateway, so a turn on
   * Don's thread can read the assistant roster and delegate work.
   */
  attachDonRuntime(runtime: DonRuntime): void {
    this.don = runtime
    this.state.utilityOrchestration.setDonExecutor(runtime.executor)
  }
  /**
   * Install the handler that settles a delegated teammate's question inside the
   * conversation that started its work.
   *
   * Registered by the bootstrap, which owns the orchestrator's runtime: the engine
   * only knows that a question it registered may belong to work an assistant
   * dispatched, and hands it over rather than deciding what to do about it.
   */
  attachDelegatedQuestionHandler(handler: ((pending: PendingQuestionInfo) => void) | null): void {
    this.delegatedQuestionHandler = handler
  }

  /** Offer a freshly registered question to that handler. Never throws. */
  notifyDelegatedQuestion(pending: PendingQuestionInfo): void {
    this.delegatedQuestionHandler?.(pending)
  }

  attachOrchestrationRuntime(): void {
    return this.units['runtime-workflows'].attachOrchestrationRuntime()
  }
  attachOrchestrationAssistantDirectory(
    directory: import('./chat-engine-orchestration').OrchestrationAssistantDirectory | null
  ): void {
    return this.units['runtime-workflows'].attachOrchestrationAssistantDirectory(directory)
  }
  attachHeartbeatScheduler(scheduler: HeartbeatSchedulerService): void {
    return this.units['runtime-connectivity'].attachHeartbeatScheduler(scheduler)
  }
  attachTypesafeDecisionService(service: TypesafeDecisionService): void {
    return this.units['questions'].attachTypesafeDecisionService(service)
  }
  async repairPendingRetryThreadStatuses(): Promise<void> {
    return this.units['thread-lifecycle'].repairPendingRetryThreadStatuses()
  }
  async handleProviderFailure(
    sessionId: string,
    issue: AgentProviderIssue,
    error?: string
  ): Promise<void> {
    return this.units['providers-accounts'].handleProviderFailure(sessionId, issue, error)
  }
  async continueScheduledThread(record: PendingRetryRecord): Promise<void> {
    return this.units['thread-lifecycle'].continueScheduledThread(record)
  }
  async refreshSensitiveFilePermissions(): Promise<void> {
    return this.units['permissions'].refreshSensitiveFilePermissions()
  }
  reassertTurnToolEvidence(session: SessionInfo, messages: readonly AgentMessage[]): void {
    return this.units['utilities-tools'].reassertTurnToolEvidence(session, messages)
  }
  async activeTurnChangeSummary(
    projectId: string,
    threadId: string
  ): Promise<TurnCheckpointSummary | null> {
    return this.units['threads-title'].activeTurnChangeSummary(projectId, threadId)
  }
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
    return this.units['lifecycle-boot'].registerSession(
      sessionId,
      projectId,
      threadId,
      projectPath,
      permissionLevel,
      driverId,
      activeTurnId,
      ephemeral
    )
  }
  async recoverWatchdogIssue(
    sessionId: string,
    info: SessionInfo
  ): Promise<AgentProviderIssue | null> {
    return this.units['runtime-connectivity'].recoverWatchdogIssue(sessionId, info)
  }
}
