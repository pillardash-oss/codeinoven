import type { TurnStepTimer } from '../chat/turn-dispatch-timer'
import type { AssistantReportingPatch } from '../../lib/assistant-authoring'
import { type Server } from 'http'
import type {
  ResolvedUtility,
  UtilityDefinition,
  UtilityDefinitionFor,
  PermissionLevel,
  AgentUtilitySuggestionEntry,
  ThreadSearchResult
} from '../../lib/types'
import { StorageEngine } from '../storage/storage-engine'
import { SecretVault } from '../storage/secret-vault'
import { UtilityRegistryService } from './utility-registry-service'
import { CuaBridgeService } from './cua-bridge-service'
import { type DesignSessionMode } from './cio-design-prompt'
import { type VideoSessionMode } from './cio-video-prompt'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import { type GatewayToolDefinition } from '../../lib/gateway-tools'
import { type EngineeringToolOperation } from '../../lib/engineering-tools'
import { type CuaSnapshotView } from '../../lib/cua-driver'
import { CioDiagnosticsService } from './cio-diagnostics-service'
import type { ExpertSettingsService } from '../design/expert-settings-service'
import { type McpClient } from '../agents/mcp-stdio-client'
import { type ImageDescriptorExecutor } from '../providers/image-descriptor-provider'
import { type UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import type { AgentSecretResolution } from './agent-secret-service'
import type { ScopeToolContext } from '../workspaces/scope-tool-service'
import { UtilityScopeFootprintService } from './utility-scope-footprint'
import { type ThreadBankEntry } from './utility-orchestration/utility-turn-state'
import { type UtilitySuggestionResolution } from '../../lib/utility-suggestion'
import type { McpOAuthService } from './mcp-oauth/mcp-oauth-service'
import { buildUtilityOrchestrationServiceUnits } from './utility-orchestration-service/utility-orchestration-service-units'

export const CUA_UTILITY_ID = 'cio:cua-driver'

export interface UtilityTurnRequest {
  harnessId: string
  projectId: string
  threadId: string
  /** Scope the calling thread works in; the default target of `cio:scope`. */
  scopeBucketId?: string
  /** Human-readable thread title, used to label Cua agent cursors. */
  threadTitle?: string
  projectPath: string
  /** Main thread session that owns this turn, for scoped user-decision events. */
  sessionId: string
  nativeCapabilities: string[]
  permissionLevel: PermissionLevel
  /**
   * Live check for whether the executing model can see images itself. Resolved
   * fresh on every eligibility pass (turn start and each mid-turn refresh) so a
   * vision report the user makes mid-turn hides the image descriptor from the
   * very next gateway search instead of only from the following turn.
   */
  resolveExecutingModelVisionCapable?: () => Promise<boolean>
  /** Explicit user intent grants the setup-only utility management operation. */
  allowManagement?: boolean
  /**
   * Whether this turn belongs to a design session: either the user opened it with
   * `@cio-design`, or an earlier turn opened it by activating the capability and
   * the app recorded it on the thread. A session promotes the app-owned design
   * capability to an active capability for the turn, so the playbook is already
   * in context and its preview operation is callable without a search and an
   * activation.
   */
  designSession?: DesignSessionMode
  /**
   * Whether this turn belongs to a video session: either the user opened it with
   * `@cio-video`, or an earlier turn opened it by activating the capability. It
   * does for the video capability what `designSession` does for the design
   * capability: promotes it to an active capability for the turn, so the edit
   * pass is in context and `preview` and `capture` are callable at once.
   */
  videoSession?: VideoSessionMode
  /**
   * Whether this turn belongs to an orchestration session the user opened with
   * `@cio-hey`. It is the gate for the workstation tools: only a turn
   * that carries this contract is offered the targets, dispatch and status
   * operations, so an ordinary chat can never start a run on a machine.
   */
  orchestrationSession?: OrchestrationSessionMode
  /**
   * Whether this turn may create the thread's engineering artifacts (Brainstorm,
   * PRD, specification, Assignment) through the app-owned artifact tools. Set
   * for a real project thread's user turn, and never for a chat, an assistant
   * task or an Assignment worker, so those turns are offered none of the routes.
   */
  artifactTools?: boolean
  /** Present only for an active interview; the callback owns the exact note path/version. */
  saveBrainstormNotes?: (markdown: string) => Promise<{ path: string; version: number }>
  /**
   * Present only for an assistant's Getting started interview; the callback owns
   * the checkpoint path and replaces its content.
   */
  saveAssistantCheckpoint?: (markdown: string) => Promise<{ path: string }>
  /**
   * Present only for an assistant's Getting started interview; the callback writes
   * the name the conversation settles onto the assistant and broadcasts the change,
   * so every surface renames itself the moment the user answers rather than at the
   * end of the interview. How the assistant behaves has no callback: it is the
   * `Personality` section of the knowledge.
   */
  saveAssistantIdentity?: (identity: { name: string }) => Promise<void>
  /** Persist the clock choice during the live setup interview. */
  saveAssistantSchedule?: (scheduled: boolean) => Promise<void>
  /** Persist settled reporting choices during the live setup interview. */
  saveAssistantReporting?: (reporting: AssistantReportingPatch) => Promise<void>
  /**
   * Present only on a turn that runs a saved assistant. The callback holds the
   * report the run declared for this turn; the chat engine files it when the
   * turn settles, so the app never manufactures one from an ordinary answer.
   */
  saveAssistantReport?: (
    title: string,
    markdown?: string
  ) => Promise<{ status: 'queued'; title: string }>
  budgetContext: UtilityTurnBudgetContext
  attributeReinjectedResult: (attribution: UtilityResultAttribution) => void
  /**
   * The dispatching turn's own clock.
   *
   * Preparing a turn's utilities is where a project turn spends its largest
   * unaccounted wait (a registry pass over every installed utility, the Cua
   * Driver's install scan and spawn, the thread bank, the gateway server and the
   * audit trail). Reporting each of them as a step of the same dispatch keeps that
   * wait attributable in the dev log instead of leaving it inside one phase mark.
   */
  telemetry?: TurnStepTimer
}

export interface UtilityTurnBudgetContext {
  /** Selected model input allowance after output and tool headroom reserves. */
  selectedModelInputTokens: number
  /** Updated by chat-engine as soon as the final turn composition is known. */
  composedTurnTokens: number
  /** Persisted user message that owns utility work for this turn. */
  parentTurnId: string
}

export interface UtilityResultAttribution {
  featureCallId: string
  utilityId: string
  reinjectedTokens: number
  truncatedTokens: number
  success: boolean
  retryCause: string | null
}

/**
 * One computer-use operation an agent just ran, reported for every such
 * operation and not only the ones with a target process. A desktop-scoped run
 * (`get_desktop_state`, `escalate_session`, a desktop `hotkey`) names no pid,
 * yet it is still computer use and must still be visible to the user.
 */
export interface CuaOperationEvent {
  threadId: string
  /** Driver operation name, e.g. `drag`. */
  operation: string
  /** Target process, or null when the operation did not name one. */
  pid: number | null
  /** Turn-scoped Cua cursor session, when the driver declared one. */
  sessionId?: string
  /**
   * Where the run's own cursor now sits, in screen points, or null when the
   * driver reported no position.
   *
   * Read here, on this turn's own driver connection, because a Cua session
   * belongs to the MCP transport that created it: `get_agent_cursor_state`
   * refuses a session another transport opened ("session is not available to
   * this transport"). The PiP monitor owns a transport of its own for capture,
   * so only this client can read it, and the point travels with the operation
   * that moved the cursor.
   */
  cursor: { x: number; y: number } | null
  /**
   * The tier this turn runs at. The daemon's authorization mode is fixed when it
   * starts, so the PiP monitor has to ask for the same one the run already owns
   * rather than starting a second, differently-tiered daemon under it.
   */
  permissionLevel: PermissionLevel
}

export interface UtilityTurnGateway {
  id: string
  resolvedUtilities: ResolvedUtility[]
  instructions: string
  /** Tool-only instructions for harnesses with a native gateway bridge. */
  directInstructions: string
  /**
   * Turn-scoped loopback endpoint for direct-gateway harnesses whose persistent
   * session extensions cannot receive a per-turn launch overlay. Drivers like
   * Pi hand { url, token } to their bridge through a session-keyed channel;
   * `null` when the direct path is not in use for this turn.
   */
  directEndpoint: UtilityGatewayEndpoint | null
  /**
   * Whether this turn carries the explicit-setup contract (utility management and
   * app diagnostics). A gateway fixes its tool set when the turn starts, so a
   * caller that needs to grant management mid-turn has to read this to decide
   * whether the live gateway can serve the request or must be rebuilt.
   */
  managementEnabled: boolean
  cleanup(): Promise<void>
}

export type BrowserUtilityExecutor = (
  operation: string,
  input: Record<string, unknown>,
  context: {
    projectId: string
    threadId: string
    permissionLevel: PermissionLevel
    /** Harness session owning the turn, so attached-page approvals surface on its permission card. */
    sessionId?: string
  }
) => Promise<unknown>

/**
 * Runs one gateway invocation of the app-owned design capability for the turn
 * that made it. The app supplies one of these per operation group, because the
 * three halves have different owners: `preview` composes the loopback directory
 * preview with the in-app browser, `delegate` runs a prompt on the model the
 * user assigned to that design work, `generate` produces media with the model
 * assigned to a media craft, and `save-media` writes a generated asset
 * into the project as a file the design can reference.
 */
export type DesignCapabilityExecutor = (
  operation: string,
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string }
) => Promise<unknown>

