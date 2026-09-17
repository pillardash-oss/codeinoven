import type { IsolatedHandle } from '../../drivers/opencode-driver'
import type { ProjectFingerprint } from '../../git/change-tracking-service'
import type { PermissionDecisionResult } from '../../permissions/permission-policy'
import type { HarnessDriver, StructuredOutputRequest } from '../../drivers/driver.interface'
import type { AuxiliaryModelCandidate } from '../../drivers/driver.interface'
import type { ResolvedImageEntry } from '../../providers/image-descriptor-provider'
import type { AgentSecretResolution } from '../../utilities/agent-secret-service'
import type {
  AgentMessage,
  AgentModelSelection,
  AgentPart,
  AgentQuestionResolution,
  AssignmentPlan,
  AssignmentTask,
  EngineeringSpec,
  PendingAgentQuestionRequest,
  ImageDescriptorErrorRequest,
  MemoryCategory,
  MemoryPriority,
  MemoryScope,
  PermissionLevel,
  PermissionRequest,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  ProviderCatalog,
  SpecActionIntent,
  UserMessagePresentation,
  ThreadStatus,
  Thread,
  ThreadSettings,
  ThinkingLevel
} from '../../../lib/types'
import type { TurnStreamEvent } from '../turn-stream'

export interface PersistedProviderCatalog {
  schemaVersion: 3
  discoveredAt: number
  catalogs: ProviderCatalog[]
  /** Last-seen per-driver catalog-input fingerprints; drift invalidates the snapshot. */
  catalogFingerprints?: Record<string, string>
}

/**
 * Resolved user-assigned auxiliary model for one harness's background work.
 * `harnessId` and `settings` describe the harness that actually runs the
 * auxiliary session, which may differ from the harness the thread runs on.
 */
export interface AuxiliaryRoute {
  driver: HarnessDriver
  projectPath: string
  harnessId: string
  providerId: string
  modelId: string
  /** The single explicit candidate the disposable session must use. */
  candidates: AuxiliaryModelCandidate[]
  /** Harness-correct settings for the disposable auxiliary session. */
  settings: ThreadSettings
}

export interface AgentMemoryProposalInput {
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
  modelKeys?: string[]
}

export interface StructuredMemoryProposal {
  propose: boolean
  title: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
}

export interface SessionInfo {
  sessionId: string
  projectId: string
  threadId: string
  projectPath: string
  permissionLevel: PermissionLevel
  driverId: string
  /** Credential container that owns this native session. */
  accountId?: string
  activeTurnId?: string
  /** Stable user message that starts the active provider turn. */
  activeTurnUserMessageId?: string
  /** Last bound turn id for this session. Stream events emitted while
   *  `activeTurnId` is unbound (pre-registration setup, post-checkpoint
   *  teardown, silent continues) still carry this id so the durable trace log
   *  keeps them attached to a real turn instead of an unbindable empty tag. */
  lastTurnId?: string
  /** Composed request occupancy used only when the harness emits no native context usage. */
  estimatedContextUsed?: number
  /** True once this session's provider reported a real per-turn token usage
   *  total. Providers that report usage make the composed-send estimate
   *  (which measures only the composed text layers, never the harness
   *  transcript) both unnecessary and wildly wrong as a context signal, so
   *  the estimate fallback must stay disabled for them. */
  hasReportedTokenUsage?: boolean
  changedPaths?: Set<string>
  /** Paths claimed by precise file-mutating tools this turn, path → last claimed ms. */
  preciseChangedPaths?: Map<string, number>
  /** Shell-like tool part ids currently in flight for the active turn. */
  openUnboundedTools?: Set<string>
  /** Whether this turn invoked a shell-like tool. Its before/after project diff
   *  is the completion fallback if command parsing or a stat window misses a write. */
  unboundedToolObserved?: boolean
  /** Paths the user saved through the in-app editor while this turn ran.
   *  These are the user's own edits   never attributed to the thread. */
  userTouchedPaths?: Set<string>
  /** In-flight reopen of a just-settled turn whose edits kept arriving. */
  pendingReopen?: Promise<void>
  /** Filesystem fingerprint taken when the first of those tools started. */
  unboundedWindowStart?: Promise<ProjectFingerprint | null>
  /** Window-close scans that must settle before the turn checkpoint is completed. */
  pendingWindowScans?: Set<Promise<void>>
  ephemeral?: boolean
}

