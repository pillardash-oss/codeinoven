// ─── Project ────────────────────────────────────────────────────────────────

/** Fixed id of the hidden project that holds standalone (project-less) chats. */
export const INBOX_PROJECT_ID = 'inbox'

export type ChangeTrackingMode = 'git' | 'manual'

export type RepositoryStatus = 'git' | 'not_git' | 'git_unavailable'

export interface RepositoryPreflightResult {
  status: RepositoryStatus
  projectPath: string
  repositoryRoot?: string
  detail?: string
}

export interface Project {
  id: string
  name: string
  path: string
  source: 'local' | 'ssh'
  host?: string
  providerId: string
  workflowId: string
  threadLimit: number
  /** Hidden projects (e.g. the inbox) are excluded from the Projects tab. */
  hidden?: boolean
  /** Whether the project is pinned to the top of the project list. */
  pinned?: boolean
  /** Position for manual drag-to-reorder; items without sortOrder fall back to updatedAt. */
  sortOrder?: number
  /** Filename of the project's stored icon (e.g. `icon.png`), relative to its storage dir. */
  icon?: string
  /** Accent colour for the project (a hex colour from the project palette). */
  color?: string
  /** Key of the selected SVG icon type (e.g. 'folder', 'code', 'terminal'). */
  iconType?: string
  /** Optional while loading projects persisted before change tracking was introduced. */
  changeTrackingMode?: ChangeTrackingMode
  /** Whether the repo is known to have GitHub deployments; gates the Deployments tab. */
  hasDeployments?: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateProjectInput {
  name: string
  path: string
  source?: 'local' | 'ssh'
  host?: string
  providerId?: string
  workflowId?: string
  threadLimit?: number
  hidden?: boolean
  color?: string
  iconType?: string
  changeTrackingMode?: ChangeTrackingMode
  hasDeployments?: boolean
}

/** Destination identity for restart-safe composer attachment files. */
export interface AttachmentStorageScope {
  kind: 'project' | 'chat'
  projectId: string
  threadId: string
}

// ─── Scope board ─────────────────────────────────────────────────────────────

export const DEFAULT_SCOPE_BUCKET_ID = 'default'

export type ScopeSlice = 'todo' | 'working' | 'issue' | 'unread' | 'done' | 'pinned'

export interface ScopeBucket {
  id: string
  name: string
  /** Optional accent colour from the shared appearance palette. */
  color?: string
  /** Optional key from the shared SVG icon registry. */
  iconType?: string
  sortOrder: number
  collapsed: boolean
  collapsedSlices: ScopeSlice[]
}

export interface ScopeBoard {
  version: 1
  buckets: ScopeBucket[]
}

export interface ProjectFileEntry {
  name: string
  path: string
  kind: 'directory' | 'file'
  size?: number
  modifiedAt?: number
}

export interface ProjectFileInfo extends ProjectFileEntry {
  absolutePath: string
  createdAt: number
  mode: number
}

export type ProjectFileTransferMode = 'copy' | 'move'

export interface ProjectTextFile {
  path: string
  content: string
  size: number
  modifiedAt: number
  revision: string
}

// ─── Thread ─────────────────────────────────────────────────────────────────

/** Placeholder title for threads that have not been auto-titled yet. */
export const DEFAULT_THREAD_TITLE = 'New Thread'

export type ThreadStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'interrupted'
  | 'completed'
  | 'failed'

export function scopeSliceForStatus(status: ThreadStatus): ScopeSlice {
  switch (status) {
    case 'created':
      return 'todo'
    case 'planning':
    case 'executing':
    case 'awaiting_approval':
      return 'working'
    case 'interrupted':
      return 'done'
    case 'failed':
      return 'issue'
    case 'completed':
      return 'done'
  }
}

export type ThreadTitleSource = 'default' | 'auto' | 'manual'

export interface Thread {
  id: string
  projectId: string
  providerId: string
  title: string
  /** How the title was set; guards against overwriting manual renames. */
  titleSource: ThreadTitleSource
  status: ThreadStatus
  pinned: boolean
  /** Timestamp (ms) when the thread was pinned; pins are ordered newest-first by this. */
  pinnedAt?: number
  /** Position for manual drag-to-reorder; items without sortOrder fall back to lastActivity. */
  sortOrder?: number
  /** Position within its current scope bucket and slice; independent of project ordering. */
  scopeSortOrder?: number
  archived: boolean
  /** Whether the user has viewed this thread since its last activity. */
  read: boolean
  /** Git branch associated with this thread, when known. */
  branch?: string
  /** Stable agent-work directory name shared by forks of the same feature. */
  featureSlug?: string
  /** User-defined feature bucket used by the project's Scope board. */
  scopeBucketId?: string
  /** Per-thread agent configuration (harness, model, thinking, permissions). */
  settings?: ThreadSettings
  /** Distinct agent harnesses used across this thread's session, newest first. */
  usedHarnessIds?: string[]
  /** Last-known context/token usage snapshot, for instant meter restore. */
  contextUsage?: ThreadContextUsage
  /** Harness session id bound to this thread, once a conversation has started. */
  sessionId?: string
  /** Last specification card explicitly dismissed by the user. */
  dismissedSpecId?: string
  dismissedSpecVersion?: number
  /** Audit gate for the latest implementation turn. */
  auditState?: 'offered' | 'running' | 'report_ready' | 'reworking'
  /** Persisted count of completed Achievement audit cycles. */
  loopIteration?: number
  /** Latest persisted audit report surfaced by the thread. */
  activeAuditId?: string
  activeAuditVersion?: number
  /** Assignment workflow that owns this thread, when it is a coordinator or worker. */
  assignmentId?: string
  /** Role used to scope Assignment orchestration capabilities. */
  assignmentRole?: 'coordinator' | 'worker'
  /** Stable Assignment task identity for a worker or Sr. Engineer turn. */
  assignmentTaskId?: string
  /** Coordinator thread for a durable Assignment worker. */
  coordinatorThreadId?: string
  /** Durable Achievement role when the workflow does not use an Assignment graph. */
  achievementRole?: 'coordinator' | 'auditor'
  /** Durable Auditor owned by this Achievement coordinator. */
  auditorThreadId?: string
  /** Reject renderer-originated prompts while permitting internal orchestration turns. */
  userInputLocked?: boolean

  createdAt: number
  updatedAt: number
  lastActivity: number
  workingDirectory: string
}

/**
 * A worker or auditor thread owned by an Achievement/Assignment coordinator
 * (the Sr. Engineer). These threads are orchestration internals: they never
 * notify on their own, are hidden from the regular projects/threads surfaces,
 * and surface only inside their scoped container (scope board) and the
 * coordinator panels. The coordinator thread itself is always a normal,
 * user-facing thread and never matches this predicate.
 */
export function isOrchestrationChildThread(thread: Thread): boolean {
  if (thread.achievementRole === 'coordinator' || thread.assignmentRole === 'coordinator') {
    return false
  }
  return (
    thread.achievementRole === 'auditor' ||
    thread.assignmentRole === 'worker' ||
    thread.assignmentId !== undefined ||
    thread.coordinatorThreadId !== undefined
  )
}

/** A harness is actively producing work for this persisted thread. */
export function isThreadWorking(thread: Thread): boolean {
  return thread.status === 'planning' || thread.status === 'executing'
}

/**
 * The Sr. Engineer is the public source of truth for delegated work. Its row
 * remains active while any owned worker/auditor is active, even though the
 * coordinator's own harness turn is intentionally idle between handoffs.
 */
export function coordinatorHasActiveDelegates(
  coordinator: Thread,
  threads: readonly Thread[]
): boolean {
  if (
    coordinator.assignmentRole !== 'coordinator' &&
    coordinator.achievementRole !== 'coordinator'
  ) {
    return false
  }
  if (coordinator.auditState === 'running') return true
  return threads.some(
    (candidate) =>
      candidate.id !== coordinator.id &&
      isThreadWorking(candidate) &&
      (candidate.coordinatorThreadId === coordinator.id ||
        coordinator.auditorThreadId === candidate.id ||
        (coordinator.assignmentId !== undefined &&
          candidate.assignmentId === coordinator.assignmentId &&
          isOrchestrationChildThread(candidate)))
  )
}

export interface CreateThreadInput {
  projectId: string
  providerId: string
  title: string
  workingDirectory?: string
  settings?: ThreadSettings
  titleSource?: ThreadTitleSource
  featureSlug?: string
  scopeBucketId?: string
  assignmentId?: string
  assignmentRole?: Thread['assignmentRole']
  assignmentTaskId?: string
  coordinatorThreadId?: string
  achievementRole?: Thread['achievementRole']
  auditorThreadId?: string
  userInputLocked?: boolean
}

// ─── Thread search ───────────────────────────────────────────────────────────

/** Where a thread search match was found. */
export type ThreadSearchMatchKind = 'title' | 'message'

/** One thread surfaced by full-text search, with the strongest match context. */
export interface ThreadSearchResult {
  thread: Thread
  kind: ThreadSearchMatchKind
  /** Role of the best matching message, present for message matches. */
  role?: 'user' | 'assistant'
  /** Excerpt of the matching conversation content around the match. */
  snippet?: string
  /** Timestamp of the best matching message. */
  timestamp?: number
}

// ─── History ────────────────────────────────────────────────────────────────

export type HistoryRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
}

export interface HistoryEntry {
  id: string
  role: HistoryRole
  content: string
  metadata?: {
    toolCalls?: ToolCall[]
    fileRefs?: string[]
    checkpointId?: string
  }
  timestamp: number
}

// ─── Context ────────────────────────────────────────────────────────────────

export interface ContextConfig {
  systemPrompt: string
  projectNotes: string
  includedSkills: string[]
  includedMCPs: string[]
  excludedHistoryEntries: string[]
  checkpointId?: string
  annotations: string[]
}

export interface ContextOutput {
  messages: Array<{ role: string; content: string }>
  metadata: { tokenCount: number; sources: string[] }
}

// ─── Plan & Checklist ───────────────────────────────────────────────────────

export interface Plan {
  threadId: string
  content: string
  approved: boolean
  createdAt: number
  approvedAt?: number
}

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'complete' | 'failed'

export interface ChecklistItem {
  id: string
  content: string
  status: ChecklistItemStatus
  threadId: string
  evidence?: string
  notes: string
}

export interface Checklist {
  threadId: string
  items: ChecklistItem[]
  immutable: boolean
  createdAt: number
}

// ─── Provider ───────────────────────────────────────────────────────────────

export type ProviderType = 'cli' | 'api' | 'hybrid'

/** Live connection state of a provider harness on this machine. */
export type ProviderConnectionStatus = 'idle' | 'checking' | 'available' | 'not_found' | 'error'

export interface ProviderConnectionInfo {
  id: string
  name: string
  command: string
  /** Whether CodeInOven currently has a working HarnessDriver for this CLI. */
  integration: 'ready' | 'planned'
  /** Whether this harness can consume custom base-URL providers at runtime. */
  supportsCustomProviders: boolean
  status: ProviderConnectionStatus
  /** Absolute path to the resolved binary, when found. */
  resolvedPath?: string
  /** First line of `<command> --version` output, when the probe succeeds. */
  version?: string
  /** Human-readable detail for error/not_found states. */
  detail?: string
}

/** Where a confirmed harness-manifest behavior override came from. */
export type HarnessConfirmationSource = 'user' | 'runtime'

/** A confirmed behavior override layered on top of a harness's declared manifest. */
export interface ConfirmedHarnessBehavior {
  value: boolean
  source: HarnessConfirmationSource
  confirmedAt: number
}

