import { createWorkQueue } from '../../../lib/bounded-work'
import type { HistoryHandoffSummary } from './chat-engine-message-text'
import type { CapacityContinueState } from './chat-engine-capacity-continue'
import type { Server } from 'http'
import { BrainstormAlignmentNotes } from '../brainstorm-alignment-notes'
import { AssistantAuthoringCheckpoints } from '../assistant-authoring-checkpoints'
import { RepositoryService } from '../../git/repository-service'
import { ProjectFilesService } from '../../editor/project-files-service'
import { ProjectManager } from '../../../lib/engines/project-manager'
import { SpecEngine } from '../../../lib/engines/spec-engine'
import { AuditEngine } from '../../../lib/engines/audit-engine'
import { AssignmentEngine } from '../../../lib/engines/assignment-engine'
import { PrdEngine } from '../../../lib/engines/prd-engine'
import { EngineeringLifecycleEngine } from '../../../lib/engines/engineering-lifecycle-engine'
import { OvenChat } from '../../ovens/oven-chat'
import { MemoryService } from '../memory-service'
import { PromptAssembler } from '../prompt-assembler'
import type { HarnessDriver, PreparedUtilityRuntime } from '../../drivers/driver.interface'
import { HarnessUsageRepo } from '../../database/repositories/harness-usage-repo'
import { AssistantRepo } from '../../database/repositories/assistant-repo'
import type { TypesafeDecisionService } from '../../typesafe/typesafe-decision-service'
import type { RetrySchedulerService } from '../../system/retry-scheduler-service'
import type { ConnectivitySource } from '../../system/connectivity-service'
import { WorkflowOwnershipService } from '../../system/workflow-ownership-service'
import { SecretVault } from '../../storage/secret-vault'
import { UtilityRuntimeService } from '../../utilities/utility-runtime-service'
import { UtilityRegistryService } from '../../utilities/utility-registry-service'
import { AgentSecretService } from '../../utilities/agent-secret-service'
import { CapabilityDiscoveryService } from '../../agents/capability-discovery-service'
import type { ExpertSettingsService } from '../../design/expert-settings-service'
import { McpConnectionTestService } from '../../utilities/mcp-connection-test-service'
import { McpOAuthService } from '../../utilities/mcp-oauth/mcp-oauth-service'
import { BaseUrlProviderService } from '../../providers/base-url-provider-service'
import { HarnessAccountRegistry } from '../../providers/harness-account-registry'
import { AgentProcessService } from '../../agents/agent-process-service'
import { UtilityOrchestrationService } from '../../utilities/utility-orchestration-service'
import type { UtilityTurnGateway } from '../../utilities/utility-orchestration-service'
import type {
  AgentEvent,
  AgentMessage,
  AgentSubagentActivity,
  AgentToolCatalog,
  AssignmentPlan,
  AuditReport,
  BrainstormDocument,
  BrainstormEntryChoice,
  PrdDocument,
  EngineeringSpec,
  ProviderCatalog,
  ThreadStatus,
  Thread,
  ThreadTransferResult,
  ThinkingLevel,
  LocalRankingGradeProgress,
  AssistantAgents
} from '../../../lib/types'
import { OpenUsageClient } from '../../usage/openusage-client'
import { CustomProviderUsageClient } from '../../providers/custom-provider-usage-client'
import { BrainstormEngine } from '../../../lib/engines/brainstorm-engine'
import { GeneratedArtifactService } from '../generated-artifact-service'
import { GenerationClock } from '../../../lib/usage-rate'
import type {
  ActiveAssignmentDraftSession,
  ActiveBrainstormConversationTurn,
  ActiveBrainstormSession,
  ActiveInitialSpecSession,
  AssignmentApiCapability,
  ChildSessionInfo,
  AutoAnswerReport,
  HeldSteer,
  PendingImageDescriptorDecision,
  PendingAssignmentTurn,
  PendingMemoryDecision,
  PendingPermissionInfo,
  PendingPrdTurn,
  PendingSpecRevision,
  PersistedProviderCatalog,
  SessionCompletionWaiter,
  TemporaryChatDisplayHistory,
  TemporaryChatSession,
  TurnStreamCacheEntry
} from './chat-engine-types'
import type { UserTerminalWindow } from '../chat-engine'

import type { ChatEngine } from '../chat-engine'