/**
 * Runs one gateway invocation of the app-owned video capability for the turn
 * that made it. The two operations have different owners: `preview` composes the
 * loopback directory preview with the in-app browser, and `capture` adds the
 * frame render and the screenshot on top of the same serve-and-show path.
 */
export type VideoCapabilityExecutor = (
  operation: string,
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string }
) => Promise<unknown>

/**
 * Reports that a turn entered an authored-work session by activating the
 * app-owned capability for it. The chat engine supplies this because it owns the
 * thread rows: recording the kind there is what docks the coordinator board and
 * keeps the session alive on the thread's later turns.
 */
export type AuthoredWorkSessionRecorder = (input: {
  projectId: string
  threadId: string
  kind: AuthoredWorkKind
}) => void

/**
 * Runs one gateway invocation of the app-owned scope and worktree capability
 * for the turn that made it. The chat engine supplies it because it owns the
 * thread's scope, project root and permission tier.
 */
export type ScopeToolExecutor = (
  input: Record<string, unknown>,
  context: ScopeToolContext
) => Promise<unknown>

/**
 * Runs one `cio_ask_secret` gateway request for the turn that made it: it
 * surfaces the secret card, awaits the user's submission, stores the values
 * (vault, and a utility credential when the agent named a capability) and
 * returns them so the calling tool can report the names without the values.
 * The chat engine supplies it because it owns the pending-question machinery
 * and the secret store.
 */
