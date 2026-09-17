import type {
  AgentModelSelection,
  InferenceMode,
  ModelIdentity,
  PermissionLevel,
  ThinkingLevel
} from './common'
import type { ProjectFileEntry } from './scope-worktree'
import type { AgentProviderIssueKind } from './agent-events'
import type { AssignmentTaskStatus } from './assignment'

/** A single thinking preset a model can expose, with a unique id and human label. */
export interface ThinkingPreset {
  id: string
  label: string
  description?: string
}

/**
 * Auxiliary model assignments keyed by the harness a thread runs on. The value
 * names the harness, account, provider, and model that runs that harness's
 * auxiliary work (thread titles, memory proposals, turn grading). A value may
 * name a different harness than its key, so one local Pi model can serve every
 * harness. An absent entry means the harness keeps its own price-optimized
 * candidate list.
 */
export type AuxiliaryAgentConfig = Record<string, AgentModelSelection>

/** Optional global model defaults for Engineering's distinct agent roles. */
export interface AgentDefaultsConfig {
  seniorEngineer?: AgentModelSelection
  worker?: AgentModelSelection
  auditor?: AgentModelSelection
  /** Vision model used to describe images for text-only models. */
  imageDescriptor?: AgentModelSelection
  /** Fallback vision model tried automatically when the primary image descriptor fails. */
  imageDescriptorFallback?: AgentModelSelection
  /** When enabled, role changes made inside a thread replace the matching global default. */
  syncFromThreadChanges: boolean
}

/** Per-thread agent configuration. Active-thread settings seed siblings; last-used is the fallback. */
export interface ThreadSettings {
  /** Agent harness responsible for the session, e.g. opencode or codex. */
  harnessId: string
  /** Model provider exposed by the harness, e.g. anthropic or openai. */
  providerId: string
  /** Selected credential container. Missing means the harness's legacy Default account. */
  accountId?: string
  modelId: string
  /** Use only the immediate deterministic fallback title, skipping auxiliary model calls. */
  titleMode?: 'model' | 'deterministic'
  thinkingLevel: ThinkingLevel
  /** Fast inference for this thread's turns; `fast` requests the harness fast tier. */
  inferenceMode?: InferenceMode
  permissionLevel: PermissionLevel
  /** Optional multi-agent planning workflow layered on Engineering mode. */
  assignmentMode?: boolean
  /** Enable Achievement's automatic implementation-audit correction cycle. */
  loopMode?: boolean
  /** Chat-only: grant the thread file-operation tools. Off by default   plain chats are web-only. */
  fileSystemMode?: boolean
  /** Independent model selected for Achievement audits. */
  loopAuditor?: AgentModelSelection
  /** Vision model used to describe images for this thread's text-only model. */
  imageDescriptor?: AgentModelSelection
  /** Fallback vision model tried automatically when the primary image descriptor fails. */
  imageDescriptorFallback?: AgentModelSelection
}

/**
 * Strip settings fields from removed eras so stale persisted rows and
 * last-used snapshots never re-enter the app. Currently drops the legacy
 * `engineeringMode` flag, which was superseded by the Engineering lifecycle
 * selection. Returns a shallow copy; never mutates the input.
 */
export function sanitizeThreadSettings(settings: unknown): Partial<ThreadSettings> {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return {}
  const { engineeringMode: _legacyEngineeringMode, ...rest } = settings as Record<string, unknown>
  return rest as Partial<ThreadSettings>
}

/** Result of the most recent heartbeat ping attempt. */
export interface HeartbeatLastRun {
  /** Epoch ms when the ping was sent. */
  at: number
  success: boolean
  error?: string
}

/**
 * A scheduled "keep the usage window warm" ping. At each configured time of
 * day, an ephemeral thread sends `Simply respond pong` to the selected model
 * and discards the reply   the same disposable-session mechanism title
 * generation uses, just to touch the provider's usage window early.
 */
export interface HeartbeatConfig extends AgentModelSelection {
  id: string
  name: string
  /** Times of day in 24h `HH:mm` local-time form, e.g. `["04:00", "13:30", "22:00"]`. */
  times: string[]
  enabled: boolean
  lastRun?: HeartbeatLastRun
}

/** A model exposed by a harness provider. */
export interface ProviderModel {
  id: string
  providerId: string
  name: string
  reasoning: boolean
  /** Thinking presets this model supports. When absent or empty, thinking controls are hidden. */
  thinkingPresets?: ThinkingPreset[]
  attachment: boolean
  toolcall: boolean
  /** Maximum tokens the provider allows in one model context. */
  contextWindow?: number
  /** True when the harness exposes a fast-inference tier for this model. */
  fastSupported?: boolean
}

/** A harness provider and the models it currently exposes. */
export interface ProviderCatalog {
  id: string
  name: string
  harnessId: string
  models: ProviderModel[]
  /** True when the owning harness accepts prompt attachments at all. */
  supportsAttachments?: boolean
  /** Explicit discovery state when a harness cannot report account-selectable models. */
  catalogStatus?: 'available' | 'unavailable'
  /** Operator-facing reason for an unavailable authoritative catalog. */
  catalogMessage?: string
}