/** Every field a ChatEngine owns, so the engine itself is only API and wiring. */
export class ChatEngineState {
  constructor(private readonly host: ChatEngine) {}

  ovenChat!: OvenChat

  readonly catalogProbeQueue = createWorkQueue(2)

  /** Managed-account drivers are lazy and isolated by credential container. */
  accountDrivers = new Map<string, HarnessDriver>()

  readonly openUsage = new OpenUsageClient()

  readonly customProviderUsage = new CustomProviderUsageClient()

  /** Which OpenCode transport `drivers.get('opencode')` currently holds. */
  openCodeDriverIsV2 = false

  /**
   * A transport swap that could not run yet because a turn owns the harness.
   * The swap is retried on the next idle signal and on the next acquisition
   * instead of being dropped, so a completed probe always converges.
   */
  openCodeHarnessSwapPending = false

  childSessionOwners = new Map<string, ChildSessionInfo>()

  childCaptureTasks = new Map<string, Promise<AgentMessage[]>>()

  /** Sub-agent usage events already written in this process, so a repeated
   *  sweep records each worker turn once without re-reading it from the ledger. */
  readonly recordedSubagentUsageIds = new Set<string>()

  /** Latest provider lifecycle status reported for each child session id, so
   *  transcript loads can tell an in-flight worker (transcript not flushed
   *  yet) from a genuinely unknown session. */
  childSessionActivityStatuses = new Map<string, AgentSubagentActivity['status']>()

  pendingPermissions = new Map<string, PendingPermissionInfo>()

  /** Memoized attachment allowlist per chat thread id. Invalidated whenever a
   *  user message is persisted (attachments may have changed) and dropped when
   *  the thread is deleted, avoiding a full message-record scan on every
   *  permission request. Rebuilt lazily on first access. */
  chatAttachmentAllowlists = new Map<string, string[]>()

  pendingImageDescriptorDecisions = new Map<string, PendingImageDescriptorDecision>()

  completionWaiters = new Map<string, SessionCompletionWaiter>()

  pendingMemoryDecisions = new Map<string, PendingMemoryDecision>()

  /** Number of automatic Mermaid correction prompts already issued for the active turn. */
  mermaidRepairAttempts = new Map<string, number>()

  /** One automatic utility-search nudge per active turn, per session. */
  searchNudgeAttempts = new Map<string, number>()

  /**
   * Sessions that rendered an inline artifact during the live turn.
   *
   * The visual-deliverable guard needs one fact the transcript cannot fake
   * reliably: did this turn actually publish an asset? The render executor owns
   * that fact, so it records it here and the guard reads it instead of guessing
   * from prose. Cleared for a session when a new user turn starts.
   */
  artifactRenderedSessions = new Set<string>()

  /** One visual-deliverable correction round per user prompt, per session. */
  visualDeliverableNudges = new Map<string, number>()

  /**
   * One app-issued task-list reconcile turn per user prompt, per session. The
   * guard fires when a turn settles while the list it published still shows
   * unfinished work, so the app's task card never freezes mid-run. Resetting
   * only on a genuine user prompt (like the other nudges) is what caps it at
   * one extra turn and keeps it from looping.
   */
  todoReconcileAttempts = new Map<string, number>()

  /**
   * Sessions whose live turn is the app-issued task-list reconcile prompt.
   *
   * A harness that reconciles inside its own turn reports the answer itself (see
   * `capabilities.reportsTaskReconcileAnswer`), but every other harness answers
   * this one in a turn the engine issues, so the engine already knows where the
   * exchange starts: its own prompt. Consumed at finalization and cleared by the
   * next user prompt, exactly like the attempt budget above.
   */
  taskReconcileTurns = new Set<string>()

  /** Latest high-frequency stream mutations waiting for the next renderer frame. */
  /** Parsed stream-log state per thread so a reopen only parses appended bytes. */
  turnStreamCache = new Map<string, TurnStreamCacheEntry>()

  /** Thread streams being rewritten right now, so a burst of loads schedules one. */
  readonly compactingTurnStreams = new Set<string>()

  /** Streams whose thread was deleted, so a late fire-and-forget append cannot
   *  recreate the file the deletion just removed. */
  readonly deletedTurnStreams = new Set<string>()

  pendingStreamBroadcasts = new Map<string, AgentEvent>()

  streamBroadcastTimer: ReturnType<typeof setTimeout> | null = null