export type SecretRequestExecutor = (
  input: Record<string, unknown>,
  context: SecretRequestContext
) => Promise<AgentSecretResolution>

/** Which turn is asking, so the card is bound to the right thread and session. */
export interface SecretRequestContext {
  projectId: string
  threadId: string
  projectPath: string
  sessionId: string
  harnessId: string
}

/**
 * Runs one `cio_util_suggest` gateway request for the turn that made it: it
 * surfaces the suggestion card, awaits the user's decision and returns it. The
 * chat engine supplies it because it owns the pending-question machinery. The
 * install itself stays with the gateway, which owns the registry, so the card
 * only ever reports a decision and an abandoned card can never install anything.
 */
export type UtilitySuggestionExecutor = (
  entry: AgentUtilitySuggestionEntry,
  context: UtilitySuggestionContext
) => Promise<UtilitySuggestionResolution>

/** Which turn is proposing, so the card is bound to the right thread and session. */
export interface UtilitySuggestionContext {
  projectId: string
  threadId: string
  projectPath: string
  sessionId: string
  harnessId: string
}

/** Whether a turn is inside an orchestration session opened by `@cio-hey`. */
export type OrchestrationSessionMode = 'off' | 'start' | 'continue'

/**
 * Runs one orchestration tool for the turn that asked for it: it reads the
 * workstation or dispatches real work onto a chosen machine. The chat engine
 * supplies it because it owns thread creation, prompt sending and the turn
 * lifecycle the tools act on.
 */