/**
 * Per-harness view of the effective behavior for the Settings surface.
 * `declared` is the code manifest; `effective` is what the app actually uses
 * after a confirmed override (or runtime in-use validation) is applied.
 */
export interface HarnessManifestEntry {
  harnessId: string
  /** The declared (code manifest) value. */
  declared: boolean
  /** A user/runtime confirmed override when present. */
  confirmed?: ConfirmedHarnessBehavior
  /** What the app actually uses: confirmed override ?? declared. */
  effective: boolean
  /** Epoch ms the harness was last actually used, when known. */
  lastUsedAt?: number
}

export interface ProviderCapabilities {
  fileEditing: boolean
  computerUse: boolean
  multiFile: boolean
  streaming: boolean
  toolUse: boolean
  planningMode: boolean
}

export type ProviderStatus = 'connected' | 'disconnected' | 'error' | 'busy'

export interface ProviderConfig {
  id: string
  adapter: string
  config: {
    binaryPath?: string
    defaultModel?: string
    env?: Record<string, string>
    apiUrl?: string
    apiKey?: string
  }
}

export interface ProviderAccountAuthCapabilities {
  status: boolean
  loginHandoff: boolean
  logout: boolean
  accountActivation: boolean
  multipleAccounts: boolean
  /** The harness presents its own interactive provider picker in the login terminal. */
  pickerLogin: boolean
}

export interface ProviderAccountAuthEntry {
  id: string
  label: string
  method?: string
  active?: boolean
}

export interface ProviderAccountAuthStatus {
  capabilities: ProviderAccountAuthCapabilities | null
  state: 'authenticated' | 'unauthenticated' | 'unknown' | 'error' | 'unsupported'
  accounts: ProviderAccountAuthEntry[]
  detail?: string
}

export interface ProviderAccountLoginOptions {
  mode?: 'default' | 'subscription' | 'console' | 'device'
  accountHint?: string
  sso?: boolean
  /** Provider to authenticate against, for harnesses that support per-provider login. */
  providerId?: string
}

/** User-controlled terminal handoff. Main never executes this command. */
export interface ProviderAccountLoginHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
  mutatesGlobalCredentials: true
}

// ─── Harness updates ─────────────────────────────────────────────────────────

export type HarnessUpdateState = 'idle' | 'checking' | 'current' | 'update_available' | 'error'

export interface HarnessUpdateStatus {
  harnessId: string
  state: HarnessUpdateState
  /** Locally installed version reported by the harness, when known. */
  currentVersion?: string
  /** Latest published version on the harness's distribution channel. */
  latestVersion?: string
  /** Human-readable detail for error states. */
  detail?: string
  /** Epoch ms of the last completed check. */
  checkedAt: number
}

/** User-controlled update terminal handoff. Main never executes this command. */
export interface HarnessUpdateHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
}

// ─── Harness install & uninstall ───────────────────────────────────────────

/** How a harness CLI was (or can be) installed on this machine. */
export type HarnessInstallMethod = 'npm' | 'brew' | 'winget' | 'native'

/** OS-specific install/download page for a harness, resolved for the current platform. */
export interface HarnessInstallInfo {
  harnessId: string
  /** Official install/download page for the user's operating system. */
  pageUrl: string
  /** Install methods the harness officially supports on this OS. */
  methods: HarnessInstallMethod[]
  /** The install method detected for the local install (drives uninstall). */
  detectedMethod?: HarnessInstallMethod
}

/** User-controlled uninstall terminal handoff. Main never executes this command. */
export interface HarnessUninstallHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
  /** The install method the uninstall command targets. */
  method: HarnessInstallMethod
}

/** A provider a harness offers for connection, surfaced from its catalog. */
export interface OfferedProvider {
  id: string
  name: string
  /** Number of models the harness exposes for this provider (when known). */
  modelCount: number
  /** Whether credentials are already stored for this provider. */
  authenticated: boolean
  /** Human-readable hint when the provider cannot be connected from the UI. */
  detail?: string
}

// ─── Base URL providers ──────────────────────────────────────────────────────

/** A model exposed by a custom base-URL provider. */
export interface BaseUrlProviderModel {
  id: string
  /** Owning provider, used to resolve env vars and context. */
  providerId: string
  name: string
  /** Maximum tokens the model accepts in its context window. */
  contextWindow?: number
  /** Maximum tokens the model can generate in one response. */
  maxOutputTokens?: number
  /** Whether the model supports reasoning/thinking. */
  reasoning: boolean
  /** Thinking presets this model supports. When absent or empty, thinking controls are hidden. */
  thinkingPresets?: ThinkingPreset[]
  /** Default thinking level applied when this model is first selected. */
  defaultThinkingLevel?: ThinkingLevel
  /** Whether the model can see images. Unspecified is treated as vision-capable
   *  so a custom model is never wrongly hidden or gated. */
  vision?: boolean
}