  /** Number of hidden continuations issued after a turn ended without a final response. */
  incompleteTurnRecoveryAttempts = new Map<string, number>()

  /**
   * Automatic "Continue" recovery for a provider that answered "model at
   * capacity", keyed by session (see `ChatEngineCapacityContinue`). The budget
   * is consecutive: a successful answer, a user prompt, or a session teardown
   * clears it.
   */
  capacityContinues = new Map<string, CapacityContinueState>()

  /**
   * Threads whose assistant model fallback resume is in flight, keyed
   * `projectId:threadId`. The same provider failure is reported more than once
   * (the session event, the idle finalization, the rejected send), and a second
   * fallback armed while one is resuming would read the model the first one
   * just wrote and skip a candidate.
   */
  assistantFallbackResumes = new Set<string>()

  /** Per-project user-terminal activity: while the user is typing commands in
   *  an in-app terminal, an open fingerprint window (one per terminal worktree
   *  root) records what their shell moved, so those edits are never swept into
   *  a concurrent agent turn's bash-window diff or final checkpoint. */
  userTerminalWindows = new Map<string, Map<string, UserTerminalWindow>>()

  /** Harness sessions implementing an approved specification until its contract is fulfilled. */
  engineeringImplementationSessions = new Set<string>()

  temporaryChats = new Map<string, TemporaryChatSession>()

  temporaryChatDisplayMessages = new Map<string, TemporaryChatDisplayHistory>()

  initialSpecTasks = new Map<string, Promise<EngineeringSpec | null>>()

  activeInitialSpecSessions = new Map<string, ActiveInitialSpecSession>()

  userAbortedInitialSpecOperations = new Set<string>()

  /** Threads currently running the independent audit half of Achievement. */
  activeLoopRuns = new Set<string>()

  /** One durable auditor run per Assignment; concurrent callers join the same result. */
  activeAssignmentAuditRuns = new Map<
    string,
    Promise<{ report: AuditReport; auditorThread: Thread }>
  >()

  /** One durable auditor run per ordinary Engineering thread. */
  activeImplementationAuditRuns = new Map<
    string,
    Promise<{ report: AuditReport; auditorThread: Thread }>
  >()

  activeImplementationAuditorEnsures = new Map<string, Promise<Thread>>()

  /** One independent (spec-less) auditor run per thread. */
  activeIndependentAuditRuns = new Map<
    string,
    Promise<{ report: AuditReport; auditorThread: Thread }>
  >()

  activeIndependentAuditorEnsures = new Map<string, Promise<Thread>>()

  /** Assignment audits explicitly cancelled by Stop; late provider output must be ignored. */
  stoppedAssignmentAuditRuns = new Set<string>()

  /** Sessions owned by stopped Assignments stay quarantined until an explicit Resume. */
  stoppedAssignmentSessions = new Set<string>()

  /** Consecutive no-op coordinator continuations per Assignment (stall guard). */
  assignmentContinuationStalls = new Map<string, number>()

  /** Concurrent late-Assignment requests for one coordinator share one model run. */
  activeAssignmentDraftRuns = new Map<string, Promise<AssignmentPlan>>()

  /** The killable driver session currently drafting an Assignment, so Stop/Esc can reach it. */
  activeAssignmentDraftSessions = new Map<string, ActiveAssignmentDraftSession>()

  userAbortedAssignmentDraftOperations = new Set<string>()

  activeAchievementAuditorEnsures = new Map<string, Promise<Thread>>()

  activeAchievementAuditRuns = new Map<
    string,
    Promise<{ report: AuditReport; auditorThread: Thread }>
  >()

  /** Provider/model combinations that rejected JSON-schema output during this app run. */
  unsupportedStructuredOutputModels = new Set<string>()

  activeBrainstormOperations = new Set<string>()

  /** In-flight Brainstorm finalizations keyed by `projectId:threadId`. A repeat
   *  finalize for the same thread reuses the running promise instead of throwing
   *  a misleading "already updating this Brainstorm" while the spec is still
   *  being generated after the finalize. */
  activeBrainstormFinalizes = new Map<string, Promise<EngineeringSpec | BrainstormDocument>>()

  activeBrainstormSessions = new Map<string, ActiveBrainstormSession>()

  activeBrainstormConversationTurns = new Map<string, ActiveBrainstormConversationTurn>()

  userAbortedBrainstormOperations = new Set<string>()

