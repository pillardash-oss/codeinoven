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
}

/** A custom provider defined by base URL, stored and vaulted by CodeInOven. */
export interface BaseUrlProvider {
  id: string
  /** Harness this provider applies to (e.g. 'opencode'). */
  harnessId: string
  /** AI SDK npm package to use (e.g. '@ai-sdk/openai-compatible' or '@ai-sdk/openai'). */
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
export type UtilityKind = 'mcp' | 'skill' | 'web_search' | 'web_fetch' | 'computer_use' | 'provider'

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

export interface UtilityConfigMap {
  mcp: McpUtilityConfig
  skill: SkillUtilityConfig
  web_search: WebUtilityConfig
  web_fetch: WebUtilityConfig
  computer_use: ComputerUseUtilityConfig
  provider: ProviderUtilityConfig
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
  overageStatus?: string
  overageDisabledReason?: string
  isUsingOverage?: boolean
}

/** Display-ready provider-neutral usage for the active conversation. */
export interface AgentContextUsage {
  contextWindow?: number
  contextUsed: number
  contextPercent?: number
  costUsd: number
  tokens: AgentTokenUsage
  rateLimits: AgentRateLimitWindow[]
}

/** Last-known usage snapshot stored with a thread so the meter restores
 *  instantly on mount and is evacuated automatically when the thread row is
 *  deleted. The harness/provider pair guard against showing usage from a
 *  different agent configuration. */
export interface ThreadContextUsage extends AgentContextUsage {
  harnessId: string
  providerId: string
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
  tokens?: AgentTokenUsage
  /** Effective model context window reported by the harness, when available. */
  contextWindow?: number
  /** Cumulative tokens currently occupying the model context, when available. */
  contextUsed?: number
  /** Optional account quota windows when the provider exposes them. */
  rateLimits?: AgentRateLimitWindow[]
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
  | { state: 'working' }
  | { state: 'idle' }
  | { state: 'waiting'; issue: AgentProviderIssue }
  | { state: 'error'; issue: AgentProviderIssue }

export type BrainstormTraceUpdate =
  | { type: 'started'; messages: AgentMessage[] }
  | { type: 'part.updated'; messageId: string; part: AgentPart }
  | { type: 'part.delta'; messageId: string; partId: string; field: string; delta: string }
  | { type: 'completed'; messages: AgentMessage[] }

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
      /** Effective model context window reported when the harness closes the turn. */
      contextWindow?: number
      /** Cumulative tokens currently occupying the model context, when available. */
      contextUsed?: number
      /** Account quota windows reported after the harness refreshes usage. */
      rateLimits?: AgentRateLimitWindow[]
      /** The completed assistant message summarizes a compaction and is trace-only. */
      compaction?: boolean
    }
  | {
      type: 'usage.updated'
      sessionId: string
      messageId: string
      tokens?: AgentTokenUsage
      contextWindow?: number
      contextUsed?: number
      cost?: number
      rateLimits?: AgentRateLimitWindow[]
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
  'draft' | 'approved' | 'running' | 'attention' | 'completed' | 'failed'

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

export type AssignmentTaskOwner = 'senior' | 'worker'

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
  status: AssignmentTaskStatus
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
  | 'report_ready'
  | 'planning_rework'
  | 'awaiting_rework_approval'
  | 'reworking'
  | 'completed'

/** Persisted hand-off between Assignment implementation and its independent audit. */
export interface AssignmentAuditCycle {
  status: AssignmentAuditCycleStatus
  availableAt?: number
  startedAt?: number
  reportId?: string
  reportVersion?: number
  reportedAt?: number
  reworkStartedAt?: number
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

export interface AuditReportContent {
  executiveSummary: string
  findings: AuditFinding[]
  resolutionRecommendation: string
  conclusion: string
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
export type MemoryScope = 'global' | 'project' | 'thread' | 'chat'
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
  enabled: boolean
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
}

/** Snapshot of the repository working tree and branch state. */
export interface GitStatus {
  repositoryRoot: string
  branch: string | null
  /** True when HEAD is detached (no branch checked out). */
  detached: boolean
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

/** Renderer-safe PR reference created or merged by a provider. */
export interface PullRequestReference {
  number: number
  url: string
  title: string
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