/** A custom provider defined by base URL, stored and vaulted by CodeInOven. */
export interface BaseUrlProvider {
  id: string
  /** Harness this provider applies to (e.g. 'opencode'). */
  harnessId: string
  /** AI SDK npm package to use (e.g. '@ai-sdk/openai-compatible', '@ai-sdk/openai', or '@ai-sdk/anthropic'). */
  npm: string
  /** Display name shown in the model picker. */
  name: string
  /** API endpoint URL. */
  baseURL: string
  /** Opaque SecretVault reference for the API key, when set. */
  apiKeyRef?: string
  /** Deterministic environment variable name that carries the resolved API key. */
  apiKeyEnvVar?: string
  /** Whether a harness-native provider has an API key configured, without exposing its value. */
  apiKeyConfigured?: boolean
  /** Custom HTTP headers sent with each request. */
  headers?: Record<string, string>
  /** Models this provider exposes. */
  models: BaseUrlProviderModel[]
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Renderer-safe create request. Plaintext API key is vaulted by main before persistence. */
export interface BaseUrlProviderCreateRequest {
  harnessId: string
  npm: string
  name: string
  baseURL: string
  /** Plaintext API key; vaulted by main. Omit when the provider needs no key. */
  apiKey?: string
  headers?: Record<string, string>
  models: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  enabled?: boolean
}

/** Renderer-safe update request. Omitted API key retains the current value. */
export interface BaseUrlProviderUpdateRequest {
  npm?: string
  name?: string
  baseURL?: string
  /** Plaintext API key; vaulted by main. Omit to keep the existing key. */
  apiKey?: string
  /** When true, removes the stored API key reference. */
  removeApiKey?: boolean
  headers?: Record<string, string>
  models?: Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>
  enabled?: boolean
}

/** Draft-shaped provider payload used to copy a custom provider to the clipboard.
 *  The API key is resolved from the vault in main when an existing `id` is given. */
export interface BaseUrlProviderCopyClipboardRequest {
  harnessId: string
  /** Existing provider id; main resolves the stored key when `apiKey` is empty. */
  id?: string
  npm: string
  name: string
  baseURL: string
  apiKey?: string
  headers?: string
  models: Array<{
    id: string
    name: string
    contextWindow: string
    maxOutputTokens: string
    reasoning: boolean
    defaultThinkingLevel: ThinkingLevel | ''
  }>
  enabled: boolean
}

export type CuaPermissionStatus = 'granted' | 'missing' | 'unknown' | 'not_required'
export type CuaInstallationSource =
  'environment' | 'application' | 'canonical' | 'homebrew' | 'path'

export interface CuaInstallation {
  path: string
  realPath: string
  aliases: string[]
  source: CuaInstallationSource
  version?: string
  compatible: boolean
  appBundle: boolean
  selected: boolean
}

/** Renderer-safe state for the optional, externally installed Cua Driver bridge. */
export interface CuaBridgeStatus {
  enabled: boolean
  installed: boolean
  compatible: boolean
  ready: boolean
  mcpAvailable: boolean
  daemonRunning: boolean
  targetVersion: string
  supportedVersionRange: string
  architecture: 'arm64' | 'x64' | 'unsupported'
  downloadLabel: string
  downloadName?: string
  version?: string
  binaryPath?: string
  updateCommand?: string
  installations: CuaInstallation[]
  platform: 'macos' | 'windows' | 'linux' | 'unsupported'
  permissionStatus: CuaPermissionStatus
  installUrl: string
  documentationUrl: string
  updateUrl: string
  permissionsUrl: string
  repositoryUrl: string
  detail?: string
}

/** One rendered frame of the app an agent is driving, pushed to the renderer. */
export interface ComputerUsePipFrame {
  pid: number
  appName: string
  windowId: number
  dataUrl: string
  width: number
  height: number
  timestamp: number
}

/** Live state of the computer-use PiP monitor. */
export interface ComputerUsePipState {
  active: boolean
  pid?: number
  appName?: string
  /** Id of the thread whose agent is driving the tracked app, when active. */
  threadId?: string
}

export interface SessionConfig {
  command: string
  args: string[]
  projectPath: string
  env?: Record<string, string>
}

export interface AdapterSession {
  id: string
  providerId: string
  status: ProviderStatus
  createdAt: number
}

// ─── Agent / Harness integration ───────────────────────────────────────────

/** A single thinking preset a model can expose, with a unique id and human label. */
export interface ThinkingPreset {
  id: string
  label: string
  description?: string
}

/** Provider-normalized reasoning effort forwarded to the selected harness. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/**
 * Inference speed contract for a turn. `fast` requests the harness's
 * speed-prioritizing tier under the hood — for opencode that is a `*-fast`
 * model id, for codex a `service_tier = "fast"` config override. Only models
 * the harness catalog marks fast-capable expose the choice. Defaults to `normal`.
 */
export type InferenceMode = 'normal' | 'fast'

/** How tool-call permissions are handled for a thread. */
export type PermissionLevel = 'auto_review' | 'full_access'

/** Harness/provider/model identity used for a secondary agent role. */
export interface AgentModelSelection {
  harnessId: string
  providerId: string
  modelId: string
}

export type AgentRole = 'seniorEngineer' | 'worker' | 'auditor'

/** Optional global model defaults for Engineering's distinct agent roles. */
export interface AgentDefaultsConfig {
  seniorEngineer?: AgentModelSelection
  worker?: AgentModelSelection
  auditor?: AgentModelSelection
  /** Vision model used to describe images for text-only models. */
  imageDescriptor?: AgentModelSelection
  /** When enabled, role changes made inside a thread replace the matching global default. */
  syncFromThreadChanges: boolean
}

/** Per-thread agent configuration. The last-used settings seed new threads. */
export interface ThreadSettings {
  /** Agent harness responsible for the session, e.g. opencode or codex. */
  harnessId: string
  /** Model provider exposed by the harness, e.g. anthropic or openai. */
  providerId: string
  modelId: string
  /** Use only the immediate deterministic fallback title, skipping auxiliary model calls. */
  titleMode?: 'model' | 'deterministic'
  thinkingLevel: ThinkingLevel
  /** Fast inference for this thread's turns; `fast` requests the harness fast tier. */
  inferenceMode?: InferenceMode
  permissionLevel: PermissionLevel
  /** When true (default), the engineering spec/plan workflow is injected into prompts. */
  engineeringMode: boolean
  /** Optional multi-agent planning workflow layered on Engineering mode. */
  assignmentMode?: boolean
  /** Enable Achievement's automatic implementation-audit correction cycle. */
  loopMode?: boolean
  /** Chat-only: grant the thread file-operation tools. Off by default — plain chats are web-only. */
  fileSystemMode?: boolean
  /** Independent model selected for Achievement audits. */
  loopAuditor?: AgentModelSelection
  /** Vision model used to describe images for this thread's text-only model. */
  imageDescriptor?: AgentModelSelection
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
  /** Explicit discovery state when a harness cannot report account-selectable models. */
  catalogStatus?: 'available' | 'unavailable'
  /** Operator-facing reason for an unavailable authoritative catalog. */
  catalogMessage?: string
}

/** Reply to a tool permission request. */
export type PermissionReply = 'once' | 'always' | 'reject'

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
export type ImageDescriptorReplyAction = 'retry' | 'ignore'

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
  /** Partial description generated before the failure, if any. */
  partialOutput: string
  /** Number of images that failed in this descriptor call. */
  imageCount: number
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

// ─── Utility registry ────────────────────────────────────────────────────────

/** Additional capabilities CodeInOven can expose when a harness lacks them. */
export type UtilityKind =
  'mcp' | 'skill' | 'web_search' | 'web_fetch' | 'computer_use' | 'provider' | 'image_descriptor'

/** Every `UtilityKind` as a runtime array — single source for schema enums and validation sets. */
export const UTILITY_KIND_VALUES: readonly UtilityKind[] = [
  'mcp',
  'skill',
  'web_search',
  'web_fetch',
  'computer_use',
  'provider',
  'image_descriptor'
]

export type UtilityActivation = 'on_demand' | 'always'

/** Scope at which a utility is eligible for resolution. */
export type UtilityScope =
  | { level: 'global' }
  | { level: 'project'; projectId: string }
  | { level: 'thread'; projectId: string; threadId: string }

/** Secret material stays in a main-process vault; registry records hold references only. */
export interface UtilityCredentialMetadata {
  id: string
  label: string
  secretRef: string
  required: boolean
  environmentVariable?: string
}

export interface McpUtilityConfig {
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  environment?: Record<string, string>
  /** Remote headers should reference vault-backed env vars with `{env:NAME}`. */
  headers?: Record<string, string>
}

export interface SkillUtilityConfig {
  instructions: string
  supportingFiles?: string[]
}

/** Web search/fetch backend the app knows how to translate the normalized tool contract to. */
export type WebToolProviderId = 'exa' | 'firecrawl' | 'brave' | 'custom'

export interface WebUtilityConfig {
  /** Built-in adapter used to translate the normalized tool contract; custom passes input through. */
  provider?: WebToolProviderId
  endpoint?: string
  headers?: Record<string, string>
}

export interface ComputerUseUtilityConfig {
  backend: string
  endpoint?: string
}

export interface ProviderUtilityConfig {
  providerId: string
  endpoint?: string
  defaultModel?: string
}

/** Vision model (from the harness catalog) used to describe images for text-only models. */
export interface ImageDescriptorUtilityConfig {
  /** Harness whose catalog exposes the vision model (e.g. 'opencode'). */
  harnessId: string
  /** Provider id that exposes the vision model. */
  providerId: string
  /** Model id that can see images (`attachment: true`). */
  modelId: string
}

export interface UtilityConfigMap {
  mcp: McpUtilityConfig
  skill: SkillUtilityConfig
  web_search: WebUtilityConfig
  web_fetch: WebUtilityConfig
  computer_use: ComputerUseUtilityConfig
  provider: ProviderUtilityConfig
  image_descriptor: ImageDescriptorUtilityConfig
}

/** How one harness receives a resolved utility without writing into the project. */
export interface HarnessUtilityBinding {
  harnessId: string
  strategy: 'native' | 'mcp' | 'skill' | 'environment' | 'provider'
  /** Harness-native capability that makes this binding unnecessary when already present. */
  nativeCapability?: string
  transportName?: string
  options?: Record<string, unknown>
}

export interface UtilityDefinitionFor<Kind extends UtilityKind = UtilityKind> {
  id: string
  kind: Kind
  name: string
  description: string
  enabled: boolean
  activation: UtilityActivation
  scope: UtilityScope
  config: UtilityConfigMap[Kind]
  credentials: UtilityCredentialMetadata[]
  harnessBindings: HarnessUtilityBinding[]
  createdAt: number
  updatedAt: number
}

export type UtilityDefinition = {
  [Kind in UtilityKind]: UtilityDefinitionFor<Kind>
}[UtilityKind]

export interface UtilityDefinitionInput<Kind extends UtilityKind = UtilityKind> {
  kind: Kind
  name: string
  description: string
  enabled?: boolean
  activation?: UtilityActivation
  scope: UtilityScope
  config: UtilityConfigMap[Kind]
  credentials?: UtilityCredentialMetadata[]
  harnessBindings?: HarnessUtilityBinding[]
}

export interface UtilityDefinitionPatch {
  name?: string
  description?: string
  enabled?: boolean
  activation?: UtilityActivation
  scope?: UtilityScope
  config?: UtilityConfigMap[UtilityKind]
  credentials?: UtilityCredentialMetadata[]
  harnessBindings?: HarnessUtilityBinding[]
}

/** Secret value is accepted only as transient IPC input and is never returned. */
export interface UtilityCredentialInput {
  id: string
  label: string
  value: string
  required: boolean
  environmentVariable?: string
}

/** One utility and its transient secrets in a user-selected bundle manifest. */
export interface UtilityBundleEntryInput {
  definition: UtilityDefinitionInput
  credentials?: UtilityCredentialInput[]
}

/** Atomic install request used by guided templates and imported JSON manifests. */
export interface UtilityBundleInstallRequest {
  name: string
  utilities: UtilityBundleEntryInput[]
}

export interface UtilityCatalog {
  utilities: UtilityDefinition[]
  secureStorageAvailable: boolean
}

// ─── Harness-native capability discovery ───────────────────────────────────

/** Where a discovered MCP server or skill came from. */
export type AgentCapabilityOrigin = 'application' | 'global' | 'harness'

/** Locator that lets the app read, edit, and delete a discovered capability. */
export type AgentCapabilitySource =
  | { kind: 'registry'; utilityId: string }
  | { kind: 'skill'; path: string }
  | {
      kind: 'mcp'
      configPath: string
      format: 'opencode' | 'mcpServers' | 'codex-toml'
      serverName: string
    }

/** One harness-native or app-managed MCP server or skill surfaced to the user. */
export interface AgentCapabilityEntry {
  id: string
  name: string
  kind: 'mcp' | 'skill'
  origin: AgentCapabilityOrigin
  enabled: boolean
  description?: string
  /** Transport + command/URL for MCP servers, or the skill's folder path. */
  detail?: string
  source: AgentCapabilitySource
}

/** MCP servers and skills actually available to one project's active harness. */
export interface AgentContextCapabilities {
  harnessId: string
  harnessName: string
  mcp: AgentCapabilityEntry[]
  skill: AgentCapabilityEntry[]
}

/** Full editable representation of a harness-native skill. */
export interface NativeSkillContent {
  name: string
  description: string
  instructions: string
  path: string
}

/** Full editable representation of a harness-native MCP server. */
export interface NativeMcpContent {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  environment?: Record<string, string>
  headers?: Record<string, string>
  enabled: boolean
  configPath: string
}

/** Result of mutating a harness-native capability. */
export type NativeCapabilityResult = { deleted: true } | { deleted: false }

export interface UtilitySearchOptions {
  query?: string
  kinds?: UtilityKind[]
  enabled?: boolean
  scope?: UtilityScope
}

export interface UtilityResolutionContext {
  harnessId: string
  projectId?: string
  threadId?: string
  /** Current task text used for deterministic on-demand matching. */
  query?: string
  /** Normalized capability names reported by the selected harness. */
  nativeCapabilities?: string[]
  /** Include eligible on-demand utilities in addition to always-on utilities. */
  includeOnDemand?: boolean
}

export interface ResolvedUtility {
  utility: UtilityDefinition
  binding: HarnessUtilityBinding
}

// ─── Agent message parts (harness wire format) ─────────────────────────────

export type AgentToolStatus = 'pending' | 'running' | 'completed' | 'error'

/** State of a tool invocation as reported by the harness. */
export interface AgentToolState {
  status: AgentToolStatus
  input: Record<string, unknown>
  title?: string
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  time?: { start: number; end?: number }
}

/** A live operating-system process started beneath one task's agent harness. */
export interface AgentRunningProcess {
  pid: number
  parentPid: number
  command: string
  startedAt: number
}

/** Provider-neutral lifecycle state for one delegated child-agent task. */
export interface AgentSubagentActivity {
  status: AgentToolStatus
  agent: string
  description: string
  prompt?: string
  childSessionId?: string
  providerTaskId?: string
  providerId?: string
  modelId?: string
  background: boolean
  output?: string
  error?: string
  time?: { start: number; end?: number }
}

/** User-facing copy for a turn whose full text is an internal agent instruction. */
export interface UserMessagePresentation {
  action: string
  body?: string
}

/** Durable source identity for a persisted conversation record. */
export type AgentMessageOrigin =
  | 'user'
  | 'assistant'
  | 'harness'
  | 'orchestrator'
  | 'subagent'
  | 'compaction'
  | 'provider'
  | 'legacy'

/** Durable UI channel for a persisted conversation record. */
export type AgentMessageVisibility = 'conversation' | 'working_trace' | 'subagent_trace' | 'hidden'

/** Provider-normalized token accounting for one assistant turn or step. */
export interface AgentTokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Sum of all token categories as accounted for by the provider. */
  total: number
}

/** Model or utility operation responsible for one persisted usage event. */
export type UsageEventFeature =
  'main' | 'title' | 'memory' | 'image_descriptor' | 'computer_use' | 'web' | 'audit' | 'assignment'

/** Whether and how a provider-reported total can be interpreted. */
export type UsageTotalSemantics =
  | 'includes_cache'
  | 'excludes_cache'
  | 'categories_may_overlap'
  | 'provider_defined'
  | 'unavailable'

/** Source used to calculate or verify an event's monetary cost. */
export interface UsagePricingProvenance {
  source: 'provider' | 'model_catalog' | 'utility_catalog' | 'manual'
  sourceId?: string
  currency: 'USD'
  capturedAt: number
}

/** Provider-neutral token categories. Null means the provider did not report the category. */
export interface NormalizedUsageTokens {
  uncachedInput: number | null
  cachedInput: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
}

/** Canonical provider-neutral usage attached to messages and usage events. */
export interface NormalizedUsage extends NormalizedUsageTokens {
  rawProviderUsage: Record<string, unknown>
  rawTotal: number | null
  totalSemantics: UsageTotalSemantics
}

/** Cost fields preserve the difference between a true zero and missing pricing data. */
export type UsageEventCost =
  | {
      costStatus: 'known' | 'estimated'
      costUsd: number
      pricingProvenance: UsagePricingProvenance
    }
  | {
      costStatus: 'unavailable'
      costUsd: null
      pricingProvenance: null
    }

/** Stable identity and measurements for one model or utility usage attempt. */
export interface UsageEventDetails {
  id: string
  threadId: string
  parentTurnId: string
  /** Stable caller-provided identity that separates multiple calls of the same feature. */
  featureCallId: string
  attempt: number
  feature: UsageEventFeature
  harnessId: string | null
  providerId: string | null
  modelId: string | null
  utilityId: string | null
  rawProviderUsage: Record<string, unknown>
  tokens: NormalizedUsageTokens
  rawTotal: number | null
  totalSemantics: UsageTotalSemantics
  toolFeeUsd: number | null
  success: boolean
  retryCause: string | null
  createdAt: number
}

/** Durable, replay-safe accounting record for one attempt. */
export type UsageEvent = UsageEventDetails & UsageEventCost

/** One main-agent cache measurement grouped by its telemetry provenance. */
export interface UsageCacheHitBreakdown {
  harnessId: string | null
  providerId: string | null
  modelId: string | null
  mainAttempts: number
  reportedAttempts: number
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheHitRatio: number | null
}