  activeBrainstormEntryOperations = new Map<
    string,
    {
      choice: BrainstormEntryChoice
      promise: Promise<BrainstormDocument | EngineeringSpec | null>
    }
  >()

  pendingSpecRevisions = new Map<string, PendingSpecRevision>()

  /**
   * A conversational PRD turn. The agent either submits the document or asks the
   * user product questions, so the submission is captured only when the turn
   * finally ends without waiting for the user and without an error.
   */
  pendingPrdTurns = new Map<string, PendingPrdTurn>()

  prdTurnTasks = new Map<string, Promise<PrdDocument | null>>()

  /**
   * A conversational Assignment turn. The agent either submits the task graph
   * or interviews the user about the pieces the source does not settle, so the
   * submission is captured only when the turn finally ends without waiting for
   * the user and without an error.
   */
  pendingAssignmentTurns = new Map<string, PendingAssignmentTurn>()

  assignmentTurnTasks = new Map<string, Promise<AssignmentPlan | null>>()

  pendingBrainstormTurns = new Map<
    string,
    { brainstormId?: string; version?: number; note: string }
  >()

  brainstormAlignmentNotes!: BrainstormAlignmentNotes

  /**
   * The app-owned Getting started checkpoints. One assistant keeps one, and it is
   * re-injected into every authoring turn beside the answers the user already
   * submitted, so the interview survives a model or harness switch mid-way.
   */
  assistantAuthoringCheckpoints!: AssistantAuthoringCheckpoints

  /** Sessions currently running an explicit context compaction. */
  activeCompactions = new Set<string>()

  /**
   * Last provider/model each harness session was successfully dispatched
   * under, plus the thinking level the turn started with. A later model
   * switch on a reused native session is detectable without a per-turn mirror
   * read; the mirror backfills the first turn after an app restart. The
   * thinking level rides along so turn completion stamps what the turn
   * actually ran with   never the composer's mid-turn changes.
   */
  readonly sessionModelIds = new Map<
    string,
    { providerId: string; modelId: string; thinkingLevel?: ThinkingLevel }
  >()

  specRevisionTasks = new Map<string, Promise<EngineeringSpec | null>>()

  /** Fresh sessions prepared for the approved-spec implementation handoff.
   * The renderer and send path both call ensureSession; retain the new id so
   * that handshake rotates exactly once. */
  preparedImplementationSessions = new Set<string>()

  /** Provider sessions that have carried engineering planning instructions.
   * They must not cross the approval boundary into implementation. */
  planningSessions = new Set<string>()

  sessionIdleFinalizations = new Map<string, Promise<void>>()

  sessionIdleFinalizationWaiters = new Map<
    string,
    { resolve: () => void; reject: (error: unknown) => void }[]
  >()

  /** Sessions the user intentionally stopped (esc+esc / cancel / permission
   * reject). Their turns must finalize as `interrupted`, never as `failed`, so
   * the sidebar never shows an error badge for a deliberate stop. */
  userAbortedSessions = new Set<string>()

  /** Provider user-message echoes that must never enter renderer streaming state. */
  outboundMessageIdsBySession = new Map<string, Set<string>>()

  projectManager!: ProjectManager

  threadTransferPreflight:
    ((projectId: string, threadId: string) => Promise<ThreadTransferResult>) | null = null

  workflowOwnership!: WorkflowOwnershipService

  specEngine!: SpecEngine

  brainstormEngine!: BrainstormEngine

  prdEngine!: PrdEngine

  engineeringLifecycleEngine!: EngineeringLifecycleEngine

  auditEngine!: AuditEngine

  assignmentEngine!: AssignmentEngine

  assignmentApiServer: Server | null = null

  assignmentApiBaseUrl = ''

  readonly assignmentApiCapabilities = new Map<string, AssignmentApiCapability>()

  /** Per-Assignment request tails prevent stale whole-plan snapshots from overwriting each other. */
  readonly assignmentApiQueues = new Map<string, Promise<void>>()

  /** Serializes durable child-to-coordinator queue reads and writes per Sr. Engineer thread. */
  readonly coordinatorHandoffQueueLocks = new Map<string, Promise<void>>()

  /** Prevents concurrent idle signals from dispatching the same queued handoff twice. */
  readonly coordinatorHandoffDrains = new Map<string, Promise<void>>()