/** A pending tool permission request surfaced by the harness. */
export interface PermissionRequest {
  id: string
  sessionId: string
  /** Permission category, e.g. `bash`, `edit`, `webfetch`. */
  permission: string
  /** Resource patterns the tool wants to touch. */
  patterns: string[]
  /** Arbitrary tool metadata (command, file path, ...). */
  metadata: Record<string, unknown>
  policy?: {
    risk: 'low' | 'medium' | 'high' | 'critical'
    reason: string
    expiresAt?: number
    scopedPaths: string[]
  }
}

/** How the user resolved a failed image-descriptor vision-model call. */
export type ImageDescriptorReplyAction = 'retry' | 'ignore' | 'false_positive' | 'pick_image'

/** A model the app recorded as vision-capable, reported by the user. */
export interface VisionModelRecord {
  /** Normalized model id (trimmed, lowercased); matches across harnesses and providers. */
  id: string
  /** When the model was reported as vision-capable. */
  addedAt: number
}

/**
 * A failed image-descriptor vision-model call that needs a user decision.
 * Surfaced by the renderer so the user can change the model, retry, or send
 * whatever partial output exists to the text-only model.
 */
export interface ImageDescriptorErrorRequest {
  id: string
  sessionId: string
  projectId: string
  /** Thread whose image tool call is blocked (worker thread for delegated work). */
  threadId: string
  /** User-facing thread where the decision card must be shown. */
  surfaceThreadId: string
  /** Assignment task identity shown when a worker owns the blocked call. */
  assignmentTaskId?: string
  assignmentTaskTitle?: string
  workerTitle?: string
  /** The actual error reported by the vision model / harness session. */
  error: string
  /** Provider-neutral failure category used to explain network/upload failures clearly. */
  kind: AgentProviderIssueKind
  /** Vision model that produced the failure. */
  selection?: AgentModelSelection
  /** Model that was executing the turn and was assumed to lack vision, when known. */
  requestingModel?: ModelIdentity
  /** Partial description generated before the failure, if any. */
  partialOutput: string
  /** Number of images that failed in this descriptor call. */
  imageCount: number
  /** Id of the specific image that failed, when the failure is per image.
   *  Used to attach a replacement image picked by the user on the card. */
  imageId?: string
  /** When the failure was surfaced. */
  createdAt: number
}

/** A file attached to an outgoing prompt. */
export interface PromptAttachment {
  mime: string
  url: string
  filename?: string
}

/** A selected assistant-response excerpt attached to a composer. */
export interface PromptReference {
  id: string
  label: string
  text: string
  /** Optional user comment attached to the selected excerpt. */
  comment?: string
}

/** A project-relative file or directory visibly attached to an outgoing prompt. */
export interface PromptProjectReference {
  id: string
  name: string
  path: string
  kind: ProjectFileEntry['kind']
}

/** An Assignment task visibly tagged in a composer prompt. */
export interface PromptAssignmentTaskReference {
  assignmentId: string
  taskId: string
  phaseId: string
  title: string
  description: string
  status: AssignmentTaskStatus
  workerName?: string
  threadId?: string
}

/** Project context shown in the composer before the first message of a thread. */
export interface ComposerProject {
  name: string
  path?: string
  source: 'local' | 'ssh'
  host?: string
  iconUrl?: string | null
  branch?: string
}

export type HarnessCommandSource = 'command' | 'mcp' | 'skill'

/** A raw slash command definition reported by a harness driver. */
export interface HarnessCommand {
  name: string
  description?: string
  source?: HarnessCommandSource
}

/** A slash command scoped to one active harness and safe to expose over IPC. */
export interface ScopedHarnessCommand extends HarnessCommand {
  /** Stable action identity across repeated discovery calls. */
  id: string
  /** Harness that owns and can execute this command. */
  harnessId: string
  source: HarnessCommandSource
}

export type AgentToolSource = 'application' | 'harness'

/** One effective tool definition with a stable reference and wire metadata. */
export interface AgentToolDefinition {
  /** Stable name users and CodeInOven prompts can use to refer to the tool. */
  name: string
  /** Harness-controlled name placed on the provider wire, when different. */
  transportName?: string
  description: string
  inputSchema: Record<string, unknown>
  source: AgentToolSource
  harnessId: string
  sentWhen: string
}

/** App-owned tool definition before it is projected onto the live harness registry. */
export type ApplicationAgentToolDefinition = Omit<AgentToolDefinition, 'harnessId' | 'source'> & {
  source: 'application'
}

export type AgentToolHarnessStatus = 'available' | 'unsupported' | 'unavailable'

/** Tool-discovery state for one registered agent harness. */
export interface AgentToolHarness {
  id: string
  name: string
  status: AgentToolHarnessStatus
  toolCount: number
  providerId?: string
  modelId?: string
  detail?: string
}

/** Context and exact definitions used to audit an agent's available tools. */
export interface AgentToolCatalog {
  context: {
    projectId?: string
    harnessId?: string
    providerId?: string
    modelId?: string
  }
  tools: AgentToolDefinition[]
  harnesses: AgentToolHarness[]
  notices: string[]
}