export interface TemporaryChatSession {
  id: string
  kind: 'chat'
  projectId: string
  threadId: string
  projectPath: string
  driverId: string
  accountId?: string
  /** Provider the session's turns run against, for quota reads. */
  providerId?: string
  sessionId: string
  isolated?: IsolatedHandle
  contextApplied: boolean
  inactivityMs: number
  expiresAt: number
  expiryTimer: ReturnType<typeof setTimeout>
}

/**
 * Presentation-safe user-message records for temporary chats   the in-memory
 * analog of the thread mirror's `persistOutboundMessage` rows. The harness
 * transcript only ever contains the full transport prompt, so without this
 * overlay the internal instruction leaks into the temporary chat UI (and into
 * converted threads). Display parts ride here; the echoed harness record under
 * the same ID demotes to `transportParts` when the transcript is loaded.
 */
/**
 * A steered user message held by the chat engine while the harness's active
 * turn still has a tool call in flight. The harness has NOT received it yet,
 * so the user can undo it. When the last in-flight tool ends the steer is
 * delivered mid-turn; when the whole turn idles first it is flushed as a
 * regular next-turn send. One record per active steer, keyed by session.
 */
export interface HeldSteer {
  projectId: string
  /** Thread id (threads) or temporary chat id (temporary chats). */
  conversationId: string
  userMessageId: string
  kind: 'thread' | 'temporary'
  /** Deliver the steer to the live turn now (tool window closed mid-turn). */
  deliverMidTurn: () => Promise<void>
  /** The turn ended before a delivery window opened   send as the next turn. */
  deliverAfterTurn: () => Promise<void>
  /** Drop the steer entirely: nothing ever reached the harness. */
  discard: () => Promise<void>
}

export interface TemporaryChatDisplayRecord {
  message: AgentMessage
  references: PromptReference[]
}

/** Every recorded turn, ordered oldest-first   one record per user turn, so
 *  later turns never erase the presentation-safe view of earlier ones. */
export interface TemporaryChatDisplayHistory {
  records: TemporaryChatDisplayRecord[]
  /** Recap of the kept conversation after a history deletion   consumed as
   *  the hidden context of the first send into the replacement session. */
  pendingContext?: string
}

export interface ActiveBrainstormSession {
  sessionId: string
  driver: HarnessDriver
  driverId: string
  projectPath: string
  isolated?: IsolatedHandle
}

export interface TurnStreamCacheEntry {
  /** Byte offset of the stream log already consumed by this entry. */
  consumedBytes: number
  /** Every parsed stream event, in log order. */
  events: TurnStreamEvent[]
  /** Turn id of the last event that carried one. */
  latestTurnId: string
  /** Fold inputs the cached `folded` parts were built from. */
  foldKey: string | null
  folded: AgentPart[] | null
}

export interface ActiveAssignmentDraftSession {
  sessionId: string
  driver: HarnessDriver
  driverId: string
  projectPath: string
  isolated?: IsolatedHandle
}

export interface ActiveInitialSpecSession {
  sessionId: string
  threadSessionId: string
  driver: HarnessDriver
  projectPath: string
  isolated?: IsolatedHandle
  startedAt: number
  attempt: number
}

export interface ActiveBrainstormConversationTurn {
  id: string
  userMessage: AgentMessage
  parts: AgentPart[]
  startedAt: number
}

export interface PendingSpecRevision {
  schemaVersion: 1
  projectId: string
  threadId: string
  sessionId: string
  specId: string
  baseVersion: number
  harnessId: string
  providerId: string
  modelId: string
  createdAt: number
}