  /** Identifies the one queued handoff currently being delivered through sendPrompt. */
  readonly dispatchingCoordinatorHandoffIds = new Set<string>()

  memoryService!: MemoryService

  providerCache = new Map<string, ProviderCatalog[]>()

  sharedProviderCatalog: PersistedProviderCatalog | null = null

  providerDiscovery: Promise<ProviderCatalog[]> | null = null

  /**
   * Last-seen provider-catalog input fingerprints per driver (drivers that
   * implement `providerCatalogFingerprint`). A drift between the recorded
   * value and a freshly computed one invalidates the shared catalog cache  
   * e.g. the user connecting or logging out of a pi provider while the 1h TTL
   * cache would otherwise keep serving the stale model list.
   */
  catalogFingerprints = new Map<string, string>()

  /** Guards concurrent probe-driven catalog invalidations. */
  catalogInvalidationInFlight: Promise<void> | null = null

  /** Resolved agent tool catalogs keyed by their discovery context. */
  toolCatalogCache = new Map<string, { catalog: AgentToolCatalog; at: number }>()

  /**
   * Whether `ensureSession` confirmed the harness session natively holds the
   * conversation (non-empty provider history). `buildHistoryRecap` uses this to
   * avoid loading provider history a second time (A-13).
   */
  readonly sessionNativeHistory = new Map<string, boolean>()
  /**
   * Sessions a rebuild prefilled from only the newest part of the thread, and
   * the summary of what that prefill left in the database. Such a session
   * holds the tail natively, so it needs only the pointer (the thread id and
   * the queries that recover the rest) instead of a rendered replay.
   */
  readonly prefilledHistoryBoundaries = new Map<
    string,
    { summary: HistoryHandoffSummary; delivered: boolean }
  >()

  /**
   * Where the conversation resumes for a session adopted from a parked branch
   * after a harness switch, keyed by session id. `boundary` is the id of the
   * last message the parked native transcript already contains, or null to
   * replay the whole thread; `recap` memoizes the rendered delta for the
   * session's lifetime, and `repeat` says whether that delta has to ride every
   * later turn (a driver that does not retain a recap) instead of one.
   */
  readonly parkedSessionReplay = new Map<
    string,
    { boundary: string | null; repeat: boolean; recap?: string; recapBudget?: number }
  >()

  /**
   * Sessions the last {@link reconcileUnverifiedWork} sweep saw idle but has not
   * yet seen idle twice. A single quiet poll can land inside a compaction or
   * provider-retry gap, so a turn is only settled once its harness has reported
   * it idle on two consecutive sweeps.
   */
  ghostWorkingCandidates = new Set<string>()

  /**
   * Signature of the threads this process last announced as running.
   *
   * A turn emits several lifecycle transitions, and only the ones that move the
   * set of running threads are worth telling a sibling about   every
   * announcement costs it a re-read of the shared turn ledger.
   */
  localRunSignature = ''

  /** Auto-resume scheduler for harnesses that do not manage their own retries. */
  retryScheduler: RetrySchedulerService | null = null

  stopRemoteRetryReconciliation: (() => void) | null = null

  /** Verified device connectivity; null only before boot attaches it. */
  connectivity: ConnectivitySource | null = null

  /**
   * Resolves the model set an assistant task's assistant runs on. Attached by the
   * bootstrap, which owns the assistant manager; absent means assistant tasks get
   * no model fallback.
   */
  assistantAgentsResolver: ((task: Thread) => AssistantAgents | undefined) | null = null

  /**
   * Records that an assistant task's turn settled with a final status, so the
   * assistant can note its last successful run when the run truly completes.
   * Attached by the bootstrap, which owns the assistant manager; absent means run
   * outcomes are not tracked.
   */
  assistantRunSettled: ((threadId: string, status: ThreadStatus) => void) | null = null

  /**
   * Receives one report per gate the engine resolves without the user: a
   * question whose timer answered it, a secret card whose deadline closed it,
   * or an image-descriptor decision that timed out. Attached by the bootstrap,
   * which owns the durable attention store; absent means nothing is recorded.
   */
  autoAnswerRecorder: ((report: AutoAnswerReport) => void) | null = null

  /**
   * The report a run declared for its own turn, keyed by thread, held until the
   * turn settles.
   *
   * The file is written at finalization rather than at the moment of the call, so
   * it carries the settled status and the run time, and a turn that ends without a
   * final answer leaves no file behind. A new turn clears the entry, so a
   * declaration from an aborted turn can never be filed by a later one.
   */
  declaredAssistantReports = new Map<string, { title: string; markdown?: string }>()