/** Provider-neutral efficiency metrics derived only from normalized usage events. */
export interface UsageEfficiencyKpis {
  successfulTurns: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  /** Main-agent cache hit ratio; auxiliary model and utility calls are excluded. */
  cacheHitRatio: number | null
  cacheEligibleEvents: number
  cacheReportedEvents: number
  cacheCoverageRatio: number | null
  cacheBreakdown: UsageCacheHitBreakdown[]
  auxiliaryUncachedInputTokens: number
  auxiliaryCachedInputTokens: number
  auxiliaryCacheHitRatio: number | null
  mainAttempts: number
  retryAmplification: number | null
  auxiliaryCostUsd: number
  totalPricedCostUsd: number
  auxiliaryCostShare: number | null
  toolResultTokens: number
  knownCostUsd: number
  estimatedCostUsd: number
  unavailableCostEvents: number
  pricedCostEvents: number
  totalCostEvents: number
  costCoverageRatio: number | null
  perSuccessfulTurn: {
    uncachedInputTokens: number | null
    outputAndReasoningTokens: number | null
    toolResultTokens: number | null
  }
}

/** Optional account quota telemetry exposed by a provider. */
export interface AgentRateLimitWindow {
  id: string
  label: string
  /** Provider-reported access state, such as `allowed` or `rejected`. */
  status?: string
  usedPercent?: number
  remaining?: number
  limit?: number
  resetsAt?: number
  /** Rolling window length in minutes (e.g. 300 for the Codex 5-hour limit). */
  windowMinutes?: number
  /** Model the window applies to, when the provider splits limits per model. */
  model?: string
  overageStatus?: string
  overageDisabledReason?: string
  isUsingOverage?: boolean
}

/** Prepaid-credit balance reported alongside quota windows (e.g. Codex credits). */
export interface AgentUsageCredits {
  /** Remaining balance in the provider's credit currency, when metered. */
  balance?: number
  /** True when the account is metered by prepaid credits rather than a plan. */
  hasCredits?: boolean
  /** True when the account reports an unlimited cap. */
  unlimited?: boolean
  /** Provider plan identifier, such as `prolite` for Codex. */
  planType?: string
}

/** Display-ready provider-neutral usage for the active conversation. */
export interface AgentContextUsage {
  contextWindow?: number
  contextUsed: number
  contextPercent?: number
  costUsd: number
  tokens: AgentTokenUsage
  rateLimits: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported alongside quota windows. */
  credits?: AgentUsageCredits
}

/** Per-harness quota telemetry for threads that used more than one harness. */
export interface AgentHarnessUsage {
  harnessId: string
  providerId: string
  modelId?: string
  /** Total USD this harness consumed on the thread, when the harness reports cost. */
  costUsd: number
  /** Latest quota windows reported by this harness on the thread. */
  rateLimits: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported by this harness on the thread. */
  credits?: AgentUsageCredits
  /** Cumulative token accounting from the harness_usage table, when available. */
  tokens?: AgentTokenUsage
  /** Assistant messages attributed to this harness on the thread. */
  messageCount?: number
  /** Approximate cumulative wall-clock time spent in turns, ms. */
  durationMs?: number
  /** Per-model cost breakdown for this harness on the thread, when available. */
  models?: HarnessModelUsage[]
}

/** On-demand account quota snapshot for one harness used on a thread. */
export interface AgentAccountUsage {
  harnessId: string
  providerId: string
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  /** Effective model context window (tokens) for the active session, when known. */
  contextWindow?: number
  /** Tokens currently occupying the model context, when known. */
  contextUsed?: number
}

/** Last-known usage snapshot stored with a thread so the meter restores
 *  instantly on mount and is evacuated automatically when the thread row is
 *  deleted. The harness/provider pair guard against showing usage from a
 *  different agent configuration. */
export interface ThreadContextUsage extends AgentContextUsage {
  harnessId: string
  providerId: string
}

/** One row of cumulative per-harness analytics keyed by (thread, harness, provider). */
export interface HarnessUsage {
  projectId: string
  threadId: string
  harnessId: string
  providerId: string
  /** Last model observed for this harness on the thread. */
  modelId?: string
  /** Number of assistant messages attributed to this harness on the thread. */
  messageCount: number
  /** Cumulative USD cost, when the harness reports cost. */
  costUsd: number
  /** Cumulative token accounting across this harness's messages on the thread. */
  tokens: AgentTokenUsage
  /** Approximate cumulative wall-clock time spent in turns attributed to this harness, ms. */
  durationMs: number
  firstUsedAt: number
  lastUsedAt: number
  /** Per-model cost breakdown for this harness on the thread, when available. */
  models?: HarnessModelUsage[]
}

/** One row of cumulative per-model analytics keyed by (thread, harness, provider, model). */
export interface HarnessModelUsage {
  threadId: string
  harnessId: string
  providerId: string
  modelId: string
  /** Number of assistant messages attributed to this model on the thread. */
  messageCount: number
  /** Cumulative USD cost attributed to this model, when the harness reports cost. */
  costUsd: number
  /** Cumulative token accounting across this model's messages on the thread. */
  tokens: AgentTokenUsage
  /** Approximate cumulative wall-clock time spent in turns, ms. */
  durationMs: number
  firstUsedAt: number
  lastUsedAt: number
}

/** One aggregate row shown on the account profile. */
export interface AccountUsageBreakdown {
  id: string
  messageCount: number
  costUsd: number
  tokens: number
}

/** One calendar day containing completed assistant work. */
export interface AccountActivityDay {
  date: string
  messageCount: number
}

/** App-wide local usage rolled up for cloud persistence and profile display. */
export interface AccountUsageSummary {
  messageCount: number
  costUsd: number
  tokens: number
  durationMs: number
  topHarnessId: string | null
  topModelId: string | null
  harnesses: AccountUsageBreakdown[]
  models: AccountUsageBreakdown[]
  activityDays: AccountActivityDay[]
  generatedAt: number
}

/** Inclusive/exclusive local analytics window supplied by the Profile page. */
export interface LocalProfileAnalyticsRange {
  startAt: number
  endAt: number
}

/** Date-range usage row with enough identity to render harness and provider marks. */
export interface LocalProfileUsageBreakdown extends AccountUsageBreakdown {
  harnessId?: string
  providerId?: string
  durationMs: number
}

/** Date-range project activity shown on the local Profile page. */
export interface LocalProfileProjectBreakdown extends AccountUsageBreakdown {
  name: string
  color?: string
  iconType?: string
  hasCustomIcon: boolean
  durationMs: number
  threadCount: number
  activeDays: number
  lastActiveAt: number
}

/** Fully local, range-aware analytics. This is never required for account authentication. */
export interface LocalProfileAnalytics {
  range: LocalProfileAnalyticsRange
  messageCount: number
  costUsd: number
  tokens: number
  durationMs: number
  topHarnessId: string | null
  topProviderId: string | null
  topModelId: string | null
  harnesses: LocalProfileUsageBreakdown[]
  providers: LocalProfileUsageBreakdown[]
  models: LocalProfileUsageBreakdown[]
  /** Auxiliary utility calls (image descriptor, memory, title) with their cost. */
  utilities: LocalProfileUsageBreakdown[]
  projects: LocalProfileProjectBreakdown[]
  activityDays: AccountActivityDay[]
  generatedAt: number
}

/** Account identity plus the cloud-backed workstation profile data. */
export interface AccountProfile {
  id: string
  email: string
  displayName: string
  image: string | null
  usage: AccountUsageSummary
  globalMemories: MemoryEntry[]
  updatedAt: number
}

export type AccountProfileState =
  | { status: 'signed-out'; profile: null }
  | { status: 'pending'; profile: null }
  | { status: 'signed-in'; profile: AccountProfile }

export type AccountAuthProvider = 'google' | 'apple'

export interface AccountSignInStart {
  url: string
}

export interface AccountProfileSyncPayload {
  usage: AccountUsageSummary
  globalMemories: MemoryEntry[]
}

/** A selectable option within an agent question. */
export interface AgentQuestionOption {
  label: string
  description?: string
  /** Explicit provider recommendation, or inferred from a “(Recommended)” label. */
  recommended?: boolean
}

/** A structured question the agent is asking the user. */
export interface AgentQuestion {
  /** OpenCode question request id (used to submit the answer via the question API). */
  requestId?: string
  /** The question text. */
  prompt: string
  /** Very short label (max 30 chars) shown as a header. */
  header?: string
  /** Optional context or description providing background for the question. */
  description?: string
  /** Predefined answer options the user can pick from. */
  options?: string[]
  /** Predefined answer options with descriptions (richer format from OpenCode). */
  richOptions?: AgentQuestionOption[]
  /** Allow the user to select multiple options. */
  multiple?: boolean
  /** Allow the user to type a custom answer (default: true). */
  custom?: boolean
  /** The user's submitted answer text. */
  answer?: string
  /** Raw tool input payload, preserved for debugging schema drift. */
  rawInput?: string
}

/** One provider-native question request, preserving ordered question batches. */
export interface AgentQuestionRequest {
  requestId: string
  sessionId: string
  questions: AgentQuestion[]
  tool?: { messageID: string; callID: string }
}

/** Authoritative pending request metadata owned by the main process. */
export interface PendingAgentQuestionRequest extends AgentQuestionRequest {
  projectId: string
  threadId: string
  createdAt: number
  activeQuestionIndex: number
  answers: string[][]
  interactedQuestionIndexes: number[]
  expiresAt?: number
}

export type AgentQuestionResolution = 'answered' | 'dismissed' | 'timed_out'

/** A renderable piece of an agent message. */
export type AgentPart =
  | {
      type: 'text'
      id: string
      messageID: string
      text: string
      /** Codex can emit user-visible progress before its final answer. */
      phase?: 'commentary' | 'final_answer'
    }
  | {
      type: 'reasoning'
      id: string
      messageID: string
      text: string
      /** Provider-reported concise thinking summary, when available. */
      summary?: string
      time?: { start?: number; end?: number }
    }
  | {
      type: 'tool'
      id: string
      messageID: string
      callID: string
      tool: string
      state: AgentToolState
    }
  | {
      type: 'subagent'
      id: string
      messageID: string
      callID?: string
      activity: AgentSubagentActivity
    }
  | {
      type: 'file'
      id: string
      messageID: string
      mime: string
      url: string
      filename?: string
    }
  | {
      type: 'question'
      id: string
      messageID: string
      callID?: string
      question: AgentQuestion
    }
  | { type: 'step-start'; id: string; messageID: string }
  | {
      type: 'step-finish'
      id: string
      messageID: string
      reason: string
      cost?: number
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
    }
  | {
      type: 'compaction'
      id: string
      messageID: string
      auto: boolean
      overflow?: boolean
      /** Completed compaction output, attached by the presentation layer. */
      summary?: string
    }
  | {
      type: 'compaction-summary'
      id: string
      messageID: string
      text: string
    }
  | {
      type: 'user-presentation'
      id: string
      messageID: string
      presentation: UserMessagePresentation
    }