export interface PendingPrdTurn {
  schemaVersion: 1
  projectId: string
  threadId: string
  sessionId: string
  harnessId: string
  providerId?: string
  modelId?: string
  createdAt: number
}

export interface AssignmentApiCapability {
  role: 'coordinator' | 'worker'
  assignmentId: string
  threadId: string
  taskId?: string
}

export interface AssignmentWorkerContext {
  assignment: AssignmentPlan
  task: AssignmentTask
  worker: Thread
}

export interface AssignmentWorkerRoutingResult {
  directCoordinatorTasks: AssignmentTask[]
  routed: AssignmentWorkerContext[]
}

export interface ChildSessionInfo {
  projectId: string
  threadId: string
  projectPath: string
  driverId: string
  accountId?: string
  /** Root thread session whose watchdog must include this child's activity. */
  parentSessionId?: string
}

export interface PendingPermissionInfo {
  driverId: string
  /** Exact runtime instance that emitted the blocking request. */
  driver?: HarnessDriver
  session: SessionInfo
  request: PermissionRequest
  policy: PermissionDecisionResult
  resumeStatus: Extract<ThreadStatus, 'planning' | 'executing'>
}

export interface PendingQuestionInfo {
  request: PendingAgentQuestionRequest
  driverId: string
  projectPath: string
  timeoutMs: number
  resolving: boolean
  resumeStatus: Extract<ThreadStatus, 'planning' | 'executing'>
  timer?: ReturnType<typeof setTimeout>
  resolution?: AgentQuestionResolution
  answers?: string[][]
  /**
   * Set for an app-owned `cio_ask_secret` request. The gateway tool call that
   * asked is still open, so it settles here instead of being answered through a
   * harness: the values never travel to a driver.
   */
  settleSecret?: (resolution: AgentSecretResolution) => void
}

/** How the user resolved a failed image-descriptor call. */
export type ImageDescriptorUserDecision =
  | { action: 'retry'; selection?: AgentModelSelection }
  | { action: 'pick_image'; entry: ResolvedImageEntry }
  | { action: 'ignore' }

/** A blocked image-descriptor tool call awaiting a user decision. */
export interface PendingImageDescriptorDecision {
  sessionId: string
  projectId: string
  threadId: string
  request: ImageDescriptorErrorRequest
  resolve: (decision: ImageDescriptorUserDecision) => void
  /** Thread status to restore once the decision resolves. */
  resumeStatus: Extract<ThreadStatus, 'planning' | 'executing'>
  timer?: ReturnType<typeof setTimeout>
}

export interface SessionCompletionWaiter {
  active: boolean
  structuredOutput?: unknown
  resolve: (structuredOutput: unknown | undefined) => void
  reject: (error: Error) => void
  timer?: ReturnType<typeof setTimeout>
  /** Re-arm the inactivity deadline so slow-but-active sessions are not killed. */
  refresh: () => void
}

export interface PendingMemoryDecision {
  userMessage: string
  settings: ThreadSettings
  references: PromptReference[]
}

export interface QueuedCoordinatorHandoff {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  settings: ThreadSettings
  text: string
  attachments: PromptAttachment[]
  specAction?: SpecActionIntent
  promptContext?: string
  promptReferences: PromptReference[]
  projectReferences: PromptProjectReference[]
  presentation?: UserMessagePresentation
  taskReferences: PromptAssignmentTaskReference[]
  createdAt: number
}

export interface CoordinatorHandoffQueue {
  schemaVersion: 1
  projectId: string
  threadId: string
  items: QueuedCoordinatorHandoff[]
}

export interface PendingInitialSpecGeneration {
  schemaVersion: 1
  generationVersion: number
  projectId: string
  threadId: string
  sessionId: string
  source: string
  settings: ThreadSettings
  state: 'pending' | 'generating' | 'failed'
  attempts: number
  createdAt: number
  updatedAt: number
  error?: string
  repairArtifactPath?: string
  brainstormId?: string
  brainstormVersion?: number
  brainstormInputHash?: string
  prdId?: string
  prdVersion?: number
  prdInputHash?: string
  /**
   * When true, the generation source is explicit (e.g. a Brainstorm document) and the
   * engine must not try to read a spec submission from the planning session. Brainstorm
   * derived specs always generate fresh; consulting the planning session there just
   * produces a misleading "invalid JSON" recovery log.
   */
  skipSubmittedRead?: boolean
}