  /** Coalesces live-activity repairs of a task's persisted working status. */
  workingStatusReconciliations = new Map<string, Promise<void>>()

  readonly agentProcesses = new AgentProcessService()

  generatedArtifactService!: GeneratedArtifactService

  prototypePreviewRegistrar:
    ((previewSlug: string, canonicalRoot: string) => Promise<void>) | null = null

  /**
   * Tracks reasoning start timestamps per session per part id.
   * Used to stamp `time.start`/`time.end` on reasoning parts during streaming
   * and persist them to the message mirror on session idle.
   */
  reasoningTimes = new Map<string, Map<string, { start: number; end?: number }>>()

  /**
   * Tracks tool invocation timestamps per session per part id.
   * Used to stamp `state.time.start`/`state.time.end` on tool parts during
   * streaming and persist them to the message mirror on session idle.
   */
  toolTimes = new Map<string, Map<string, { start: number; end?: number }>>()

  /**
   * Accumulated model-active generation time per session and assistant message.
   * The stream is the only clock available, so output signals and request
   * boundaries are folded into a {@link GenerationClock} whose total is stamped
   * onto the message as `generationMs`: the time the model spent generating,
   * excluding time-to-first-token and every tool wait.
   */
  generationClock = new GenerationClock()

  /** Steered messages held back from the harness while its active turn has a
   *  tool call in flight   the undo window. Keyed by sessionId. */
  heldSteers = new Map<string, HeldSteer>()

  /**
   * Per-session watchdog timers. Each timer is set after a prompt is sent and
   * reset on every SSE activity for that session. When the timer fires, provider
   * history is checked for an explicit failure; silence alone is never terminal.
   */
  sessionWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

  /**
   * Tracks since-when each project has been fully idle, so the idle reaper can
   * release its harness resources (pooled servers, in-memory session caches)
   * after the grace period to free memory and any agent-spawned processes.
   * The harness sessions themselves persist on disk and rehydrate when the
   * project is next used.
   */
  projectIdleSince = new Map<string, number>()

  /**
   * Project paths touched by harness operations that may allocate resources
   * before a session exists. Read-only probes (for example the battery usage
   * refresh) must remain visible to the idle reaper even when the user never
   * sends a message and therefore never registers a session.
   */
  projectResourcePaths = new Map<string, Set<string>>()

  /**
   * Projects whose harness resources have already been released. They are not
   * released again until the project becomes active (a prompt, an event, or a
   * session re-registration)   otherwise the reaper would re-release every
   * grace period forever.
   */
  releasedProjects = new Set<string>()

  /**
   * Harnesses whose resident transports must be restarted as soon as no thread
   * is using them. A harness update that lands while a thread is still running
   * may not take that thread's transport away, so the restart is remembered and
   * the idle reaper applies it once the harness goes quiet.
   */
  deferredHarnessRestarts = new Set<string>()

  idleReaperTimer: ReturnType<typeof setInterval> | null = null

  // 5 minutes

  /** Timestamp of the last orphan sweep (see {@link sweepOrphanedProcesses}). */
  lastOrphanSweepAt = 0

  /** Timestamp of the last user interaction (e.g. sendPrompt, answerQuestion). */
  lastUserActivityAt = 0

  repositoryService = new RepositoryService()

  projectFilesService!: ProjectFilesService

  promptAssembler!: PromptAssembler

  secretVault!: SecretVault

  utilityRuntime!: UtilityRuntimeService

  utilityRegistry!: UtilityRegistryService

  agentSecrets!: AgentSecretService

  capabilityDiscovery!: CapabilityDiscoveryService

  /** Proves an MCP server connects, on demand from the Utilities page and editor. */
  mcpConnectionTest!: McpConnectionTestService

  /** OAuth authorization for remote MCP utilities, shared with the Utilities page. */
  mcpOAuthService!: McpOAuthService

  baseUrlProviders!: BaseUrlProviderService

  accountRegistry!: HarnessAccountRegistry

  utilityOrchestration!: UtilityOrchestrationService

  /**
   * What each thread decided about the experts its design or video session may
   * use. Wired by the service graph after the window exists; until then a
   * delegation reads the config directly, which is what this app did before a
   * thread could answer for itself.
   */
  expertSettings: ExpertSettingsService | null = null