export type OrchestrationExecutor = (
  operation: OrchestrationToolOperation,
  input: Record<string, unknown>,
  context: OrchestrationToolContext
) => Promise<unknown>

/** The turn an orchestration call came from. */
export interface OrchestrationToolContext {
  projectId: string
  threadId: string
  projectPath: string
  sessionId: string
  harnessId: string
}

export type OrchestrationToolOperation = 'targets' | 'dispatch' | 'status'

/** The two app-control operations, mirrored from the tool catalog. */
export type AppControlOperation = 'catalog' | 'call'

/**
 * Runs one engineering artifact tool for the turn that asked for it: it creates
 * the thread's Brainstorm, PRD, specification or Assignment draft through the
 * machinery the Studio buttons use. The chat engine supplies it because it owns
 * the engines, the isolated generation sessions and the review surfaces those
 * artifacts land on.
 */
export type EngineeringToolExecutor = (
  operation: EngineeringToolOperation,
  input: Record<string, unknown>,
  context: EngineeringToolContext
) => Promise<unknown>

/** The turn an engineering artifact call came from. */
export interface EngineeringToolContext {
  projectId: string
  threadId: string
  projectPath: string
  sessionId: string
  harnessId: string
}

/** The turn a pawn agent call came from. */
export interface PawnToolContext {
  projectId: string
  threadId: string
  projectPath: string
  sessionId: string
  harnessId: string
}

/**
 * Runs one pawn agent tool call for the turn that asked for it: it spawns or
 * continues a background thread owned by that turn's agent. The chat engine
 * supplies it because it owns thread creation, sessions and turn completion.
 */
export type PawnToolExecutor = (
  input: Record<string, unknown>,
  context: PawnToolContext
) => Promise<unknown>

/** The turn an app-control call came from. */
export interface AppControlContext {
  projectId: string
  projectPath: string | null
  threadId: string
  permissionLevel: PermissionLevel
}

/**
 * Runs one app-control tool for the turn that asked for it: it lists the app
 * surface or performs one app call through the renderer. The chat engine
 * supplies it because the app-control bridge lives beside the turn lifecycle.
 */
export interface AppControlExecutor {
  catalog: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
  call: (input: Record<string, unknown>, context: AppControlContext) => Promise<unknown>
}

export interface TurnState {
  grantedTools: GatewayToolDefinition[]
  id: string
  request: UtilityTurnRequest
  eligible: Map<string, ResolvedUtility>
  activated: Map<string, ResolvedUtility>
  clients: Map<string, McpClient>
  /**
   * Connections being established right now, keyed like `clients`.
   *
   * The gateway serves concurrent calls, so two of them can reach the same
   * utility before either has a client: a parallel tool call inside one turn, or
   * a turn whose agent fires several operations at once. Without this, both
   * spawn a server process and the slower one is overwritten in `clients` and
   * never closed, leaving an orphan holding the same shared resource (the Cua
   * daemon, an npm cache lock) that the surviving one needs.
   */
  connecting: Map<string, Promise<McpClient>>
  attributionSequence: number
  /** True once the agent has called the app utility-search tool this turn. */
  searched: boolean
  /** Session ids created for Cua utilities so cursor state is turn-scoped. */
  cuaSessionIds: Map<string, string>
  /**
   * The window snapshot the gateway handed the model, keyed `pid:window_id`.
   *
   * A Cua action addresses elements and pixels inside one snapshot, and the
   * driver's registry keeps a single slot per window that the app's own
   * computer-use preview refills once per action. Keeping the view
   * here is what lets an action name the snapshot its index truly belongs to,
   * and re-anchor that reference onto a fresh one when the registry has moved
   * on. See `src/lib/cua-driver.ts`.
   */
  cuaViews: Map<string, CuaSnapshotView>
  /** Utilities created through the explicit setup-only management capability. */
  managedUtilities: UtilityDefinition[]
  /** Lazily created read-only diagnostics provider, shared by every turn. */
  diagnostics: CioDiagnosticsService | null
  /** Lazily derived once because a turn may issue several refined searches. */
  projectSearchTerms: Promise<Set<string>> | null
  /** This thread's utilities bank, restricted to utilities eligible this turn. */
  bank: Map<string, ThreadBankEntry>
  /** When this turn last re-read the registry for newly installed utilities. */
  eligibilityRefreshedAt: number
}