export type SpecGenerationFormatMode = 'structured' | 'json' | 'domain'

/**
 * Authoritative source for one Assignment decomposition. An approved
 * specification wins whenever it exists; otherwise the thread conversation
 * (the user's own message) is the scope, so an Assignment never requires a
 * specification to be generated first.
 */
export type AssignmentGenerationSource =
  { kind: 'spec'; spec: EngineeringSpec } | { kind: 'conversation' }

export interface SpecGenerationLesson {
  code: string
  instruction: string
  observations: number
  lastObservedAt: number
}

export interface SpecGenerationMemory {
  schemaVersion: 1
  harnessId: string
  providerId: string
  modelId: string
  lessons: SpecGenerationLesson[]
  updatedAt: number
}

export interface RejectedSpecArtifact {
  schemaVersion: 1
  generationVersion: number
  projectId: string
  threadId: string
  attempt: number
  format: SpecGenerationFormatMode
  harnessId: string
  providerId: string
  modelId: string
  diagnostic: string
  rejectedOutput: string
  createdAt: number
}

export interface AssignmentAuditRepairManifest {
  schemaVersion: 1
  status: 'invalid' | 'valid'
  projectId: string
  threadId: string
  assignmentId: string
  /** Absent for a spec-less Assignment whose audit has no specification. */
  specId?: string
  specVersion?: number
  runId: string
  attempt: number
  attemptPath: string
  errors: string[]
  previousErrors?: string[]
  updatedAt: number
}

export interface PersistedAuditAttempt {
  relativePath: string
  artifactPath: string
}
export interface VirtualTaskOptions {
  utilityManagement?: boolean
  isolateOpenCode?: boolean
  readOnly?: boolean
  systemPrompt?: string
  allowedTools?: string[]
  structuredOutput?: StructuredOutputRequest
  /**
   * Prompt-only drivers cannot enforce `structuredOutput`. Give those drivers
   * a bounded in-session correction path while preserving native schema output
   * for drivers that support it.
   */
  textOutputFallback?: {
    accepts(response: AgentMessage): boolean
    repairPrompt(response: AgentMessage, attempt: number): string
  }
}

/** Minimal judge payload reconstructed from one durable queue row. */
export interface RankingGradeCandidate {
  id: string
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel: ThinkingLevel
  userMessage: string
  assistantOutput: string
  followUp: string | null
}

/**
 * Which judge produced one grading result, or failed to produce one. Grading
 * can run on the user-assigned auxiliary model or on the graded harness's own
 * cheap candidate, so a failure is only diagnosable when the log names the
 * judge that actually ran.
 */
export interface RankingJudgeOutcome {
  /** 0–10 score, or null when no judge returned a number. */
  score: number | null
  /** Harness that ran the judge: the assigned auxiliary harness, or the graded harness. */
  judgeHarnessId: string
  /** Model that ran the judge. */
  judgeModelId: string
  /** True when the attempt ran on the user-assigned auxiliary model. */
  viaAuxiliary: boolean
}

/**
 * What one ranking drain pass may judge, decided before it claims anything.
 *
 * A row whose every judge route sits inside a provider usage window the
 * provider itself reported is held back unclaimed: claiming it would consume a
 * judge attempt on work that cannot run and would report a null score no user
 * asked for. Held rows are keyed by the moment their window reopens, so the
 * pass writes one deadline per distinct window rather than one per row.
 */
export interface RankingPassPlan {
  /** Ids this pass may judge, in queue order. */
  claimIds: string[]
  /** Held-back rows grouped by the deadline they wait for. */
  heldBack: Array<{ untilMs: number; ids: string[] }>
}