  usageRepo!: HarnessUsageRepo

  assistantRepo!: AssistantRepo

  /**
   * The app's TypeSafe (Jev) decision capability, attached during boot.
   *
   * Null means the capability is not available at all, and every seam that asks
   * it for a judgement falls straight through to the code it ran before TypeSafe
   * existed. A seam never has to distinguish "not configured" from "down": both
   * are the same fallback, which is what keeps an outage from being a special case
   * in each caller.
   */
  typesafeDecision: TypesafeDecisionService | null = null

  /**
   * Fall-through outcomes already reported, so a standing one logs once.
   *
   * An unconfigured capability falls through on every single grade, and the log
   * line that describes it is identical every time. Recording the outcome once
   * is what keeps a configuration fact out of the per-turn noise.
   */
  readonly reportedTypesafeFallthroughs = new Set<string>()

  /** Last reading of whether the capability is currently in a state that answers. */
  typesafeAnswerable: { value: boolean; checkedAt: number } | null = null

  gradeDrainRunning = false

  /**
   * The user-requested run in flight, or null when the queue is idle. Held here
   * (not only in the IPC layer) so the panel can read live progress from
   * anywhere and a second request joins the run instead of starting a rival one.
   */
  rankingManualRun: LocalRankingGradeProgress | null = null

  /**
   * The run in flight, so a second request awaits the same result instead of
   * reading a half-filled snapshot of it. Cleared by whichever caller started
   * the run, once that run settles.
   */
  rankingManualRunPromise: Promise<LocalRankingGradeProgress> | null = null

  /**
   * Earliest moment the next ranking pass may run, set while rows a pass could
   * not re-date are still due in the queue. Read by every `scheduleRankingDrain`
   * call, so no external trigger can bypass it; cleared as soon as it passes.
   */
  rankingHeldRetryAtMs: number | null = null

  /**
   * Consecutive judge failures per harness. Deliberately in-memory: a restart
   * gives a blocked judge one fresh attempt, which is cheap, and a single
   * scored row clears the record.
   */
  rankingJudgeFailures = new Map<string, number>()

  /**
   * Native graded-harness judge strikes. Set once a harness's own grading
   * route failed one row, cleared only when that route scores again. While a
   * harness carries a strike, its queue stops spending harness processes on
   * its own candidates and judges through the harness-agnostic fallback lane
   * (see `resolveFallbackRankingJudge`). Deliberately in-memory like
   * `rankingJudgeFailures`: a restart gives the native route one fresh
   * attempt, which is cheap, and the fallback lane keeps that attempt from
   * ever duplicating the held-back herd of a permanently unusable account.
   */
  rankingNativeJudgeStrikes = new Map<string, number>()

  utilityTurns = new Map<
    string,
    {
      driver: HarnessDriver
      projectId: string
      projectPath: string
      runtime?: PreparedUtilityRuntime
      gateway: UtilityTurnGateway
      threadId: string
      cleanupPromise?: Promise<void>
    }
  >()

  /** Threads whose user has invoked @cio-utility at least once (current turn
   *  or history). Once recorded, the setup + diagnostics contract stays
   *  reusable by the agent in every later turn of that thread without
   *  repeating the invocation. */
  cioUtilityThreads = new Map<string, true>()

  /** Threads whose user has opened a design session with @cio-design (current
   *  turn or history). A design is edited over many messages, so the session
   *  keeps the design capability active until the user leaves the thread. */
  cioDesignThreads = new Map<string, true>()

  /** Threads whose user has opened a video session with @cio-video (current
   *  turn or history). An edit is worked on over many messages, so the session
   *  keeps the video capability active until the user leaves the thread. */
  cioVideoThreads = new Map<string, true>()

  /** Threads whose user has opened an orchestration session with
   *  @cio-hey (current turn or history). The session is what grants the
   *  workstation tools, so it stays active for every later turn of the thread
   *  rather than for one message. */
  cioOrchestrateThreads = new Map<string, true>()

  /**
   * Announces to the renderer that the terminal session behind a killed pid is
   * ending on purpose, so it does not respawn the shell. Wired by the bootstrap
   * from the PTY service, which is the only side that knows the sessions.
   */
  ptyStopAnnouncer: ((pid: number) => boolean) | null = null
}