/**
 * One entry of the per-thread utilities bank: the durable bookkeeping of every
 * utility this thread has activated at least once. Deliberately tiny (id,
 * name, kind, description) so later turns can invoke the utility directly by
 * id and re-list its docs with cio_util_docs_lookup after compaction.
 */
/** Thread bank entries survive app restarts as one small JSON file per thread. */
export const THREAD_BANK_DIRECTORY = 'utility-banks'
export const THREAD_BANK_MAX_ENTRIES = 64
export const THREAD_BANK_DESCRIPTION_LIMIT = 400

/** Shortest gap between mid-turn eligibility refreshes. Installing forces one
 *  immediately, so the interval only bounds how often a chatty agent re-reads the
 *  registry while a human-paced install still lands on the next gateway call. */
export const ELIGIBILITY_REFRESH_INTERVAL_MS = 1_000

/** Bridge handler for one gateway route: receives state plus the parsed body. */
export type GatewayBridgeHandler = (
  state: TurnState,
  input: Record<string, unknown>
) => Promise<unknown>

/**
 * Provides one small, app-owned MCP gateway instead of eagerly injecting every
 * utility schema. Utility selection and use remain scoped to a single turn.
 */
export class UtilityOrchestrationService {
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  readonly units = buildUtilityOrchestrationServiceUnits(this)
  readonly registry: UtilityRegistryService
  readonly vault: SecretVault
  /** Install folders for scoped utilities; resolved on first use. */
  scopeFootprint: UtilityScopeFootprintService | null = null
  scopeFootprintResolved = false
  readonly turns = new Map<string, { state: TurnState; scriptPath: string; token: string }>()
  readonly turnIdsByToken = new Map<string, string>()
  gatewayServer: Server | null = null
  gatewayBaseUrl: string | null = null
  gatewayStarting: Promise<string> | null = null
  readonly bridgeHandlers: ReadonlyMap<string, GatewayBridgeHandler>
  /** Routes answered with a structured payload beside their content parts. */
  readonly structuredRoutes: ReadonlySet<string>
  cuaActivityListener: ((event: CuaOperationEvent) => void) | null = null
  /** Delivery-capable tools are discovered once per connection, including older drivers. */
  readonly backgroundInputTools = new WeakMap<McpClient, ReadonlySet<string>>()
  imageDescriptorExecutor: ImageDescriptorExecutor | null = null
  artifactExecutor: DesignCapabilityExecutor | null = null
  browserExecutor: BrowserUtilityExecutor | null = null
  designPreviewExecutor: DesignCapabilityExecutor | null = null
  designAssignmentExecutor: DesignCapabilityExecutor | null = null
  designMediaExecutor: DesignCapabilityExecutor | null = null
  mediaGenerationExecutor: DesignCapabilityExecutor | null = null
  videoPreviewExecutor: VideoCapabilityExecutor | null = null
  videoCaptureExecutor: VideoCapabilityExecutor | null = null
  /** The thread-scoped expert policy, shared with the design delegation executor. */
  expertSettings: ExpertSettingsService | null = null
  scopeToolExecutor: ScopeToolExecutor | null = null
  secretRequestExecutor: SecretRequestExecutor | null = null
  utilitySuggestionExecutor: UtilitySuggestionExecutor | null = null
  orchestrationExecutor: OrchestrationExecutor | null = null
  appControlExecutor: AppControlExecutor | null = null
  engineeringExecutor: EngineeringToolExecutor | null = null
  pawnExecutor: PawnToolExecutor | null = null
  /** How the app learns that this turn entered a design or video session. */
  authoredWorkSessionRecorder: AuthoredWorkSessionRecorder | null = null
  /** Serializes bank read-modify-write per thread so turns cannot clobber entries. */
  readonly bankWrites = new Map<string, Promise<void>>()
  constructor(
    readonly storage: StorageEngine,
    readonly database?: import('../database/database').Database,
    readonly cuaBridge = new CuaBridgeService(storage),
    /**
     * The one OAuth authorization service, shared with the Utilities page, so a
     * token a turn uses is a token the user authorized there. Absent in a
     * session that has no utility surface of its own.
     */
    readonly mcpOAuth: McpOAuthService | null = null
  ) {
    this.registry = new UtilityRegistryService(storage)
    this.vault = new SecretVault(storage)
    this.bridgeHandlers = this.buildBridgeHandlers()
    this.structuredRoutes = this.buildStructuredRoutes()
  }