/** A message in the agent conversation. */
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  /** Who produced the display-facing record. */
  origin?: AgentMessageOrigin
  /** Which UI channel may load this record. */
  visibility?: AgentMessageVisibility
  parts: AgentPart[]
  /** Exact provider-facing payload, deliberately separate from display parts. */
  transportParts?: AgentPart[]
  /** Who assembled the provider-facing payload when it differs from `origin`. */
  transportOrigin?: AgentMessageOrigin
  /** Assistant-response excerpts visibly attached to this user message. */
  references?: PromptReference[]
  /** Project-relative files and directories visibly attached to this user message. */
  projectReferences?: PromptProjectReference[]
  modelId?: string
  providerId?: string
  /** Agent harness that produced this message, e.g. opencode or claude-code. */
  harnessId?: string
  createdAt: number
  completedAt?: number
  /** Cost and token accounting reported for this assistant message. */
  cost?: number
  /** Provenance of `cost` when it was derived from a pricing table rather than
   *  reported verbatim by the provider (kept transient; not persisted). */
  costProvenance?: UsagePricingProvenance
  tokens?: AgentTokenUsage
  /** Canonical accounting payload; raw provider evidence and semantics are preserved. */
  normalizedUsage?: NormalizedUsage
  /** Effective model context window reported by the harness, when available. */
  contextWindow?: number
  /** Cumulative tokens currently occupying the model context, when available. */
  contextUsed?: number
  /** Optional account quota windows when the provider exposes them. */
  rateLimits?: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported alongside quota windows. */
  credits?: AgentUsageCredits
  /** Present on assistant messages that ended with an error. */
  error?: string
  /** Validated JSON-schema result returned by a harness structured-output tool. */
  structuredOutput?: unknown
}

/** Stable cursor for loading messages older than the first item in a transcript page. */
export interface ThreadMessageCursor {
  createdAt: number
  id: string
}

/** One bounded page of display-facing thread history, ordered oldest to newest. */
export interface ThreadMessagePage {
  messages: AgentMessage[]
  hasOlder: boolean
  /** True when newer messages exist beyond this page (set by centered loads). */
  hasNewer?: boolean
}

/** Lightweight user-authored message summary for the header history jump list. */
export interface UserMessageSummary {
  id: string
  content: string
  createdAt: number
}

// ─── Agent streaming events (forwarded main → renderer) ────────────────────

/** Provider-neutral categories that let the UI offer an appropriate action. */
export type AgentProviderIssueKind =
  | 'rate_limit'
  | 'quota'
  | 'authentication'
  | 'billing'
  | 'provider_unavailable'
  | 'network'
  | 'unknown'

/** A structured provider or harness interruption surfaced by every driver. */
export interface AgentProviderIssue {
  kind: AgentProviderIssueKind
  message: string
  /** Original exception message for developer diagnostics; never includes the stack trace. */
  rawError?: string
  harnessId: string
  retryable: boolean
  retryAt?: number
  attempt?: number
  statusCode?: number
}

/**
 * Provider-neutral session lifecycle state.
 *
 * Drivers must emit `session.status` when a provider pauses and schedules a
 * retry so consumers never have to infer a stalled run from missing output.
 */
export type AgentSessionStatus =
  | {
      state: 'working'
      /** Authoritative start of the owning workflow, preserved across renderer reloads. */
      startedAt?: number
      /** Human-readable progress from an internal coordinator-owned worker. */
      activity?: {
        kind: 'spec_generation'
        label: string
        attempt: number
        maxAttempts: number
        updatedAt: number
      }
    }
  | { state: 'idle' }
  | { state: 'waiting'; issue: AgentProviderIssue }
  | { state: 'error'; issue: AgentProviderIssue }

export type BrainstormTraceUpdate =
  | { type: 'started'; messages: AgentMessage[] }
  | { type: 'part.updated'; messageId: string; part: AgentPart }
  | { type: 'part.delta'; messageId: string; partId: string; field: string; delta: string }
  | { type: 'completed'; messages: AgentMessage[] }

export type SpecGenerationTraceUpdate =
  | { type: 'started'; startedAt: number }
  | { type: 'part.updated'; part: AgentPart }
  | { type: 'part.delta'; partId: string; field: string; delta: string }
  | { type: 'completed' }

export type AgentEvent =
  | { type: 'message.part.updated'; sessionId: string; part: AgentPart }
  | {
      type: 'checkpoint.updated'
      sessionId: string
      projectId: string
      threadId: string
      checkpointId: string
    }
  | {
      type: 'thread.error'
      sessionId: string
      projectId: string
      threadId: string
      issue: AgentProviderIssue
    }
  | {
      type: 'message.part.delta'
      sessionId: string
      messageId: string
      partId: string
      field: string
      delta: string
    }
  | {
      type: 'message.completed'
      sessionId: string
      messageId: string
      error?: string
      issue?: AgentProviderIssue
      /** Structured result captured before a provider history read is required. */
      structuredOutput?: unknown
      /** Token accounting reported when the harness closes the turn. */
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
      /** Effective model context window reported when the harness closes the turn. */
      contextWindow?: number
      /** Cumulative tokens currently occupying the model context, when available. */
      contextUsed?: number
      /** Account quota windows reported after the harness refreshes usage. */
      rateLimits?: AgentRateLimitWindow[]
      /** Prepaid-credit balance reported alongside quota windows. */
      credits?: AgentUsageCredits
      /** The completed assistant message summarizes a compaction and is trace-only. */
      compaction?: boolean
    }
  | {
      type: 'usage.updated'
      sessionId: string
      messageId: string
      tokens?: AgentTokenUsage
      normalizedUsage?: NormalizedUsage
      contextWindow?: number
      contextUsed?: number
      cost?: number
      rateLimits?: AgentRateLimitWindow[]
      credits?: AgentUsageCredits
    }
  | { type: 'session.status'; sessionId: string; status: AgentSessionStatus }
  | { type: 'session.idle'; sessionId: string }
  | {
      type: 'session.error'
      sessionId: string
      error?: string
      issue?: AgentProviderIssue
    }
  | {
      type: 'permission.asked'
      sessionId: string
      permission: PermissionRequest
    }
  | {
      type: 'permission.replied'
      sessionId: string
      requestId: string
      reply: PermissionReply
    }
  | {
      type: 'question.asked'
      sessionId: string
      requestId: string
      questions: AgentQuestion[]
      tool?: { messageID: string; callID: string }
    }
  | {
      type: 'question.updated'
      sessionId: string
      requestId: string
    }
  | {
      type: 'question.resolved'
      sessionId: string
      requestId: string
      resolution: AgentQuestionResolution
      answers?: string[][]
    }
  | {
      type: 'brainstorm.ready'
      sessionId: string
      projectId: string
      threadId: string
      brainstormId: string
      version: number
    }
  | {
      type: 'brainstorm.trace'
      sessionId: string
      projectId: string
      threadId: string
      update: BrainstormTraceUpdate
    }
  | {
      type: 'spec.trace'
      sessionId: string
      projectId: string
      threadId: string
      update: SpecGenerationTraceUpdate
    }
  | {
      type: 'spec.ready'
      sessionId: string
      projectId: string
      threadId: string
      specId: string
      version: number
    }
  | {
      type: 'temporary-chat.started'
      sessionId: string
      temporaryChatId: string
    }
  | {
      type: 'catalog.updated'
      harnessId: string
    }
  | {
      type: 'providerCatalog.updated'
      projectId: string
      catalogs: ProviderCatalog[]
    }
  | {
      type: 'imageDescriptor.error'
      sessionId: string
      projectId: string
      threadId: string
      request: ImageDescriptorErrorRequest
    }
  | {
      type: 'imageDescriptor.resolved'
      sessionId: string
      projectId: string
      threadId: string
      requestId: string
      action: ImageDescriptorReplyAction
    }

/**
 * Agent events that are tied to a running session. Catalog events are app-level
 * and never belong to a session, so session-scoped handlers can rely on
 * `sessionId` being present.
 */
export type SessionAgentEvent = Exclude<
  AgentEvent,
  { type: 'catalog.updated' } | { type: 'providerCatalog.updated' }
>

// ─── Change Tracking ────────────────────────────────────────────────────────

export type FileChangeType = 'created' | 'modified' | 'deleted' | 'renamed'

export interface FileChange {
  path: string
  type: FileChangeType
  beforeHash: string | null
  afterHash: string | null
  beforeBlob: string | null
  afterBlob: string | null
  oldPath?: string
}

export interface ChangeSnapshot {
  id: string
  projectId: string
  threadId: string
  timestamp: number
  label: string
  files: FileChange[]
  parentId: string | null
}

export type TurnCheckpointStatus = 'active' | 'completed' | 'failed' | 'interrupted' | 'rolled_back'

export interface TurnCheckpointChangeSummary {
  path: string
  kind: 'created' | 'modified' | 'deleted'
  binary: boolean
  beforeSize?: number
  afterSize?: number
  additions?: number
  deletions?: number
  lineCountsTruncated?: boolean
}

export interface TurnCheckpointSummary {
  id: string
  projectId: string
  threadId: string
  sourceMessageId?: string
  label: string
  status: TurnCheckpointStatus
  changes: TurnCheckpointChangeSummary[]
  createdAt: number
  completedAt?: number
  rolledBackAt?: number
  rolledBackPaths?: string[]
  failure?: string
  gitHead?: string | null
}

export interface TurnCheckpointFileDiff {
  path: string
  kind: TurnCheckpointChangeSummary['kind']
  binary: boolean
  before?: string
  after?: string
  truncated: boolean
}

// ─── Brainstorm Documents ──────────────────────────────────────────────────

export type BrainstormSectionId =
  | 'context'
  | 'goals'
  | 'decisions'
  | 'open_questions'
  | 'constraints'
  | 'proposed_direction'
  | 'additional_info'

export interface BrainstormSection {
  id: BrainstormSectionId
  title: string
  markdown: string
}

export interface BrainstormContent {
  title: string
  summary: string
  sections: BrainstormSection[]
}

export type BrainstormStatus = 'draft' | 'finalized' | 'superseded'
export type BrainstormDecisionAction = 'review' | 'finalize'
export type BrainstormEntryChoice = 'brainstorm' | 'spec'
export type BrainstormWorkflowStage = 'choice_pending' | 'drafting' | 'finalized' | 'skipped'

export interface BrainstormProvenance {
  source: 'agent' | 'manual'
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  createdAt: number
}

