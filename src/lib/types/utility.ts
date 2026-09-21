/** Additional capabilities CodeInOven can expose when a harness lacks them. */
export type UtilityKind =
  'mcp' | 'skill' | 'web_search' | 'web_fetch' | 'computer_use' | 'provider' | 'image_descriptor'

/** Every `UtilityKind` as a runtime array   single source for schema enums and validation sets. */
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

/** Binding target that keeps a utility available to every current and future harness. */
export const ALL_HARNESSES_BINDING_ID = '*'

/** How one harness receives a resolved utility without writing into the project. */
export interface HarnessUtilityBinding {
  /** A literal `*` applies this binding to every current and future harness. */
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
  /** App-seeded utility: cannot be deleted and only its config may change. */
  appOwned: boolean
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
  /** Defaults to `on_demand`; an MCP server is always normalized to `on_demand`. */
  activation?: UtilityActivation
  /** Optional on install: a definition without a scope is stored as global. */
  scope?: UtilityScope
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

/** Result of an explicit utility-setup turn run in a disposable agent session. */
export interface UtilitySetupReport {
  taskId: string
  summary: string
  installed: UtilityDefinition[]
}

/** Public skills.sh search result displayed in the Utilities marketplace. */
export interface SkillMarketEntry {
  id: string
  skillId: string
  name: string
  source: string
  installs: number
  url: string
  weeklyInstalls?: number[]
  installsYesterday?: number
  change?: number
  isOfficial?: boolean
}

/**
 * One place a marketplace skill is already installed. The marketplace uses these
 * to mark installed entries and to stop offering an install that already landed,
 * without trusting a renderer-only flag that would not survive a restart.
 */
export interface InstalledSkillLocation {
  /** Marketplace skill id, which is also the skill's folder name on disk. */
  skillId: string
  /** Whether CodeInOven's registry or the native Skills CLI layout owns this copy. */
  manager: 'cio' | 'native'
  /** Layer the copy lives in. */
  scope: 'global' | 'project' | 'harness'
  /** Project the copy belongs to (project scope only). */
  projectId?: string
  /** Harness whose skill folder holds the copy (harness scope only). */
  harnessId?: string
  /** Human-readable destination, e.g. "All harnesses" or a project name. */
  label: string
  /** Filesystem location for native copies; empty for registry-managed copies. */
  path: string
  /** Activation of a registry-managed copy. */
  activation?: UtilityActivation
}

export type SkillMarketView = 'all-time' | 'trending' | 'hot'

export interface SkillMarketLeaderboard {
  view: SkillMarketView
  entries: SkillMarketEntry[]
}

export interface SkillMarketSearchResult {
  query: string
  entries: SkillMarketEntry[]
}

export interface SkillMarketAudit {
  name: string
  status: 'pass' | 'warn' | 'fail' | 'unknown'
}

export interface SkillMarketDetail extends SkillMarketEntry {
  description: string
  repositoryUrl: string | null
  githubStars: number | null
  firstSeen: string | null
  audits: SkillMarketAudit[]
  skillMarkdown: string
}

export interface SkillMarketInstallRequest {
  source: string
  skillId: string
  manager: 'cio' | 'native'
  scope:
    | { kind: 'global' }
    | { kind: 'projects'; projectIds: string[] }
    | { kind: 'harnesses'; harnessIds: string[] }
  activation?: UtilityActivation
}

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
  /** Harness that owns/loads this capability (harness-origin entries only). */
  harnessId?: string
  /** Project the capability is declared in (project-scoped entries only). */
  projectId?: string
}

/** Settings-level view of every MCP server and skill the app can see. */
export interface AgentCapabilityCatalog {
  mcp: AgentCapabilityEntry[]
  skill: AgentCapabilityEntry[]
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