  /**
   * Hybrid thread search, wired by the engine that owns the thread manager.
   *
   * The diagnostics tool is the one app capability every turn carries, so this
   * is how an agent reaches the user's other conversations: keyword and semantic
   * matching over titles and content, bounded by the caller's own timeout.
   */
  threadSearch: ((query: string) => Promise<ThreadSearchResult[]>) | null = null
  setThreadSearchProvider(
    provider: ((query: string) => Promise<ThreadSearchResult[]>) | null
  ): void {
    return this.units['capability-invoke'].setThreadSearchProvider(provider)
  }
  buildBridgeHandlers(): ReadonlyMap<string, GatewayBridgeHandler> {
    return this.units['orchestration'].buildBridgeHandlers()
  }
  buildStructuredRoutes(): ReadonlySet<string> {
    return this.units['orchestration'].buildStructuredRoutes()
  }
  setImageDescriptorExecutor(executor: ImageDescriptorExecutor | null): void {
    return this.units['gateway-endpoints'].setImageDescriptorExecutor(executor)
  }
  setArtifactExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['executors'].setArtifactExecutor(executor)
  }
  setBrowserExecutor(executor: BrowserUtilityExecutor | null): void {
    return this.units['executors'].setBrowserExecutor(executor)
  }
  setDesignPreviewExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['executors'].setDesignPreviewExecutor(executor)
  }
  setAuthoredWorkSessionRecorder(recorder: AuthoredWorkSessionRecorder | null): void {
    return this.units['orchestration'].setAuthoredWorkSessionRecorder(recorder)
  }
  setExpertSettings(settings: ExpertSettingsService | null): void {
    return this.units['orchestration'].setExpertSettings(settings)
  }
  setDesignAssignmentExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['executors'].setDesignAssignmentExecutor(executor)
  }
  setDesignMediaExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['executors'].setDesignMediaExecutor(executor)
  }
  setMediaGenerationExecutor(executor: DesignCapabilityExecutor | null): void {
    return this.units['executors'].setMediaGenerationExecutor(executor)
  }
  setVideoPreviewExecutor(executor: VideoCapabilityExecutor | null): void {
    return this.units['executors'].setVideoPreviewExecutor(executor)
  }
  setVideoCaptureExecutor(executor: VideoCapabilityExecutor | null): void {
    return this.units['executors'].setVideoCaptureExecutor(executor)
  }
  setScopeToolExecutor(executor: ScopeToolExecutor | null): void {
    return this.units['tool-catalog'].setScopeToolExecutor(executor)
  }
  setSecretRequestExecutor(executor: SecretRequestExecutor | null): void {
    return this.units['executors'].setSecretRequestExecutor(executor)
  }
  setUtilitySuggestionExecutor(executor: UtilitySuggestionExecutor | null): void {
    return this.units['capability-invoke'].setUtilitySuggestionExecutor(executor)
  }
  setOrchestrationExecutor(executor: OrchestrationExecutor | null): void {
    return this.units['executors'].setOrchestrationExecutor(executor)
  }
  setAppControlExecutor(executor: AppControlExecutor | null): void {
    return this.units['executors'].setAppControlExecutor(executor)
  }
  setEngineeringExecutor(executor: EngineeringToolExecutor | null): void {
    return this.units['executors'].setEngineeringExecutor(executor)
  }
  setPawnExecutor(executor: PawnToolExecutor | null): void {
    return this.units['executors'].setPawnExecutor(executor)
  }
  onCuaActivity(listener: (event: CuaOperationEvent) => void): void {
    return this.units['executors'].onCuaActivity(listener)
  }
  async startTurn(request: UtilityTurnRequest): Promise<UtilityTurnGateway> {
    return this.units['turn-runtime'].startTurn(request)
  }
  async dispose(): Promise<void> {
    return this.units['orchestration'].dispose()
  }
  hasSearched(gatewayId: string): boolean {
    return this.units['capability-invoke'].hasSearched(gatewayId)
  }
  hasActivatedOnDemand(gatewayId: string): boolean {
    return this.units['capability-invoke'].hasActivatedOnDemand(gatewayId)
  }
  managedUtilities(gatewayId: string): UtilityDefinition[] {
    return this.units['capability-invoke'].managedUtilities(gatewayId)
  }
  async deleteThreadBank(threadId: string): Promise<void> {
    return this.units['orchestration'].deleteThreadBank(threadId)
  }
  async applyRegistryChange(utilityId: string): Promise<void> {
    return this.units['orchestration'].applyRegistryChange(utilityId)
  }
}