export interface BrainstormAnnotation {
  id: string
  section: BrainstormSectionId
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export interface BrainstormDecisionComment {
  id: string
  action: BrainstormDecisionAction
  body: string
  createdAt: number
}

export interface BrainstormDocument {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  version: number
  status: BrainstormStatus
  content: BrainstormContent
  annotations: BrainstormAnnotation[]
  decisionComments: BrainstormDecisionComment[]
  provenance: BrainstormProvenance
  createdAt: number
  updatedAt: number
  finalizedAt?: number
  finalizedInputHash?: string
}

export interface BrainstormWorkflowState {
  projectId: string
  threadId: string
  entryChoice?: BrainstormEntryChoice
  stage: BrainstormWorkflowStage
  activeBrainstormId?: string
  activeBrainstormVersion?: number
  finalizedBrainstormVersion?: number
  finalizedInputHash?: string
  updatedAt: number
}

// ─── Engineering Specifications ────────────────────────────────────────────

export type EngineeringSpecStatus = 'draft' | 'in_review' | 'approved' | 'superseded'

export type SpecSectionId =
  | 'problem'
  | 'resolution'
  | 'success_criteria'
  | 'test_strategy'
  | 'documentation'
  | 'additional_info'
  | 'commit_pattern'
  | 'constraints_risks'

export type SpecProvenanceSource = 'manual' | 'agent' | 'brainstorm' | 'markdown_import'

export interface SpecProvenance {
  source: SpecProvenanceSource
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  importedFilename?: string
  brainstormId?: string
  brainstormVersion?: number
  brainstormInputHash?: string
  createdAt: number
}

export interface SpecCheckpoint {
  id: string
  description: string
  evidence: string
}

export interface SpecFileOperation {
  path: string
  operation: 'create' | 'edit' | 'delete'
  reason: string
}

export interface SpecPhase {
  id: string
  title: string
  objective: string
  checkpoints: SpecCheckpoint[]
  fileOperations: SpecFileOperation[]
  commit: string
}

export interface EngineeringSpecContent {
  problem: string
  resolutionSummary: string
  phases: SpecPhase[]
  successCriteria: string[]
  testStrategy: string
  documentationRequirements: string[]
  /** Free-form Markdown for recommendations, findings, phases, or other useful context. */
  additionalInfo?: string
  commitPattern: string
  constraints: string[]
  risks: string[]
  /** Optional multi-agent execution graph generated when Assignment mode is enabled. */
  assignment?: AssignmentPlanContent
}

export interface SpecGenerationRequest {
  mode: 'problem' | 'conversation'
  instructions: string
  settings: ThreadSettings
}

export type SpecActionIntent = 'request' | 'review' | 'implement'
export type SpecDecisionAction = Exclude<SpecActionIntent, 'request'>

export interface SpecDecisionComment {
  id: string
  action: SpecDecisionAction
  body: string
  createdAt: number
}

export interface SpecAnnotation {
  id: string
  section: SpecSectionId
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export interface AssignmentAnnotation {
  id: string
  /** overview, graph, phase:<phase-id>, or task:<task-id>. */
  section: string
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export type SpecContextType = 'project_file' | 'attachment' | 'project_rule' | 'memory'

/** Context types a user can capture from disk; memory is attached separately. */
export type CapturableSpecContextType = Exclude<SpecContextType, 'memory'>

export interface SpecContextReference {
  id: string
  type: SpecContextType
  label: string
  /** Project-relative path for repository files; never an arbitrary absolute path. */
  path?: string
  contentHash?: string
  /** Immutable inline snapshot; currently permitted only for explicit memory context. */
  content?: string
  selectedAt: number
}

export interface EngineeringSpec {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  version: number
  status: EngineeringSpecStatus
  content: EngineeringSpecContent
  annotations: SpecAnnotation[]
  /** User-confirmed validation false positives ignored for this version. */
  dismissedValidationIssues?: SpecValidationDismissal[]
  /** Append-only user comments submitted with Review or Implement for this version. */
  decisionComments: SpecDecisionComment[]
  context: SpecContextReference[]
  provenance: SpecProvenance
  createdAt: number
  updatedAt: number
  approvedAt?: number
}

export type SpecValidationCode = 'required' | 'invalid_path' | 'missing_evidence' | 'duplicate_id'

export interface SpecValidationIssue {
  code: SpecValidationCode
  section: SpecSectionId
  message: string
  path: string
}

export interface SpecValidationDismissal extends SpecValidationIssue {
  dismissedAt: number
}

export interface SpecValidationResult {
  valid: boolean
  issues: SpecValidationIssue[]
}

export type EngineeringWorkflowStage = 'spec_drafting' | 'spec_review' | 'spec_approved'

export interface EngineeringWorkflowState {
  projectId: string
  threadId: string
  stage: EngineeringWorkflowStage
  activeSpecId?: string
  activeSpecVersion?: number
  approvedSpecVersion?: number
  updatedAt: number
}

// ─── Assignment Plans ──────────────────────────────────────────────────────

export type AssignmentStatus =
  'draft' | 'approved' | 'running' | 'attention' | 'completed' | 'failed' | 'stopped'

export type AssignmentTaskStatus =
  | 'planned'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'reported'
  | 'auditing'
  | 'rework'
  | 'attention'
  | 'completed'
  | 'failed'
  | 'stopped'

export type AssignmentTaskOwner = 'senior' | 'worker'
export type AssignmentTaskWorkKind = 'initial' | 'rework'

export interface AssignmentModelSelection extends AgentModelSelection {
  thinkingLevel: ThinkingLevel
}

export interface AssignmentPhase {
  id: string
  title: string
  description: string
  info?: string
  defaultModel?: AssignmentModelSelection
}

export interface AssignmentTaskReport {
  status: 'ready_for_audit' | 'blocked' | 'failed'
  summary: string
  evidence: string[]
  commitHash?: string
  reportedAt: number
}

export interface AssignmentTaskReview {
  decision: 'pass' | 'rework' | 'fail'
  checklistResults: Array<{
    item: string
    passed: boolean
    evidence: string
  }>
  notes: string
  reviewedAt: number
}

export interface AssignmentTask {
  id: string
  phaseId: string
  title: string
  description: string
  info?: string
  prompt: string
  owner: AssignmentTaskOwner
  dependsOn: string[]
  expectedFiles: string[]
  auditChecklist: string[]
  model?: AssignmentModelSelection
  /** Durable identity of the implementation pass this task belongs to. */
  workKind?: AssignmentTaskWorkKind
  /** One-based post-audit rework cycle; absent for initial implementation. */
  reworkCycle?: number
  /** Assignment version whose implementation pass produced this task execution. */
  workAssignmentVersion?: number
  status: AssignmentTaskStatus
  statusBeforeStop?: Exclude<AssignmentTaskStatus, 'stopped'>
  workerName?: string
  threadId?: string
  report?: AssignmentTaskReport
  review?: AssignmentTaskReview
  startedAt?: number
  completedAt?: number
}

export interface AssignmentPlanContent {
  title: string
  summary: string
  phases: AssignmentPhase[]
  tasks: AssignmentTask[]
}

export type AssignmentAuditCycleStatus =
  | 'available'
  | 'running'
  | 'failed'
  | 'report_ready'
  | 'planning_rework'
  | 'awaiting_rework_approval'
  | 'reworking'
  | 'completed'
  | 'stopped'

/** Persisted hand-off between Assignment implementation and its independent audit. */
export interface AssignmentAuditCycle {
  status: AssignmentAuditCycleStatus
  /** True when the reviewable rework version repairs an unfinished Assignment's signed scope. */
  scopeRepair?: boolean
  statusBeforeStop?: Exclude<AssignmentAuditCycleStatus, 'stopped'>
  availableAt?: number
  startedAt?: number
  failedAt?: number
  failure?: string
  reportId?: string
  reportVersion?: number
  reportedAt?: number
  reworkStartedAt?: number
  /** One-based count of post-audit correction cycles. */
  reworkCycle?: number
  /** Reviewable Assignment version proposed by the Sr. Engineer for this audit report. */
  reworkAssignmentVersion?: number
  completedAt?: number
}

/** A post-audit workload appended to an approved Assignment. */
export interface AssignmentFollowUpTaskInput {
  id: string
  phaseId: string
  title: string
  description: string
  info?: string
  prompt: string
  owner: AssignmentTaskOwner
  dependsOn: string[]
  expectedFiles: string[]
  auditChecklist: string[]
  model?: AssignmentModelSelection
}

export interface AssignmentProvenance {
  source: 'agent' | 'manual'
  actor: string
  harnessId?: string
  providerId?: string
  modelId?: string
  parentVersion?: number
  createdAt: number
}

export interface AssignmentPlan {
  schemaVersion: 1
  id: string
  projectId: string
  coordinatorThreadId: string
  specId: string
  specVersion: number
  version: number
  status: AssignmentStatus
  statusBeforeStop?: Exclude<AssignmentStatus, 'stopped'>
  loopModeBeforeStop?: boolean
  scopeBucketId?: string
  /** Durable auditor thread created after this Assignment completes. */
  auditorThreadId?: string
  /** Independent audit and rework lifecycle after implementation completes. */
  auditCycle?: AssignmentAuditCycle
  content: AssignmentPlanContent
  /** Optional for compatibility with assignments persisted before annotations existed. */
  annotations?: AssignmentAnnotation[]
  provenance: AssignmentProvenance
  createdAt: number
  updatedAt: number
  approvedAt?: number
  completedAt?: number
  stoppedAt?: number
}

export type AssignmentValidationCode =
  | 'required'
  | 'duplicate_id'
  | 'missing_reference'
  | 'cycle'
  | 'parallel_file_overlap'
  | 'invalid_path'
  | 'invalid_model'

export interface AssignmentValidationIssue {
  code: AssignmentValidationCode
  path: string
  message: string
}

export interface AssignmentValidationResult {
  valid: boolean
  issues: AssignmentValidationIssue[]
}

export interface AssignmentToolResult {
  assignment: AssignmentPlan
  task?: AssignmentTask
  thread?: Thread
  idempotent: boolean
}

// ─── Audit Reports ─────────────────────────────────────────────────────────

export type AuditSectionId =
  'executive_summary' | 'findings' | 'resolution_recommendation' | 'conclusion'

export type AuditFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface AuditFinding {
  id: string
  title: string
  severity: AuditFindingSeverity
  description: string
  evidence: string
}

export type AuditVerificationCheckKind =
  'format' | 'lint' | 'typecheck' | 'test' | 'build' | 'other'

export type AuditVerificationStatus = 'passed' | 'failed' | 'not_applicable'

export interface AuditVerificationCheck {
  id: string
  kind: AuditVerificationCheckKind
  command: string
  files: string[]
  status: AuditVerificationStatus
  exitCode?: number
  evidence: string
  /** Project-relative, platform-written full command output for this check. */
  evidencePath?: string
  findingIds: string[]
}

export interface AuditVerificationUtility {
  name: string
  status: 'used' | 'unavailable' | 'not_applicable'
  evidence: string
}

export interface AuditVerificationEvidence {
  repositoryRevision: string
  scope: string
  checks: AuditVerificationCheck[]
  utilities: AuditVerificationUtility[]
  limitations: string[]
}

export interface AuditedFileEvidence {
  path: string
  reason: string
}

export interface AuditReportContent {
  executiveSummary: string
  findings: AuditFinding[]
  resolutionRecommendation: string
  conclusion: string
  /** Required for newly generated Assignment audits; optional for legacy persisted reports. */
  auditedFiles?: AuditedFileEvidence[]
  /** Required for newly generated Assignment audits; optional for legacy persisted reports. */
  verification?: AuditVerificationEvidence
}

export interface AuditAnnotation {
  id: string
  section: AuditSectionId
  body: string
  quote?: string
  startLine?: number
  endLine?: number
  /** Character offsets within the rendered audit section for deterministic anchor restoration. */
  startOffset?: number
  endOffset?: number
  status: 'open' | 'resolved'
  author: string
  createdAt: number
  resolvedAt?: number
}

export interface AuditReport {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  specId: string
  specVersion: number
  /** Exact Assignment implementation graph audited, when this is an Assignment audit. */
  assignmentId?: string
  assignmentVersion?: number
  reworkCycle?: number
  version: number
  content: AuditReportContent
  annotations: AuditAnnotation[]
  provenance: SpecProvenance
  createdAt: number
  updatedAt: number
}

export interface AuditGenerationRequest {
  settings: ThreadSettings
  temporaryChatId: string
}

// ─── Workflow ───────────────────────────────────────────────────────────────

export interface WorkflowStage {
  id: string
  name: string
  description: string
  requiredArtifacts: string[]
  gateConditions: string[]
  promptTemplate: string
}

export type WorkflowRuleTrigger = 'stage_change' | 'thread_start' | 'error' | 'completion'

export type WorkflowRuleAction = 'notify' | 'inject_prompt' | 'create_task' | 'block'

export interface WorkflowRule {
  trigger: WorkflowRuleTrigger
  action: WorkflowRuleAction
  config: Record<string, unknown>
}

export interface WorkflowConfig {
  name: string
  stages: WorkflowStage[]
  rules: WorkflowRule[]
}

// ─── Remote ─────────────────────────────────────────────────────────────────

export interface RemoteConnection {
  id: string
  name: string
  host: string
  port: number
  auth: { type: 'key' | 'password'; keyPath?: string }
  remotePath: string
}

// ─── Editors ────────────────────────────────────────────────────────────────

/** Editors / terminals CodeInOven can open a project folder with. */
export type EditorId =
  | 'system'
  | 'terminal'
  | 'iterm2'
  | 'ghostty'
  | 'cmux'
  | 'warp'
  | 'kitty'
  | 'alacritty'
  | 'vscode'
  | 'cursor'
  | 'zed'
  | 'webstorm'
  | 'idea'

/** A detected editor available on this machine. */
export interface EditorInfo {
  id: EditorId
  name: string
  /** Whether the editor was found installed on this machine. */
  available: boolean
  /** Native application icon as a data-URL (PNG), extracted from the .app bundle. */
  iconDataUrl?: string
}

// ─── Global Config ──────────────────────────────────────────────────────────

export type ThemePreference = 'light' | 'dark' | 'system'
export type SlashCommandMode = 'app' | 'passthrough'

export type MemoryCategory = 'behavioral' | 'project-rule' | 'identity' | 'preference'
export type MemoryPriority = 'critical' | 'high' | 'medium' | 'low'
export type MemoryScope = 'global' | 'projects' | 'project' | 'thread' | 'chat'
export type MemorySource = 'manual' | 'auto-detected'

export interface MemoryEntry {
  id: string
  label: string
  content: string
  enabled: boolean
  updatedAt: number
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
  source: MemorySource
  frequency: number
  lastReinforced: number
  projectId?: string
  threadId?: string
}

export interface MemoryConfig {
  /** Whether persistent memory is sent to project agents (global + projects + project + thread). */
  enabled: boolean
  /** Whether persistent memory is sent to chat agents (global + chat + thread). */
  chatEnabled: boolean
  entries: MemoryEntry[]
}

export interface MemoryProposal {
  id: string
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
  projectId?: string
  threadId?: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'rejected'
}

export interface AppConfig {
  theme: ThemePreference
  threadLimit: number
  /** Time before a pending agent question automatically selects its recommendation. */
  questionTimeoutMs: number
  keybindings: Record<string, string>
  /** How slash commands are handled: in-app actions or forwarded to the harness. */
  slashCommandMode: SlashCommandMode
  /** Preferred editor used by “Open in Editor”. `system` falls back to the OS default. */
  preferredEditor: EditorId
  /** Last directory chosen in the folder-picker dialog, so it opens there next time. */
  lastFolderDialogPath?: string
  /** Last directory chosen in the file-attachment dialog, so it opens there next time. */
  lastAttachmentDialogPath?: string
  /** Explicit, user-authored preferences; never mined silently from conversations. */
  memory: MemoryConfig
  /** User-selected defaults for Engineering agent roles. Roles remain unset after installation. */
  agentDefaults: AgentDefaultsConfig
  /** Automatically download available updates in the background. */
  autoDownloadUpdates: boolean
  /** Automatically quit and install after an update is downloaded. */
  autoInstallUpdates: boolean
  /** Update channel to receive over-the-air updates from. `stable` is the default; `nightly` opts into prerelease builds. */
  updateChannel: 'stable' | 'nightly'
  /** Prevent the display and system from sleeping while any agent is working. */
  keepAwakeWhileWorking: boolean
  /** When true, sending an image to a text-only model auto-uses the configured
   *  image descriptor model instead of showing the vision-model picker card. */
  imageDescriptorAskAgain: boolean
  /** Automatically resume threads whose turn ended in a usage/rate-limit reset
   *  once the reported reset time passes. Only applies to harnesses that do not
   *  schedule their own provider retries (OpenCode manages its own). */
  autoRetryAfterReset: boolean
  /** Resume regular and Sr. Engineer threads that were interrupted by an app
   *  closure or unknown issue when the app restarts. */
  resumeWorkOnRestart: boolean
}

/** A single layer of the assembled prompt/behavior display. */
export interface BehaviorLayer {
  title: string
  content: string
  editable: boolean
  defaultOpen: boolean
}

/** Renderer-editable settings. Internal config fields cannot be patched over IPC. */
export type AppConfigPatch = Partial<
  Pick<
    AppConfig,
    | 'theme'
    | 'threadLimit'
    | 'questionTimeoutMs'
    | 'slashCommandMode'
    | 'preferredEditor'
    | 'memory'
    | 'agentDefaults'
    | 'autoDownloadUpdates'
    | 'autoInstallUpdates'
    | 'updateChannel'
    | 'keepAwakeWhileWorking'
    | 'imageDescriptorAskAgain'
    | 'autoRetryAfterReset'
    | 'resumeWorkOnRestart'
  >
>

// ─── Git management ──────────────────────────────────────────────────────────

/** Status of one file in the working tree. */
export type GitFileStatus =
  'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'

/** A single working-tree entry surfaced by porcelain status. */
export interface GitFileChange {
  path: string
  /** Original path for renames/copies. */
  oldPath?: string
  status: GitFileStatus
  /** True when the change is staged for commit. */
  staged: boolean
}

/** A unified diff for a single file, bounded to protect the IPC contract. */
export interface GitDiff {
  path: string
  /** True when the diff is computed against the index (staged). */
  staged: boolean
  /** Unified diff text; empty for binary files. */
  content: string
  binary: boolean
  additions: number
  deletions: number
  /** True when the diff was cut at the payload bound. */
  truncated: boolean
  /** Full before (left) side content, for reuse of the unified diff viewer. */
  before?: string
  /** Full after (right) side content, for reuse of the unified diff viewer. */
  after?: string
}

/** Snapshot of the repository working tree and branch state. */
export interface GitStatus {
  repositoryRoot: string
  branch: string | null
  /** True when HEAD is detached (no branch checked out). */
  detached: boolean
  /** Upstream tracking ref (e.g. `origin/main`), when set. */
  upstream: string | null
  /** Active merge/rebase state, used to offer the correct abort action. */
  conflictState: 'merge' | 'rebase' | 'none'
  clean: boolean
  changes: GitFileChange[]
  /** Count of staged changes (including staged deletions). */
  stagedChanges: number
  /** Count of unstaged modifications. */
  unstagedChanges: number
  /** Count of untracked files. */
  untrackedChanges: number
  /** Paths currently in a merge/rebase conflict. */
  conflicted: string[]
  /** Commits the local branch is ahead of its upstream by. */
  ahead: number
  /** Commits the local branch is behind its upstream by. */
  behind: number
}

/** One local branch and its tracking relationship, when set. */
export interface GitBranchInfo {
  name: string
  current: boolean
  remote: string | null
  ahead: number
  behind: number
}

/** A configured remote. */
export interface GitRemoteInfo {
  name: string
  url: string
}

/** Git identity read from `user.name` / `user.email` config. */
export interface GitIdentity {
  name: string | null
  email: string | null
  configured: boolean
}

/** Renderer-safe git identity write request. */
export interface GitIdentityInput {
  name: string
  email: string
}

/** One commit from `git log`, surfaced in a compact form. */
export interface GitCommitInfo {
  hash: string
  shortHash: string
  author: string
  date: number
  message: string
}

/** Reset severity: soft keeps index+worktree, mixed resets index, hard discards all local changes. */
export type GitResetMode = 'soft' | 'mixed' | 'hard'

/** Renderer-safe git reset request. */
export interface GitResetInput {
  mode: GitResetMode
  /** Commit hash to reset the current branch to. Defaults to HEAD. */
  target?: string
}

/** Result of a push/pull that reports upstream drift. */
export interface GitSyncSummary {
  ahead: number
  behind: number
}

/** Conflict information reported by a merge/rebase failure. */
export interface GitConflictFile {
  path: string
  reason?: string
}

/** Normalized merge/rebase outcome, including conflict state. */
export interface MergeSummary {
  conflicted: GitConflictFile[]
  merged: string[]
  result: string
  /** True when the operation was aborted (merge --abort / rebase --abort). */
  aborted: boolean
}

/** Request to prepare a local merge to resolve a PR's online conflicts. */
export interface PrResolveOptions {
  /** Remote to fetch the PR head and base from (e.g. `origin`). */
  remote: string
  pullNumber: number
  /** Base branch to merge into the checked-out PR head (e.g. `main`). */
  baseBranch: string
}

/** Merge method accepted by provider merge endpoints. */
export type PrMergeMethod = 'merge' | 'squash' | 'rebase'

/** Filter for pull request listings. */
export type PrState = 'open' | 'closed' | 'all'

/** Draft-shaped request to create a pull request on the provider. */
export interface PrDraft {
  owner: string
  repo: string
  title: string
  body?: string
  head: string
  base: string
  draft?: boolean
}

/** PR create request as the renderer sends it; owner/repo resolve from the origin. */
export type PrCreateInput = Omit<PrDraft, 'owner' | 'repo'>

/** GitHub App installation access needed before a repository mutation can run. */
export interface GitHubPermissionRequired {
  status: 'permission_required'
  message: string
  settingsUrl: string
}

/** Typed boundary for GitHub writes, including recoverable installation access. */
export type GitHubMutationResult<T> = { status: 'completed'; value: T } | GitHubPermissionRequired

/** Result of submitting a pull-request review through the GitHub App. */
export type PullRequestReviewResult = GitHubMutationResult<null>

/** Renderer-safe PR reference created or merged by a provider. */
export interface PullRequestReference {
  number: number
  url: string
  title: string
}

/**
 * Pull request as shown in the sidebar list.
 *
 * Avatars are deliberately absent: the renderer CSP blocks remote image hosts,
 * so the UI renders a monogram from `authorLogin` instead of a network image.
 */
export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  authorLogin: string
  headRef: string
  baseRef: string
  createdAt: string
  updatedAt: string
  /** Issue-comment count as reported by the provider (review comments excluded). */
  comments: number
  /**
   * Whether the provider has computed the PR as mergeable (`false` = conflicts).
   * Populated from list payloads where available; absent for locally-constructed
   * summaries (e.g. a just-created PR). Null when not yet computed.
   */
  mergeable?: boolean | null
  /**
   * GitHub's `mergeable_state` from list payloads — `dirty` means the PR has
   * conflicts even when `mergeable` hasn't been computed yet (it is frequently
   * null in list responses). `clean` | `dirty` | `behind` | `unstable` |
   * `draft` | `unknown`.
   */
  mergeableState?: string | null
}

/** One page of pull requests, with a cursor the UI can advance. */
export interface PullRequestPage {
  items: PullRequestSummary[]
  page: number
  /** Whether another page exists after this one. */
  hasMore: boolean
  /** Actionable repository-access failure returned without rejecting IPC. */
  accessError?: string
}

/**
 * GitHub compare result for two refs, used to gate pull request creation.
 * A PR only makes sense when the head actually has commits the base lacks.
 */
export interface PullRequestCompare {
  /** Whether the comparison reflects GitHub or commits that only exist locally. */
  source: 'remote' | 'local'
  status: 'ahead' | 'behind' | 'diverged' | 'identical'
  /** Commits the head has that the base does not. */
  aheadBy: number
  /** Commits the base has that the head does not. */
  behindBy: number
  totalCommits: number
  /** Changed files between the two refs. */
  filesChanged: number
  /** Whether creating a pull request makes sense at all (head is ahead/diverged). */
  hasChanges: boolean
}

/** Full pull request view, loaded when one is opened in the sidebar. */
export interface PullRequestDetail extends PullRequestSummary {
  body: string
  /** Null when the provider has not finished computing mergeability yet. */
  mergeable: boolean | null
  merged: boolean
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
}

/** One commit belonging to a pull request. */
export interface PullRequestCommit {
  sha: string
  /** Seven-character short sha, precomputed for display. */
  shortSha: string
  message: string
  authorName: string
  date: string
}

/** One issue comment on a pull request. */
export interface PullRequestComment {
  id: number
  authorLogin: string
  body: string
  createdAt: string
  url: string
}

/** Review verdict submitted from the sidebar. */
export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** One changed file in a pull request or commit, with its unified patch. */
export interface PullRequestFile {
  path: string
  /** Provider status: added, modified, removed, renamed… */
  status: string
  additions: number
  deletions: number
  /** Unified diff hunk text; null for binary files or oversized patches. */
  patch: string | null
}

/** A submitted review (approval, change request, or review comment). */
export interface PullRequestReview {
  id: number
  authorLogin: string
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED… */
  state: string
  body: string
  submittedAt: string
}

/** An inline code comment attached to a line of the diff. */
export interface PullRequestReviewComment {
  id: number
  authorLogin: string
  body: string
  path: string
  /** Line in the file the comment anchors to; null once outdated. */
  line: number | null
  createdAt: string
}

/** One CI check or commit status on the PR head. */
export interface PullRequestCheck {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'skipped'
    | null
  /** Provider page for the run, when one exists. */
  url: string | null
}

/** Rolled-up CI state for a pull request head. */
export interface PullRequestChecks {
  state: 'success' | 'failure' | 'pending' | 'none'
  checks: PullRequestCheck[]
}

/**
 * Everything the PR detail view renders, fetched in one round trip.
 *
 * The sidebar shows this as a single unit, so bundling avoids six sequential
 * spinners and lets the renderer cache one object per pull request.
 */
export interface PullRequestBundle {
  detail: PullRequestDetail
  commits: PullRequestCommit[]
  comments: PullRequestComment[]
  reviews: PullRequestReview[]
  reviewComments: PullRequestReviewComment[]
  files: PullRequestFile[]
  checks: PullRequestChecks
  /** Epoch ms this bundle was fetched, for cache staleness display. */
  fetchedAt: number
}

/** An agent's review report read back from `.cio/git/pr/<number>/review.md`. */
export interface PrAgentReport {
  /** Absolute path to the report file. */
  path: string
  content: string
  /** Epoch ms of the last write, or null when no report exists yet. */
  updatedAt: number | null
  /** Thread the review was handed to, so the UI can jump back into it. */
  threadId: string | null
}

/** Repository identity resolved from a remote URL (e.g. `owner/repo`). */
export interface GitRepositoryIdentity {
  owner: string
  repo: string
}

/** Result of a provider credential status query — presence only, never plaintext. */
export interface GitCredentialStatus {
  configured: boolean
  secureStorageAvailable: boolean
}

/** Device-code request payload returned by the GitHub device flow. */
export interface GitHubDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

/** Result of one poll of the GitHub device flow token endpoint. */
export type GitHubPollResult =
  | { status: 'pending' }
  | { status: 'authorized' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

/** Presence-only status of the GitHub OAuth connection. Never carries plaintext. */
export interface GitHubAuthStatus {
  connected: boolean
  /** Whether the app has a GitHub App client ID configured to sign in with. */
  configured: boolean
  /** Public profile of the signed-in user, when connected. */
  user?: GitHubUser | null
}

/** Public GitHub user profile, safe to surface in the UI. */
export interface GitHubUser {
  login: string
  name: string | null
  /**
   * Avatar as a `data:` URL — the renderer's CSP blocks remote image hosts, so
   * the main process downloads and inlines it. Null when the download failed;
   * the UI falls back to the GitHub mark.
   */
  avatarUrl: string | null
}

/** One recent GitHub Actions workflow run shown in deployment monitoring. */
export interface GitHubWorkflowRun {
  id: number
  name: string
  displayTitle: string
  runNumber: number
  event: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion: string | null
  branch: string
  headSha: string
  url: string
  actorLogin: string
  createdAt: string
  updatedAt: string
}

/** Latest status recorded for one GitHub deployment. */
export interface GitHubDeploymentStatus {
  state: string
  description: string
  environmentUrl: string | null
  logUrl: string | null
  createdAt: string
}

/** One recent GitHub deployment and its latest status. */
export interface GitHubDeployment {
  id: number
  environment: string
  description: string
  ref: string
  sha: string
  createdAt: string
  updatedAt: string
  latestStatus: GitHubDeploymentStatus | null
}

/** Read-only GitHub Actions and Deployments snapshot for a repository. */
export interface GitHubDeploymentOverview {
  workflowRuns: GitHubWorkflowRun[]
  deployments: GitHubDeployment[]
  fetchedAt: number
}

/**
 * `deployment:overview` IPC result. `hasDeployments` is derived from the
 * snapshot and drives whether the Deployments tab is shown at all.
 */
export interface GitHubDeploymentOverviewResult extends GitHubDeploymentOverview {
  hasDeployments: boolean
  /** Actionable repository-access failure returned without rejecting IPC. */
  accessError?: string
}

/** One step inside a workflow run job — the granular "why did it fail" data. */
export interface GitHubDeploymentJobStep {
  number: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion: string | null
}

/** One workflow run job, with its step-level breakdown. */
export interface GitHubDeploymentJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string
  completedAt: string | null
  url: string
  steps: GitHubDeploymentJobStep[]
}

/** Everything the in-app deployment detail view needs. */
export interface GitHubDeploymentDetail {
  deployment: GitHubDeployment
  statuses: GitHubDeploymentStatus[]
  workflowRun: GitHubWorkflowRun | null
  jobs: GitHubDeploymentJob[]
  fetchedAt: number
}

/** Capped raw log text for one workflow run job. */
export interface GitHubDeploymentJobLog {
  jobId: number
  log: string
  truncated: boolean
}

/** Everything the in-app workflow-run detail view needs. */
export interface GitHubWorkflowRunDetail {
  run: GitHubWorkflowRun
  jobs: GitHubDeploymentJob[]
  fetchedAt: number
}

// ─── Cloud deployments ───────────────────────────────────────────────────────

/** Provider-agnostic deployment hosts the Cloud Deployments panel can reach. */
export type CloudDeploymentProviderKind =
  'coolify' | 'netlify' | 'railway' | 'vercel' | 'dokploy' | 'custom'

/** Every `CloudDeploymentProviderKind` as a runtime array — single source for schema enums. */
export const CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES: readonly CloudDeploymentProviderKind[] = [
  'coolify',
  'netlify',
  'railway',
  'vercel',
  'dokploy',
  'custom'
]

/**
 * Provider kinds backed by the not-implemented stub (v1 is Coolify-only).
 * Attempting to query these must surface a not-implemented-yet signal and must
 * never trigger a network call. Single source shared by main and renderer.
 */
export const CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS: readonly CloudDeploymentProviderKind[] = [
  'netlify',
  'railway',
  'vercel',
  'dokploy'
]

/** Latest build/run state of a cloud deployment container. */
export type CloudDeploymentStatus = 'building' | 'success' | 'failed' | 'unknown'

/**
 * One deployment/build record for a cloud deployment container. The detail view
 * shows the last several of these so the user can compare a passing vs failing
 * run and open the build log for any of them.
 */
export interface CloudDeploymentDeployment {
  /** Provider-side deployment id (e.g. a Coolify deployment_uuid). */
  id: string
  /** Latest known status of this deployment/build. */
  status: CloudDeploymentStatus
  /** Epoch ms this deployment was last updated. */
  updatedAt?: number
  /** Commit hash the deployment built, when the provider reports it. */
  commit?: string
  /** Capped raw build log for this deployment, when available. */
  log?: string
}

/** One provider-agnostic cloud deployment container/application mapping. */
export interface CloudDeploymentContainer {
  /** Stable container identity the provider adapter can query by. */
  id: string
  /** User-supplied custom label shown in the panel. */
  label: string
  /** Provider that owns this container. */
  providerKind: CloudDeploymentProviderKind
  /** Latest known deployment/build status. */
  status: CloudDeploymentStatus
  /** Live URL of the deployed application, when known. */
  url?: string
  /** Epoch ms the container was first seen. */
  createdAt?: number
  /** Epoch ms of the last status change. */
  updatedAt?: number
  /** Capped raw log text for the latest deployment, when available. */
  log?: string
}

/**
 * A cloud deployment provider account in the global registry. Accounts are
 * created once, labelled by the user, and can be attached to any project.
 * They are NOT scoped to a project: the same account (e.g. one Coolify
 * instance, or one Vercel team) is reused across every project that uses it.
 */
export interface CloudDeploymentProviderAccount {
  /** Stable account identity, unique across the whole registry. */
  id: string
  /** User-supplied label shown in the panel (e.g. 'Coolify — Personal'). */
  label: string
  /** Provider this account authenticates. */
  providerKind: CloudDeploymentProviderKind
  /** Opaque SecretVault reference for the stored token; never carries plaintext. */
  secretRef: string
  /** Verified base URL the provider is reached at (e.g. the Coolify host), when known. */
  baseUrl?: string
  /** Whether this account currently holds a stored credential. */
  configured: boolean
  /** Whether this account is enabled for use. Disabled accounts are skipped by monitoring. */
  enabled: boolean
  /** Epoch ms the account was first created. */
  createdAt: number
  /** Epoch ms the account's credential was last stored or rotated. */
  updatedAt: number
}

/**
 * The global cloud deployment provider account registry. Persisted by main,
 * independent of any project. Keyed by account id.
 */
export interface CloudDeploymentAccountRegistry {
  accounts: CloudDeploymentProviderAccount[]
}

/**
 * A project's attachment to a provider's accounts. A project can attach
 * several accounts of the same provider and pick one active for monitoring.
 */
export interface CloudDeploymentProjectProviderAccounts {
  /** Ids of the global accounts attached to this project for this provider. */
  attachedAccountIds: string[]
  /** Id of the active attached account for this provider, or null when none. */
  activeAccountId: string | null
}

/** One project's selected providers and their labelled container mappings. */
export interface CloudDeploymentProjectConfig {
  /** Provider kinds selected for this project. */
  providers: CloudDeploymentProviderKind[]
  /** Container mappings configured for this project, with user labels. */
  containers: CloudDeploymentContainer[]
  /** Per-provider account attachments (which global accounts this project uses). */
  providerAccounts?: Partial<
    Record<CloudDeploymentProviderKind, CloudDeploymentProjectProviderAccounts>
  >
}

/**
 * Per-project cloud deployment configuration, persisted by main, never in the
 * repo. Accounts themselves live in the global `CloudDeploymentAccountRegistry`
 * (see `cloudDeploy:listAccounts`); this config only records which accounts the
 * project attaches and which is active per provider.
 */
export interface CloudDeploymentConfig {
  version: 3
  projectId: string
  /** Selected providers plus labelled container mappings and account attachments. */
  project: CloudDeploymentProjectConfig
  /** Epoch ms of the last configuration change. */
  updatedAt: number
}

/** Read-only provider-agnostic deployment snapshot for a project. */
export interface CloudDeploymentOverview {
  containers: CloudDeploymentContainer[]
  fetchedAt: number
}

/**
 * Cloud deployment overview IPC result. `hasDeployments` is derived from the
 * snapshot and drives whether the Cloud Deployments panel is shown at all.
 */
export interface CloudDeploymentResult extends CloudDeploymentOverview {
  hasDeployments: boolean
  /** Actionable provider/credential access failure returned without rejecting IPC. */
  accessError?: string
}

/** One entry from `git stash list`, e.g. `stash@{0}`. */
export interface GitStashEntry {
  /** Reflog selector, e.g. `stash@{0}`. */
  id: string
  /** Stash message, e.g. `WIP on main: abc1234 feat: thing`. */
  message: string
  /** Branch the stash was created on, when derivable. */
  branch: string | null
  /** Unix timestamp of the stash commit. */
  date: number
}
