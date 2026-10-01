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
  /**
   * Explicit remote request headers. A value may reference a vault-backed
   * variable with `{env:NAME}`; a declared credential that no header carries is
   * still sent to a remote server automatically, so this is only needed for a
   * server that reads its secret from a header other than `Authorization`.
   */
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

/**
 * One skill copy CodeInOven itself installed, kept so the background updater can
 * refresh exactly what the app placed and nothing else. A skill installed by
 * hand with the `skills` CLI has no record here and is never rewritten.
 */
export interface SkillInstallRecord {
  /** `manager:skillId:scope:projectId|all`   stable identity of one install. */
  id: string
  /** Marketplace skill id, which is also the skill's folder name on disk. */
  skillId: string
  /** Whether CodeInOven's registry or the native Skills CLI layout owns this copy. */
  manager: 'cio' | 'native'
  /** Marketplace source the skill came from: `owner/repo`, or a domain. */
  source: string
  /** Which upstream API answers "has this changed": the GitHub tree API or a well-known index. */
  sourceType: 'github' | 'well-known'
  scope: 'global' | 'project' | 'harness'
  projectId?: string
  /** Harness scope only: the harnesses this copy was installed for. */
  harnessIds?: string[]
  /** CodeInOven-managed copies only: how the skill is exposed to a turn. */
  activation?: UtilityActivation
  /**
   * Upstream identity of the skill as it was installed: the git tree sha of its
   * folder for a GitHub source, the index digest for a well-known source. The
   * background pass compares this against upstream to decide whether to
   * re-install. Null until a baseline could be read.
   */
  upstreamHash: string | null
  /** GitHub sources only: the skill's `SKILL.md` path inside the repository. */
  skillPath: string | null
  installedAt: number
  /** Epoch ms of the last background check that looked at this copy. */
  lastCheckedAt: number | null
  /** Epoch ms of the last time this copy was rewritten from its source. */
  lastUpdatedAt: number | null
}

/** What a background pass concluded about one installed skill copy. */
export type SkillUpdateOutcome = 'updated' | 'current' | 'failed' | 'untracked'

/** One skill's line in the background update report. */
export interface SkillUpdateResult {
  /** Install record this result belongs to. */
  id: string
  skillId: string
  manager: 'cio' | 'native'
  scope: 'global' | 'project' | 'harness'
  projectId?: string
  outcome: SkillUpdateOutcome
  /** Why, for every outcome except `current`. */
  detail?: string
}

/** Background skill-update state, rendered by the Utilities page. */
export interface SkillUpdateStatus {
  running: boolean
  /** Skill copies CodeInOven owns and keeps fresh. */
  tracked: number
  lastCheckedAt: number | null
  lastFinishedAt: number | null
  /** Copies rewritten in the most recent pass. */
  updated: number
  results: SkillUpdateResult[]
  /** Pass-level failure (offline, rate limited); per-skill failures stay in `results`. */
  error?: string
}

/** Result of an explicit utility-setup turn run in a disposable agent session. */
export interface UtilitySetupReport {
  taskId: string
  summary: string
  installed: UtilityDefinition[]
}

/** One tool the tested MCP server advertised. */
export interface McpConnectionTool {
  name: string
  description?: string
}

/** A credential value supplied with an unsaved MCP draft; a test never stores it. */
export interface McpProbeCredential {
  environmentVariable: string
  value: string
}

/**
 * What one MCP connection test connects to: an installed registry utility, a
 * harness-native server already on disk, or the configuration an editor is
 * showing before it is saved.
 */
export type McpProbeTarget =
  | { kind: 'registry'; utilityId: string }
  | { kind: 'native'; source: AgentCapabilitySource }
  | {
      kind: 'inline'
      config: McpUtilityConfig
      /** Saved utility whose stored credentials fill this draft's `{env:NAME}` references. */
      baseUtilityId?: string
      /** Values typed into an unsaved editor, used for this test only. */
      credentials?: McpProbeCredential[]
    }

/**
 * What a live MCP connection test found. A server that will not start is a
 * result rather than an IPC failure, exactly like a provider connection check.
 */
export interface McpConnectionTestResult {
  ok: boolean
  /** Transport that was tested; absent when the test never reached a server. */
  transport?: McpUtilityConfig['transport']
  /** Where the test connected: the command line or the URL, never a credential value. */
  target: string
  /** Wall-clock time for the handshake plus `tools/list`. */
  latencyMs: number
  /** Tools the server advertised, capped for display. */
  tools: McpConnectionTool[]
  /** Advertised tool count, which may exceed `tools.length`. */
  toolCount: number
  /** What the server called itself while answering `initialize`. */
  serverName?: string
  serverVersion?: string
  /** Why the test failed. Present only when `ok` is false. */
  error?: string
  /** Credential variables the configuration expects but had no value for. */
  missingCredentials: string[]
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

/**
 * What one marketplace skill uninstall removed, so the caller can report it.
 * Native copies are removed by the Skills CLI, which owns that on-disk layout.
 */
export interface SkillUninstallReport {
  /** Registry entries removed, across every scope the skill was installed in. */
  registryEntries: number
  /** Native scopes cleaned: the user-level layout plus one per project. */
  nativeScopes: number
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
  /** Vendor and provider identifiers the skill body names (a provider host or
   *  credential name, for example). Library search reads this because a skill's
   *  frontmatter description often omits the vendor it wraps. */
  searchKeywords?: string
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