/**
 * The key one window's remembered snapshot is filed under.
 *
 * A window is the driver's own scope for a snapshot: it refuses a `window_id`
 * that no longer exists, and a snapshot of one window never answers for
 * another, so the pid completes the key rather than defining it.
 */
export function cuaViewKey(pid: number, windowId: number): string {
  return `${pid}:${windowId}`
}

/** A gateway-authored refusal, in the same shape the driver refuses in. */
export function refusalResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * The utility a connection can be opened for, or the reason it cannot be.
 *
 * The two callers of `ensureMcpClient` both need this narrowing before they can
 * reach the connection path, so it lives here rather than being restated at each
 * of them.
 */
export function mcpCapableUtility(
  utility: UtilityDefinition
): UtilityDefinitionFor<'mcp'> | UtilityDefinitionFor<'computer_use'> {
  if (utility.kind !== 'mcp' && utility.kind !== 'computer_use') {
    throw new Error(`Utility kind "${utility.kind}" does not expose an MCP client`)
  }
  return utility
}

/**
 * The screen-point cursor one `get_agent_cursor_state` result reports, or null.
 *
 * The driver answers `structuredContent.position` with `{x, y}` in screen points
 * while the cursor is known, and with `null` before the session's cursor has
 * moved. Its refusals arrive as a resolved result carrying `isError`, so a
 * payload that has no point reads as "no position" rather than throwing. The
 * coordinates have to be real numbers: a payload with a missing one is not the
 * point `(0, 0)`.
 */
export function agentCursorPoint(result: unknown): { x: number; y: number } | null {
  if (typeof result !== 'object' || result === null) return null
  const structured = (result as Record<string, unknown>)['structuredContent']
  if (typeof structured !== 'object' || structured === null) return null
  const position = (structured as Record<string, unknown>)['position']
  if (typeof position !== 'object' || position === null) return null
  const x = (position as Record<string, unknown>)['x']
  const y = (position as Record<string, unknown>)['y']
  if (typeof x !== 'number' || typeof y !== 'number') return null
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
