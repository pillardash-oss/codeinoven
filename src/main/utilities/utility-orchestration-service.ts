import { randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type {
  ResolvedUtility,
  UtilityDefinition,
  UtilityDefinitionFor,
  McpUtilityConfig,
  UtilityKind,
  PermissionLevel
} from '../../lib/types'
import { DEFAULT_SCOPE_BUCKET_ID, UTILITY_KIND_VALUES } from '../../lib/types'
import { StorageEngine } from '../storage/storage-engine'
import { SecretVault } from '../storage/secret-vault'
import { APP_ADB_UTILITY_ID, APP_DESIGN_UTILITY_ID } from '../../lib/utility-ids'
import {
  APP_BROWSER_UTILITY_ID,
  APP_IMAGE_DESCRIPTOR_UTILITY_ID,
  APP_SCOPE_UTILITY_ID,
  UtilityRegistryService
} from './utility-registry-service'
import { CuaBridgeService, isCuaDaemonTransportFailure } from './cua-bridge-service'
import type { DesignSessionMode } from './cio-design-prompt'
import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME
} from '../../lib/gateway-tools'
import { SCOPE_CAPABILITY_SEARCH_QUERY } from '../../lib/scope-tool'
import { ADB_CAPABILITY_SEARCH_QUERY } from '../../lib/adb-skill'
import { DESIGN_CAPABILITY_SEARCH_QUERY, designCapabilityDocs } from '../../lib/design-skill'
import { designAssignmentsFromConfig } from '../../lib/design-assignments'
import { prototypeCdnPolicyFromConfig } from '../../lib/prototypes/prototype-cdn'
import { resultWithImageParts } from '../../lib/image-payload'
import { CioDiagnosticsService } from './cio-diagnostics-service'
import { ProjectRepo } from '../database/repositories/project-repo'
import { type McpClient } from '../agents/mcp-stdio-client'
import {
  WEB_TOOL_INPUT_SCHEMAS,
  WEB_TOOL_OUTPUT_SCHEMAS,
  executeWebTool,
  webSourceIndex
} from '../agents/web-tool-providers'
import {
  IMAGE_DESCRIPTOR_INPUT_SCHEMA,
  IMAGE_DESCRIPTOR_OUTPUT_SCHEMA,
  resolveImageEntries,
  type ImageDescriptorExecutor
} from '../providers/image-descriptor-provider'
import { budgetToolResult, DEFAULT_PROMPT_BUDGET } from '../../lib/prompt-budget'
import { gatewayHarnessTimeoutMs, type UtilityGatewayEndpoint } from '../../lib/gateway-timeout'
import { Logger } from '../system/logger'
import { UTILITY_EVENTS_LOG_FILE, dailyLogRelativePath } from '../system/log-paths'
import type { AgentSecretResolution } from './agent-secret-service'
import {
  BRAINSTORM_ALIGNMENT_UTILITY_ID,
  BRAINSTORM_ALIGNMENT_OPERATIONS,
  BRAINSTORM_ALIGNMENT_NOTE_LIMIT,
  brainstormAlignmentUtility
} from '../../lib/brainstorm/brainstorm-alignment'
import {
  ROUTINE_AUTHORING_UTILITY_ID,
  ROUTINE_AUTHORING_OPERATIONS,
  ROUTINE_AUTHORING_CHECKPOINT_LIMIT,
  routineAuthoringUtility
} from '../../lib/routine-authoring'
import type { ScopeToolContext } from '../workspaces/scope-tool-service'
import {
  matchesUtilityKinds,
  normalizeCapability,
  operationPid,
  projectTechnologyTerms,
  utilityProjectAffinityScore,
  utilitySearchScore
} from './utility-orchestration/utility-search'
import {
  type ThreadBankEntry,
  forgetUtility,
  reconcileActivated
} from './utility-orchestration/utility-turn-state'
import {
  BROWSER_UTILITY_TOOLS,
  DESIGN_UTILITY_TOOLS,
  BRIDGE_SCRIPT_PATH,
  buildCuaSessionId,
  buildUtilityGatewayScript,
  gatewayUtility
} from './utility-orchestration/utility-gateway-scripts'
import {
  optionalKinds,
  optionalNumber,
  optionalString,
  readJsonBody,
  recordValue,
  requiredDatabase,
  requiredString
} from './utility-orchestration/utility-input'
import { normalizeBundleDefinitions } from './utility-orchestration/utility-bundle-input'
import { RemoteMcpClient } from './utility-orchestration/remote-mcp-client'
import {
  connectMcpServer,
  credentialEnvironment as resolveCredentialEnvironment
} from './mcp-connection'

const CUA_UTILITY_ID = 'cio:cua-driver'

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
   * Whether this turn belongs to a design session the user opened with
   * `@cio-design`. A session promotes the app-owned design capability to an
   * active capability for the turn, so the playbook is already in context and
   * its preview operation is callable without a search and an activation.
   */
  designSession?: DesignSessionMode
  /** Present only for an active interview; the callback owns the exact note path/version. */
  saveBrainstormNotes?: (markdown: string) => Promise<{ path: string; version: number }>
  /**
   * Present only for a routine's Getting started interview; the callback owns
   * the checkpoint path and replaces its content.
   */
  saveRoutineCheckpoint?: (markdown: string) => Promise<{ path: string }>
  budgetContext: UtilityTurnBudgetContext
  attributeReinjectedResult: (attribution: UtilityResultAttribution) => void
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
  context: { projectId: string; threadId: string }
) => Promise<unknown>

/**
 * Runs one gateway invocation of the app-owned design capability for the turn
 * that made it. The app supplies one of these per operation group, because the
 * three halves have different owners: `preview` composes the loopback directory
 * preview with the in-app browser, `delegate` runs a prompt on the model the
 * user assigned to that design work, and `save-media` writes a generated asset
 * into the project as a file the design can reference.
 */
export type DesignCapabilityExecutor = (
  operation: string,
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string }
) => Promise<unknown>

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

interface TurnState {
  id: string
  request: UtilityTurnRequest
  eligible: Map<string, ResolvedUtility>
  activated: Map<string, ResolvedUtility>
  clients: Map<string, McpClient>
  attributionSequence: number
  /** True once the agent has called the app utility-search tool this turn. */
  searched: boolean
  /** Session ids created for Cua utilities so cursor state is turn-scoped. */
  cuaSessionIds: Map<string, string>
  /** Utilities created through the explicit setup-only management capability. */
  managedUtilities: UtilityDefinition[]
  /** Lazily created read-only diagnostics provider for explicit @cio-utility turns. */
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
const THREAD_BANK_DIRECTORY = 'utility-banks'
const THREAD_BANK_MAX_ENTRIES = 64
const THREAD_BANK_DESCRIPTION_LIMIT = 400

/** Shortest gap between mid-turn eligibility refreshes. Installing forces one
 *  immediately, so the interval only bounds how often a chatty agent re-reads the
 *  registry while a human-paced install still lands on the next gateway call. */
const ELIGIBILITY_REFRESH_INTERVAL_MS = 1_000

/** Bridge handler for one gateway route: receives state plus the parsed body. */
type GatewayBridgeHandler = (state: TurnState, input: Record<string, unknown>) => Promise<unknown>

/**
 * Provides one small, app-owned MCP gateway instead of eagerly injecting every
 * utility schema. Utility selection and use remain scoped to a single turn.
 */
export class UtilityOrchestrationService {
  private readonly registry: UtilityRegistryService
  private readonly vault: SecretVault
  private readonly turns = new Map<
    string,
    { state: TurnState; scriptPath: string; token: string }
  >()
  private readonly turnIdsByToken = new Map<string, string>()
  private gatewayServer: Server | null = null
  private gatewayBaseUrl: string | null = null
  private gatewayStarting: Promise<string> | null = null
  private readonly bridgeHandlers: ReadonlyMap<string, GatewayBridgeHandler>
  private cuaActivityListener: ((event: CuaOperationEvent) => void) | null = null
  private imageDescriptorExecutor: ImageDescriptorExecutor | null = null
  private browserExecutor: BrowserUtilityExecutor | null = null
  private designPreviewExecutor: DesignCapabilityExecutor | null = null
  private designAssignmentExecutor: DesignCapabilityExecutor | null = null
  private designMediaExecutor: DesignCapabilityExecutor | null = null
  private scopeToolExecutor: ScopeToolExecutor | null = null
  private secretRequestExecutor: SecretRequestExecutor | null = null
  /** Serializes bank read-modify-write per thread so turns cannot clobber entries. */
  private readonly bankWrites = new Map<string, Promise<void>>()
  constructor(
    private readonly storage: StorageEngine,
    private readonly database?: import('../database/database').Database,
    private readonly cuaBridge = new CuaBridgeService(storage)
  ) {
    this.registry = new UtilityRegistryService(storage)
    this.vault = new SecretVault(storage)
    this.bridgeHandlers = this.buildBridgeHandlers()
  }

  /** Derive the route → handler map from `GATEWAY_TOOLS`, failing fast if a
   *  catalog tool has no bridge handler so drift surfaces at startup, not at
   *  runtime. */
  private buildBridgeHandlers(): ReadonlyMap<string, GatewayBridgeHandler> {
    const handlers = new Map<string, GatewayBridgeHandler>()
    for (const tool of GATEWAY_TOOLS) {
      const handler = this.bridgeHandlerFor(tool.name)
      if (!handler) {
        throw new Error(`Utility gateway tool "${tool.name}" has no bridge handler`)
      }
      handlers.set(tool.route, handler)
    }
    return handlers
  }

  private bridgeHandlerFor(name: string): GatewayBridgeHandler | null {
    switch (name) {
      case UTILITY_SEARCH_TOOL_NAME:
        return (state, input) => this.search(state, input)
      case UTILITY_ACTIVATE_TOOL_NAME:
        return (state, input) => this.activate(state, input)
      case UTILITY_INVOKE_TOOL_NAME:
        return (state, input) => this.invoke(state, input)
      case UTILITY_DOCS_TOOL_NAME:
        return (state, input) => this.docsLookup(state, input)
      case UTILITY_MANAGE_TOOL_NAME:
        return (state, input) => this.manage(state, input)
      case UTILITY_DIAGNOSTICS_TOOL_NAME:
        return (state, input) => this.runDiagnostics(state, input)
      case ASK_SECRET_TOOL_NAME:
        return (state, input) => this.askSecret(state, input)
      default:
        return null
    }
  }

  /**
   * Register the executor that runs a vision model for `image_descriptor`
   * utilities. The chat engine supplies it because it owns driver sessions
   * and the resolved image-descriptor model selection.
   */
  setImageDescriptorExecutor(executor: ImageDescriptorExecutor | null): void {
    this.imageDescriptorExecutor = executor
  }

  setBrowserExecutor(executor: BrowserUtilityExecutor | null): void {
    this.browserExecutor = executor
  }

  /**
   * Register the executor behind the app-owned `cio:design` capability's
   * `preview` operation. The design pass itself is text; what the app adds is
   * the ability to serve the folder it produced and show it in the thread's
   * browser tab.
   */
  setDesignPreviewExecutor(executor: DesignCapabilityExecutor | null): void {
    this.designPreviewExecutor = executor
  }

  /**
   * Register the executor behind the design capability's `delegate` operation,
   * which runs one prompt on the model the user assigned to a piece of design
   * work. The chat engine supplies it because it owns drivers, accounts and the
   * resolved project path, and because the assignment is a user decision the
   * app must never make on the agent's behalf.
   */
  setDesignAssignmentExecutor(executor: DesignCapabilityExecutor | null): void {
    this.designAssignmentExecutor = executor
  }

  /**
   * Register the executor behind the design capability's `save-media`
   * operation, which writes a generated image, video or sound file into the
   * project so the design references a file rather than a link that expires.
   * The app supplies it because it owns the project root the file lands in.
   */
  setDesignMediaExecutor(executor: DesignCapabilityExecutor | null): void {
    this.designMediaExecutor = executor
  }

  /**
   * Register the executor behind the app-owned `cio:scope` utility. Scope and
   * worktree management is an ordinary app-owned utility rather than a listed
   * tool: most turns never touch a worktree, and a turn that does not must not
   * carry the capability's contract in its context. The chat engine supplies the
   * executor because it owns the thread's scope, project root and permission
   * tier.
   */
  setScopeToolExecutor(executor: ScopeToolExecutor | null): void {
    this.scopeToolExecutor = executor
  }

  /**
   * Register the executor behind the app-owned `cio_ask_secret` gateway tool.
   * Secret collection is an app capability rather than a utility operation: the
   * agent asks, the user pastes into the card, and the value never travels back
   * through the tool result. The chat engine supplies the executor because it
   * owns pending questions, the vault and the utility registry.
   */
  setSecretRequestExecutor(executor: SecretRequestExecutor | null): void {
    this.secretRequestExecutor = executor
  }

  /**
   * Register a listener invoked for every computer-use operation an agent
   * performs. The listener sees the whole picture, including desktop-scoped
   * operations that name no pid: the PiP monitor needs a pid to track a window,
   * while a thread row only needs to know the thread is using the computer.
   */
  onCuaActivity(listener: (event: CuaOperationEvent) => void): void {
    this.cuaActivityListener = listener
  }

  /** True when the harness already performs computer-use, so the Cua Driver MCP
   *  utility must stay hidden from it. */
  private hasNativeComputerUse(request: UtilityTurnRequest): boolean {
    return request.nativeCapabilities.map(normalizeCapability).includes('computer_use')
  }

  /** Whether the executing model sees images itself, so the image descriptor
   *  must stay out of this turn's reachable utilities. A capability lookup that
   *  fails keeps the descriptor reachable rather than hiding a capability the
   *  turn may legitimately need. */
  private async executingModelVisionCapable(request: UtilityTurnRequest): Promise<boolean> {
    if (!request.resolveExecutingModelVisionCapable) return false
    try {
      return await request.resolveExecutingModelVisionCapable()
    } catch (error) {
      Logger.dev('Executing-model vision capability lookup failed:', error)
      return false
    }
  }

  /**
   * Resolve the utilities one turn may reach, from the registry plus the
   * interview-bound brainstorm capability. Shared by turn start and the mid-turn
   * refresh, so a utility installed while the turn runs becomes searchable and
   * activatable without waiting for the next turn, and the two paths cannot drift.
   */
  private async resolveEligibleUtilities(request: UtilityTurnRequest): Promise<ResolvedUtility[]> {
    let eligible = await this.registry.resolve({
      harnessId: request.harnessId,
      projectId: request.projectId,
      threadId: request.threadId,
      nativeCapabilities: request.nativeCapabilities,
      includeOnDemand: true
    })
    // These capabilities are bound to the live interview, never installed globally.
    eligible = eligible.filter(
      ({ utility }) =>
        utility.id !== BRAINSTORM_ALIGNMENT_UTILITY_ID &&
        utility.id !== ROUTINE_AUTHORING_UTILITY_ID
    )
    if (request.saveBrainstormNotes) {
      eligible.push(
        brainstormAlignmentUtility(request.harnessId, request.projectId, request.threadId)
      )
    }
    if (request.saveRoutineCheckpoint) {
      eligible.push(routineAuthoringUtility(request.harnessId, request.projectId, request.threadId))
    }
    if (this.hasNativeComputerUse(request)) {
      // Existing registries may predate the computer-use capability binding,
      // so enforce the native preference by stable utility identity too.
      eligible = eligible.filter(({ utility }) => utility.id !== CUA_UTILITY_ID)
    }
    // A model that can already see images must never see the image descriptor:
    // announcing it invites the model to call it, which is exactly the
    // false-positive report path the app's vision record exists to prevent.
    if (await this.executingModelVisionCapable(request)) {
      eligible = eligible.filter(({ utility }) => utility.kind !== 'image_descriptor')
    }
    // Stamp the thread's permission level onto the Cua Driver MCP utility so
    // its launch environment always matches how this thread runs tools.
    for (const entry of eligible) {
      if (entry.utility.id !== 'cio:cua-driver') continue
      const config = entry.utility.config as McpUtilityConfig
      config.environment = {
        ...config.environment,
        ...(request.permissionLevel === 'full_access'
          ? { CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: 'true' }
          : { CUA_DRIVER_DISABLE_UNRESTRICTED: 'true' })
      }
    }
    return eligible
  }

  async startTurn(request: UtilityTurnRequest): Promise<UtilityTurnGateway> {
    const id = randomUUID()
    const eligible = await this.resolveEligibleUtilities(request)
    if (!this.hasNativeComputerUse(request)) {
      // Resolved once per turn: it inspects the installed Cua Driver binary, which
      // is far too expensive for the mid-turn refresh below to repeat.
      const cuaUtility = await this.cuaBridge.resolveUtility(
        request.harnessId,
        request.permissionLevel
      )
      if (cuaUtility) eligible.push(cuaUtility)
    }
    const imageDescriptorEligible = eligible.some(
      ({ utility }) => utility.kind === 'image_descriptor'
    )
    // MCP servers are always `on_demand` and always reached through the gateway, so
    // they never appear in the native `always` overlay. Keep the kind check even though
    // the registry normalizes the activation: a legacy entry read straight from disk
    // must not sneak into a harness launch. See normalizeActivation in the registry.
    const always = eligible.filter(
      ({ utility }) => utility.activation === 'always' && utility.kind !== 'mcp'
    )
    // A design session was opened by the user, so the design capability is active
    // from the first token: the playbook travels with the turn and the preview
    // operation is callable at once. Its instructions are resolved from live
    // settings here for the same reason activation resolves them, because the
    // seeded copy cannot know which CDN origins the user has approved.
    if (request.designSession && request.designSession !== 'off') {
      const design = eligible.find(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)
      if (design && !always.some(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)) {
        const instructions = await this.designPlaybook()
        always.push({
          binding: design.binding,
          utility: { ...design.utility, kind: 'skill', config: { instructions } }
        })
      }
    }
    const hasOnDemand = eligible.some(({ utility }) => utility.activation === 'on_demand')
    // The app-owned scope utility is advertised as a one-line pointer, never as
    // a schema: whether it is offered at all is the registry's call, so
    // disabling it in Utilities removes the pointer too.
    const hasScopeCapability = eligible.some(({ utility }) => utility.id === APP_SCOPE_UTILITY_ID)
    // The Android device skill is advertised the same way, as a pointer rather
    // than a schema. It is knowledge an agent applies with its own shell, so the
    // only thing a turn needs from the app is to know the playbook exists.
    const hasAdbCapability = eligible.some(({ utility }) => utility.id === APP_ADB_UTILITY_ID)
    // The design capability is advertised the same way: the app wants an agent
    // that is about to design an interface to know the guidance and the preview
    // exist, without carrying the design pass in every turn's context.
    const hasDesignCapability = eligible.some(({ utility }) => utility.id === APP_DESIGN_UTILITY_ID)
    const gatewayTools = GATEWAY_TOOLS.filter(({ name }) => {
      if (name === UTILITY_MANAGE_TOOL_NAME || name === UTILITY_DIAGNOSTICS_TOOL_NAME) {
        return request.allowManagement === true
      }
      // Asking for a secret is an app capability rather than a utility
      // operation, and it never needs a secret to be installed: it is offered on
      // every turn that carries the gateway at all, plus every explicit setup
      // turn, where the capability being installed is what needs the value.
      if (name === ASK_SECRET_TOOL_NAME) return hasOnDemand || request.allowManagement === true
      return hasOnDemand
    })
    if (gatewayTools.length === 0) {
      return {
        id,
        resolvedUtilities: always,
        instructions: '',
        directInstructions: '',
        directEndpoint: null,
        managementEnabled: false,
        cleanup: async () => undefined
      }
    }
    const state: TurnState = {
      id,
      request,
      eligible: new Map(eligible.map((entry) => [entry.utility.id, entry])),
      activated: new Map(always.map((entry) => [entry.utility.id, entry])),
      clients: new Map(),
      attributionSequence: 0,
      searched: false,
      cuaSessionIds: new Map(),
      managedUtilities: [],
      diagnostics: null,
      projectSearchTerms: null,
      bank: new Map(),
      eligibilityRefreshedAt: Date.now()
    }
    // Surface the thread's durable utilities bank so later turns can go
    // straight to usage: only banked utilities that are still eligible this
    // turn are advertised (the rest would fail the eligibility gate anyway).
    const bankEntries = await this.loadThreadBank(request.threadId)
    for (const entry of bankEntries) {
      if (state.eligible.has(entry.id)) state.bank.set(entry.id, entry)
    }
    const bridgeUrl = await this.ensureGatewayServer()
    const token = randomBytes(32).toString('hex')
    const scriptPath = `${BRIDGE_SCRIPT_PATH}.${id}.mjs`
    await this.storage.writeRaw(scriptPath, buildUtilityGatewayScript(gatewayTools))
    this.turns.set(id, { state, scriptPath, token })
    this.turnIdsByToken.set(token, id)

    const gateway = gatewayUtility(request, this.storage.resolve(scriptPath), bridgeUrl, token)
    const toolInstructions = [
      `App-managed utilities are available as first-class tools in this session: call ${UTILITY_SEARCH_TOOL_NAME} to search, ${UTILITY_ACTIVATE_TOOL_NAME} to activate, and ${UTILITY_INVOKE_TOOL_NAME} to invoke. The tools hold the turn-scoped gateway credentials internally   never call the gateway through the shell, and never print or persist tokens.`,
      `Never ask the user to paste a secret into chat. When you need one (an API key, token, or password), call ${ASK_SECRET_TOOL_NAME} with one entry per secret and a short title; you receive the environment variable name   and, for a value you interpolate in a shell command, a 0600 secret_path you read with \`"$(cat secret_path)"\`   never the value itself.`,
      ...(hasScopeCapability
        ? [
            `The app-owned scope and Git-worktree capability (utility \`${APP_SCOPE_UTILITY_ID}\`) is deliberately not in your tool list. Only when the user explicitly asks you to work in a separate worktree: search with ${UTILITY_SEARCH_TOOL_NAME} (query "${SCOPE_CAPABILITY_SEARCH_QUERY}"), activate the result, then invoke it with ${UTILITY_INVOKE_TOOL_NAME}. Never create a worktree on your own initiative, and never run raw \`git worktree add\`.`
          ]
        : []),
      ...(hasAdbCapability
        ? [
            `The app-owned Android device skill (utility \`${APP_ADB_UTILITY_ID}\`) is knowledge, not a tool, and it is not in your tool list. When a task involves an Android device or emulator, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${ADB_CAPABILITY_SEARCH_QUERY}") and activate the result before you probe the device by hand: it carries the verified recipes, the traps, and the evidence standard. Load it again with ${UTILITY_DOCS_TOOL_NAME} if it leaves your context. It is a baseline, not an authority: if the project or your harness already provides its own Android or adb skill or runbook, follow that one and use this only for what it does not cover.`
          ]
        : []),
      ...(hasDesignCapability
        ? [
            `The app-owned design capability (utility \`${APP_DESIGN_UTILITY_ID}\`) is knowledge plus three operations, and it is not in your tool list. When the work is to design or prototype an interface in HTML, search with ${UTILITY_SEARCH_TOOL_NAME} (query "${DESIGN_CAPABILITY_SEARCH_QUERY}") and activate the result: it carries the design pass, the folder a design belongs in, a \`preview\` operation that serves that folder and opens it in this thread's browser tab, a \`delegate\` operation that runs the model the user assigned to a named piece of design work, and a \`save-media\` operation that saves a generated image, video or sound file into the project as a file the design can reference. It is a baseline, not an authority: where the project or the user's own design skill states a design language, follow that one.`
          ]
        : []),
      ...(hasOnDemand
        ? [
            "A utility you activate is registered in this thread's utilities bank for the whole thread lifecycle: in later turns you can invoke it directly with " +
              UTILITY_INVOKE_TOOL_NAME +
              ' and its id, no re-activation needed. If context compaction dropped its capability docs, re-list them with ' +
              UTILITY_DOCS_TOOL_NAME +
              ' (accepts only the utility id). MCP clients are reconnected per turn as needed, so direct reuse costs nothing until you actually invoke.',
            ...(state.bank.size > 0
              ? [
                  `Thread utilities bank (registered in earlier turns; invoke directly with ${UTILITY_INVOKE_TOOL_NAME}): ${[
                    ...state.bank.values()
                  ]
                    .map(
                      (entry) => `${entry.id} (${entry.kind}) ${entry.name} — ${entry.description}`
                    )
                    .join('; ')}`
                ]
              : []),
            'A search result reports an explicit `notFound` boolean and may return project-aware candidates (`matchType: "candidates"`) to evaluate semantically. Before concluding that any capability (MCP, skill, tool, utility) is unavailable or does not exist, call ' +
              UTILITY_SEARCH_TOOL_NAME +
              ' first; only conclude unavailability when the result reports notFound:true. Never treat "the tools are not exposed in this session" as proof of absence. If you already know an eligible utility id, activate it directly without searching first.',
            ...(imageDescriptorEligible
              ? [
                  'Describe images: search for the image descriptor utility, activate its id, then invoke it with operation "describe" and input {"images":[{"id":"image-1","source":"path-or-url","type":"path"}]}.'
                ]
              : [])
          ]
        : []),
      ...(request.allowManagement
        ? [
            `Install a validated utility bundle with ${UTILITY_MANAGE_TOOL_NAME} (action install_bundle). Never include credential or secret values in the bundle: install the secret-free definition, then collect each value with ${ASK_SECRET_TOOL_NAME} (pass the installed id as utility_id and the variable the server reads as environment_variable), and otherwise tell the user to add them through Utilities.`,
            `App diagnostics are available with ${UTILITY_DIAGNOSTICS_TOOL_NAME} (read-only: lookup_thread, search_threads, read_messages, read_log, list_schema, query_sql).`
          ]
        : [])
    ].join('\n')
    await this.audit(state, 'turn.started', {
      eligibleUtilityIds: eligible.map(({ utility }) => utility.id),
      alwaysUtilityIds: always.map(({ utility }) => utility.id)
    })

    let cleanupPromise: Promise<void> | null = null
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= this.cleanupTurn(id)
      await cleanupPromise
    }
    return {
      id,
      resolvedUtilities: [...always, gateway],
      instructions: toolInstructions,
      directInstructions: toolInstructions,
      directEndpoint: {
        url: bridgeUrl,
        token,
        timeoutMs: gatewayHarnessTimeoutMs((await this.storage.getConfig()).questionTimeoutMs)
      },
      managementEnabled: request.allowManagement === true,
      cleanup
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.turns.keys()].map((id) => this.cleanupTurn(id)))
    await this.closeGatewayServer()
  }

  /** Whether the agent has called the app utility-search tool at least once this turn. */
  hasSearched(gatewayId: string): boolean {
    return this.turns.get(gatewayId)?.state.searched === true
  }

  /** Whether the agent directly activated an on-demand utility this turn. */
  hasActivatedOnDemand(gatewayId: string): boolean {
    const state = this.turns.get(gatewayId)?.state
    return (
      state !== undefined &&
      [...state.activated.values()].some(({ utility }) => utility.activation === 'on_demand')
    )
  }

  /** Snapshot of utilities installed by an explicit setup turn. */
  managedUtilities(gatewayId: string): UtilityDefinition[] {
    return structuredClone(this.turns.get(gatewayId)?.state.managedUtilities ?? [])
  }

  // ─── Thread utilities bank — durable per-thread bookkeeping ─────────────

  /** Bank file path for one thread; rejects anything path-like. */
  private bankPath(threadId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(threadId)) {
      throw new Error('Invalid thread id for the utilities bank')
    }
    return `${THREAD_BANK_DIRECTORY}/${threadId}.json`
  }

  /** Load the persisted bank for one thread; corrupt or missing files read as empty. */
  private async loadThreadBank(threadId: string): Promise<ThreadBankEntry[]> {
    try {
      const raw = await this.storage.readRaw(this.bankPath(threadId))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .flatMap((value: unknown) => {
          if (typeof value !== 'object' || value === null) return []
          const record = value as Record<string, unknown>
          const id = record['id']
          const name = record['name']
          const kind = record['kind']
          const description = record['description']
          if (
            typeof id !== 'string' ||
            typeof name !== 'string' ||
            typeof kind !== 'string' ||
            !UTILITY_KIND_VALUES.includes(kind as UtilityKind) ||
            typeof description !== 'string'
          ) {
            return []
          }
          return [
            {
              id,
              name,
              kind: kind as UtilityKind,
              description: description.slice(0, THREAD_BANK_DESCRIPTION_LIMIT)
            }
          ]
        })
        .slice(0, THREAD_BANK_MAX_ENTRIES)
    } catch (error) {
      Logger.dev('Thread utilities bank could not be read:', error)
      return []
    }
  }

  /** Persist the bank for one thread; serialized per thread to avoid clobbering. */
  private async saveThreadBank(threadId: string, entries: ThreadBankEntry[]): Promise<void> {
    const previous = this.bankWrites.get(threadId) ?? Promise.resolve()
    const next = previous
      .then(() => this.storage.writeRaw(this.bankPath(threadId), JSON.stringify(entries)))
      .catch((error: unknown) => Logger.dev('Thread utilities bank write failed:', error))
    this.bankWrites.set(threadId, next)
    await next
  }

  /**
   * Record one utility in its thread's bank the first time it is activated.
   * Transient per-turn capabilities (the gateway itself, interview-bound
   * alignment notes, and the getting-started checkpoint) are never banked.
   */
  private async registerThreadBankEntry(
    state: TurnState,
    utility: UtilityDefinition
  ): Promise<void> {
    if (
      utility.id.startsWith('cio:utility-gateway:') ||
      utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID ||
      utility.id === ROUTINE_AUTHORING_UTILITY_ID
    ) {
      return
    }
    const threadId = state.request.threadId
    const bankEntry: ThreadBankEntry = {
      id: utility.id,
      name: utility.name,
      kind: utility.kind,
      description: utility.description.slice(0, THREAD_BANK_DESCRIPTION_LIMIT)
    }
    // Register the entry for this turn too, so a search later in the same turn
    // already reports the utility it just activated as banked.
    state.bank.set(utility.id, bankEntry)
    const entries = await this.loadThreadBank(threadId)
    if (entries.some((entry) => entry.id === utility.id)) return
    entries.push(bankEntry)
    await this.saveThreadBank(threadId, entries.slice(-THREAD_BANK_MAX_ENTRIES))
  }

  /** Drop one thread's bank; called when the thread itself is deleted. */
  async deleteThreadBank(threadId: string): Promise<void> {
    try {
      await this.storage.remove(this.bankPath(threadId))
    } catch {
      // A missing file is the desired end state; nothing to report.
    }
  }

  private async manage(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    if (state.request.allowManagement !== true) {
      throw new Error('Utility management is not enabled for this turn')
    }
    if (input['action'] !== 'install_bundle') {
      throw new TypeError('Utility management action is invalid')
    }
    const definitions = normalizeBundleDefinitions(input['bundle'])
    const outcomes = await this.registry.installMany(definitions, { consolidate: true })
    state.managedUtilities.push(...outcomes.map((outcome) => outcome.utility))
    // Hot reload: make what this turn just installed reachable by the next search
    // or activation in the same turn, without waiting for a reload.
    await this.refreshEligible(state, { force: true })
    await this.audit(state, 'utility.managed', {
      action: 'install_bundle',
      utilityIds: outcomes.map((outcome) => outcome.utility.id),
      updatedUtilityIds: outcomes
        .filter((outcome) => outcome.action === 'updated')
        .map((outcome) => outcome.utility.id),
      removedUtilityIds: outcomes.flatMap((outcome) => outcome.removed.map(({ id }) => id))
    })
    // Reinstalling is reported apart from installing: the agent must not claim a
    // second install when the bundle replaced what was already there.
    const describe = (outcome: (typeof outcomes)[number]) => ({
      id: outcome.utility.id,
      kind: outcome.utility.kind,
      name: outcome.utility.name
    })
    return {
      installed: outcomes.filter((outcome) => outcome.action === 'installed').map(describe),
      updated: outcomes.filter((outcome) => outcome.action === 'updated').map(describe),
      removed: outcomes.flatMap((outcome) => outcome.removed)
    }
  }

  /** Project id → name map used to label diagnostic thread results. */
  private projectNames(): Map<string, string> {
    if (!this.database) return new Map()
    try {
      const projects = new ProjectRepo(this.database).list()
      return new Map(projects.map((project) => [project.id, project.name]))
    } catch {
      return new Map()
    }
  }

  /**
   * App-owned scope and worktree management for the calling thread, reached
   * through the gateway's invoke route. The chat engine owns the thread's
   * scope, project root and permission tier, so the executor receives them
   * instead of re-deriving them here.
   */
  private async runScopeTool(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const execute = this.scopeToolExecutor
    if (!execute) {
      throw new Error(
        'Scope management is unavailable in this session. Ask the user to manage scopes from the project board.'
      )
    }
    const request = state.request
    const action = typeof input['action'] === 'string' ? input['action'] : 'unknown'
    // Audited without paths or arguments: that a turn reached for scope
    // management is the durable fact, the scope contents are user data.
    await this.audit(state, 'scope.tool', {
      action,
      confirmation: input['confirm'] === true
    })
    return await execute(input, {
      projectId: request.projectId,
      scopeBucketId: request.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID,
      threadId: request.threadId,
      threadTitle: request.threadTitle ?? '',
      permissionLevel: request.permissionLevel
    })
  }

  /**
   * Collect one or more secrets from the user on the agent's behalf.
   *
   * The executor owns the card, the waiting and the storing; this handler owns
   * the tool contract. It returns the environment variable names   plus the
   * owner-only file paths for plain secrets   and never a value. The reserved
   * `environment` field is attached only for a transport that applies it to its
   * own process, and every MCP transport strips it before the result reaches a
   * model.
   */
  private async askSecret(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const executor = this.secretRequestExecutor
    if (!executor) throw new Error('Secret collection is unavailable in this deployment')
    const resolution = await executor(input, {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    })
    const sharedNote = `Each value is stored in the encrypted device vault. Reference it only at its target: \`$ENVIRONMENT_VARIABLE\` in a command, or \`"$(cat secret_path)"\` for a value you interpolate. Never print, echo, log, or read a secret, and never paste one into chat.`
    const secretEntries = resolution.secrets.map((secret) => ({
      label: secret.label,
      environment_variable: secret.environmentVariable,
      ...(secret.secretPath ? { secret_path: secret.secretPath } : {}),
      ...(secret.boundUtilityId ? { bound_to_utility: secret.boundUtilityId } : {}),
      ...(secret.reusedFrom ? { reused_from: secret.reusedFrom } : {})
    }))
    const result: Record<string, unknown> =
      resolution.status === 'dismissed'
        ? {
            status: 'dismissed',
            message:
              'The user dismissed the secret request without providing a value. Continue without it, and ask again only if the secret is essential.'
          }
        : resolution.status === 'alternative'
          ? {
              status: 'alternative',
              message:
                'The user answered with an instruction instead of a value. This is an answer, not a dismissal: do not ask for the same secret again in this turn. Follow the instruction and continue.',
              user_instruction: resolution.alternative,
              secrets: secretEntries,
              ...(resolution.unresolved?.length
                ? {
                    unresolved_environment_variables: resolution.unresolved,
                    unresolved_note:
                      'Nothing was exposed for these names. Continue with the user instruction. If one of them is already defined in your own environment, use it directly and never print, echo, or log it; otherwise take a different route or say plainly what is missing.'
                  }
                : {}),
              note: sharedNote
            }
          : {
              status: 'set',
              message: 'Secret set, you may proceed.',
              secrets: secretEntries,
              note: sharedNote
            }
    // A reused value must reach the session environment exactly like a pasted
    // one, which is what a user answering "this key was already supplied" needs.
    if (input['apply_environment'] !== true || resolution.secrets.length === 0) return result
    // Only an in-process gateway transport asks for this, and it applies the map
    // to its own session environment before the result is shown to the model.
    return {
      ...result,
      environment: Object.fromEntries(
        resolution.secrets.map((secret) => [secret.environmentVariable, secret.value])
      )
    }
  }

  /** Read-only app diagnostics, available only on explicit @cio-utility turns. */
  private async runDiagnostics(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    if (state.request.allowManagement !== true) {
      throw new Error(
        'App diagnostics require an explicit @cio-utility turn   tell the user to re-send their request starting with @cio-utility.'
      )
    }
    state.diagnostics ??= new CioDiagnosticsService(requiredDatabase(this.database), () =>
      this.projectNames()
    )
    const diagnostics = state.diagnostics
    const action = input['action']
    if (action === 'lookup_thread') {
      const query = requiredString(input['query'], 'query', 300)
      return diagnostics.lookupThread(query)
    }
    if (action === 'search_threads') {
      const query = requiredString(input['query'], 'query', 300)
      return { threads: await diagnostics.searchThreads(query) }
    }
    if (action === 'read_messages') {
      const threadId = requiredString(input['thread_id'], 'thread_id', 128)
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 40
      return {
        threadId,
        messages: await diagnostics.loadThreadMessages(threadId, limit)
      }
    }
    if (action === 'read_log') {
      const file = requiredString(input['file'], 'file', 120)
      const level = typeof input['level'] === 'string' ? input['level'] : undefined
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 100
      return diagnostics.readLog(file, { level, limit })
    }
    if (action === 'list_schema') {
      const table = typeof input['table'] === 'string' ? input['table'] : undefined
      return diagnostics.listSchema(table)
    }
    if (action === 'query_sql') {
      const sql = requiredString(input['sql'], 'sql', 4_000)
      const params = Array.isArray(input['params']) ? input['params'] : []
      return diagnostics.runQuery(sql, params)
    }
    throw new TypeError('Diagnostics action is invalid')
  }

  private async cleanupTurn(id: string): Promise<void> {
    const turn = this.turns.get(id)
    if (!turn) return
    this.turns.delete(id)
    this.turnIdsByToken.delete(turn.token)
    await this.endComputerUseSessions(turn.state)
    await Promise.allSettled([...turn.state.clients.values()].map((client) => client.close()))
    // Last, so the claim covers the clients it was taken for: an unrestricted
    // daemon is stopped here once nothing needs it any more.
    await this.cuaBridge.releaseDaemonClaim(turn.state.id)
    await this.storage.remove(turn.scriptPath)
    await this.audit(turn.state, 'turn.cleaned', {
      activatedUtilityIds: [...turn.state.activated.keys()]
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const authorization = request.headers.authorization
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
      const turnId = this.turnIdsByToken.get(token)
      const state = turnId ? this.turns.get(turnId)?.state : undefined
      if (request.method !== 'POST' || !state || !request.url) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      const input = await readJsonBody(request)
      const handler = this.bridgeHandlers.get(request.url)
      if (!handler) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      const result = await handler(state, input)
      this.respond(response, 200, result)
    } catch (error) {
      this.respond(response, 400, {
        error: error instanceof Error ? error.message : 'Utility gateway request failed'
      })
    }
  }

  /**
   * All utility turns share one loopback listener. Per-turn bearer capabilities
   * select isolated state; opening another port is never part of starting a turn.
   */
  private async ensureGatewayServer(): Promise<string> {
    if (this.gatewayBaseUrl) return this.gatewayBaseUrl
    if (this.gatewayStarting) return this.gatewayStarting
    const starting = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response)
      })
      const fail = (error: Error): void => {
        server.close()
        reject(error)
      }
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail)
        const address = server.address()
        if (!address || typeof address === 'string') {
          fail(new Error('Utility gateway could not bind to loopback'))
          return
        }
        this.gatewayServer = server
        this.gatewayBaseUrl = `http://127.0.0.1:${address.port}`
        resolve(this.gatewayBaseUrl)
      })
    })
    this.gatewayStarting = starting
    try {
      return await starting
    } finally {
      if (this.gatewayStarting === starting) this.gatewayStarting = null
    }
  }

  // Keep the single listener for the application lifetime. Turn capabilities
  // still retire independently; idle listener shutdown must not race startup.
  private async closeGatewayServer(): Promise<void> {
    const server = this.gatewayServer
    this.gatewayServer = null
    this.gatewayBaseUrl = null
    this.gatewayStarting = null
    if (!server) return
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
  }

  /**
   * Re-read the registry for the current turn so a utility installed or removed
   * while the turn is running is visible to the very next gateway call instead of
   * only after a reload. Rate-limited because a chatty agent may search several
   * times per second, and forced right after this turn installs something.
   */
  private async refreshEligible(
    state: TurnState,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const now = Date.now()
    if (
      options.force !== true &&
      now - state.eligibilityRefreshedAt < ELIGIBILITY_REFRESH_INTERVAL_MS
    ) {
      return
    }
    state.eligibilityRefreshedAt = now
    const next = new Map(
      (await this.resolveEligibleUtilities(state.request)).map((entry) => [entry.utility.id, entry])
    )
    // The Cua Driver entry came from inspecting the installed binary, so keep that
    // resolution rather than paying installation discovery again.
    const cuaUtility = state.eligible.get(CUA_UTILITY_ID)
    if (cuaUtility && !next.has(CUA_UTILITY_ID)) next.set(CUA_UTILITY_ID, cuaUtility)
    state.eligible = next
    // A refresh lists only what is eligible now, so an activated utility missing
    // from it was disabled, deleted, or moved out of scope while this turn ran.
    // Dropping it here is what lands that change mid-turn: the call the transcript
    // already made has returned, and keeping the id alive on its behalf was what
    // made a disabled capability stay callable until the user sent another message.
    await this.forgetUtilities(state, reconcileActivated(state, new Set(next.keys())))
  }

  /**
   * Why a utility an agent asked for is unreachable, when the registry can say.
   *
   * A user who switches a capability off expects it to stop being callable, and
   * an agent should report that as the user's change rather than as a broken app,
   * so the registry is consulted once on the failure path only.
   */
  private async unreachableUtilityReason(utilityId: string): Promise<string | null> {
    const utility = await this.registry.get(utilityId)
    if (!utility) return `\`${utilityId}\` is no longer installed.`
    if (!utility.enabled) {
      return `\`${utilityId}\` was switched off in Utilities, so it is unavailable for the rest of this session.`
    }
    return null
  }

  /**
   * Land a registry change in every turn that is already running.
   *
   * The read inside `refreshEligible` covers the next search or activation, but
   * not a utility a turn already activated. Without this, switching a capability
   * off would leave it callable until the turn ended, which reads as the change
   * needing a restart. Dropping it from live turn state means the very next
   * invoke reports it as unavailable.
   */
  async applyRegistryChange(utilityId: string): Promise<void> {
    for (const turn of this.turns.values()) {
      const state = turn.state
      const wasReachable = forgetUtility(state, utilityId)
      await this.forgetUtilities(state, [utilityId])
      // The next search must re-read the registry instead of serving the set this
      // turn built before the change.
      state.eligibilityRefreshedAt = 0
      if (wasReachable) await this.audit(state, 'utility.registry_changed', { utilityId })
    }
  }

  /** Forget utilities a turn may no longer reach, releasing what belonged to them. */
  private async forgetUtilities(state: TurnState, utilityIds: readonly string[]): Promise<void> {
    await Promise.all(utilityIds.map((utilityId) => this.releaseUtility(state, utilityId)))
  }

  /** End one utility's CUA session and close its MCP client, if it had either. */
  private async releaseUtility(state: TurnState, utilityId: string): Promise<void> {
    const sessionId = state.cuaSessionIds.get(utilityId)
    const client = state.clients.get(utilityId)
    state.cuaSessionIds.delete(utilityId)
    state.clients.delete(utilityId)
    if (!client) return
    if (sessionId) {
      await client.callTool('end_session', { session: sessionId }).catch(() => undefined)
    }
    await Promise.allSettled([client.close()])
  }

  private async search(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    // A capability installed moments ago must be findable in this same turn.
    await this.refreshEligible(state)
    const query = optionalString(input['query'], 500)
    const kinds = optionalKinds(input['kinds'])
    const requestedLimit = optionalNumber(input['limit'])
    const limit = Math.min(Math.max(requestedLimit ?? 8, 1), 20)
    state.projectSearchTerms ??= projectTechnologyTerms(state.request.projectPath)
    const projectTerms = await state.projectSearchTerms
    const ranked = [...state.eligible.values()]
      .filter((resolved) => matchesUtilityKinds(resolved, kinds))
      .map((resolved) => ({
        resolved,
        lexicalScore: utilitySearchScore(resolved, query),
        projectScore: utilityProjectAffinityScore(resolved, projectTerms)
      }))
      .sort(
        (left, right) =>
          right.lexicalScore - left.lexicalScore || right.projectScore - left.projectScore
      )
    const matches = query ? ranked.filter(({ lexicalScore }) => lexicalScore > 0) : ranked
    const fallback = Boolean(query) && matches.length === 0 && ranked.length > 0
    const utilities = (fallback ? ranked : matches)
      .slice(0, limit)
      .map(({ resolved: { utility } }) => ({
        id: utility.id,
        name: utility.name,
        kind: utility.kind,
        description: utility.description,
        active: state.activated.has(utility.id),
        banked: state.bank.has(utility.id)
      }))
    // Lexical mismatch is not proof of semantic irrelevance. Candidate results
    // are intentionally left for the calling agent to evaluate against the
    // user's task; only an empty eligible set is an unambiguous absence verdict.
    const notFound = ranked.length === 0
    const matchType = notFound ? 'none' : fallback ? 'candidates' : 'direct'
    state.searched = true
    await this.audit(state, 'utility.searched', {
      query,
      fallback,
      notFound,
      matchType,
      resultIds: utilities.map(({ id }) => id)
    })
    return {
      utilities,
      fallback,
      notFound,
      matchType,
      ...(fallback
        ? {
            message:
              'No direct lexical match was found. Review these project-aware candidates against the task intent, then activate a relevant result or refine the search. If none of them fits, research the official source online (your own web tools, or a web/search capability from this library) before concluding the capability cannot be supplied.'
          }
        : {})
    }
  }

  private async activate(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    // Re-check the registry first: the agent may be activating a utility that was
    // installed or enabled after this turn started.
    await this.refreshEligible(state)
    const resolved = state.eligible.get(utilityId)
    if (!resolved) throw new Error('Utility is unavailable in this project, thread, or harness')
    // Re-activating an already-active utility must be a no-op: re-listing the
    // full capability would duplicate an unchanged schema into the transcript
    // for nothing, and for MCP/computer-use kinds the old code also tore down
    // the live client (killing an in-flight CUA session) just to reconnect it.
    if (state.activated.has(utilityId) && input['force'] !== true) {
      await this.audit(state, 'utility.activated', {
        utilityId,
        kind: resolved.utility.kind,
        alreadyActive: true
      })
      return {
        utility: {
          id: resolved.utility.id,
          name: resolved.utility.name,
          kind: resolved.utility.kind
        },
        capability: {
          note: 'Already active in this turn. Its capability description was returned by the earlier activation and is unchanged; invoke it directly. If compaction dropped that description from context, re-list it with cio_util_docs_lookup (or re-activate with input {"force": true}).'
        }
      }
    }
    state.activated.set(utilityId, resolved)
    // First activation in this thread registers the utility in the durable
    // thread utilities bank so every later turn can invoke it by id directly.
    await this.registerThreadBankEntry(state, resolved.utility)
    const capability = await this.capabilityFor(state, resolved)
    await this.audit(state, 'utility.activated', {
      utilityId,
      kind: resolved.utility.kind
    })
    return {
      utility: {
        id: resolved.utility.id,
        name: resolved.utility.name,
        kind: resolved.utility.kind
      },
      capability
    }
  }

  /**
   * The design capability's playbook, with the external-asset paragraph rebuilt
   * from the current settings policy and the delegation section rebuilt from the
   * user's current assignments.
   *
   * Resolved rather than seeded because both facts are user settings: the CDN
   * allowlist decides which hosts will actually load, and the assignments decide
   * which models a design turn is allowed to delegate to. All paths that hand the
   * playbook to a model   activation, and the promotion a `@cio-design` session
   * performs at turn start   come through here, so they cannot disagree.
   */
  private async designPlaybook(): Promise<string> {
    const config = await this.storage.getConfig()
    return designCapabilityDocs(
      prototypeCdnPolicyFromConfig(config),
      designAssignmentsFromConfig(config.design)
    )
  }

  /** Build the capability payload (tools, operations, or instructions) that
   *  activation and cio_util_docs_lookup hand back to the model. Shared so a
   *  post-compaction docs re-dump is byte-identical to the original listing. */
  private async capabilityFor(state: TurnState, resolved: ResolvedUtility): Promise<unknown> {
    if (resolved.utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID) {
      return { tools: BRAINSTORM_ALIGNMENT_OPERATIONS }
    }
    if (resolved.utility.id === ROUTINE_AUTHORING_UTILITY_ID) {
      return { tools: ROUTINE_AUTHORING_OPERATIONS }
    }
    if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      if (!this.browserExecutor) throw new Error('The in-app browser is unavailable')
      return { tools: BROWSER_UTILITY_TOOLS }
    }
    if (resolved.utility.id === APP_DESIGN_UTILITY_ID) {
      // The operation catalog travels with the playbook, because unlike the scope
      // capability this one is invoked with typed fields.
      return {
        instructions: await this.designPlaybook(),
        tools: DESIGN_UTILITY_TOOLS
      }
    }
    if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const client = await this.ensureMcpClient(state, resolved)
      return { tools: await client.listTools() }
    }
    if (resolved.utility.kind === 'skill') {
      // Skills hand back their instructions: the full contract, only now, and
      // only because this turn asked for the capability. The app-owned scope
      // utility travels this path.
      return { instructions: resolved.utility.config.instructions }
    }
    if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      return {
        operations: [resolved.utility.kind],
        inputSchema: WEB_TOOL_INPUT_SCHEMAS[resolved.utility.kind],
        outputSchema: WEB_TOOL_OUTPUT_SCHEMAS[resolved.utility.kind]
      }
    }
    if (resolved.utility.kind === 'image_descriptor') {
      return {
        operations: ['describe'],
        inputSchema: IMAGE_DESCRIPTOR_INPUT_SCHEMA,
        outputSchema: IMAGE_DESCRIPTOR_OUTPUT_SCHEMA
      }
    }
    return {
      note: 'Provider activation changes launch configuration and cannot safely mutate a running turn.'
    }
  }

  /** Lazily connect (or reuse) the MCP client for one utility, preparing the
   *  turn-scoped CUA cursor session for computer-use utilities. Used by both
   *  activation and straight-to-usage banked invocation. */
  private async ensureMcpClient(state: TurnState, resolved: ResolvedUtility): Promise<McpClient> {
    const utilityId = resolved.utility.id
    if (resolved.utility.kind !== 'mcp' && resolved.utility.kind !== 'computer_use') {
      throw new Error(`Utility kind "${resolved.utility.kind}" does not expose an MCP client`)
    }
    let client = state.clients.get(utilityId)
    if (!client) {
      if (this.isComputerUseUtility(resolved)) {
        // The Cua daemon's authorization mode is a start-time, daemon-wide
        // property: whichever client starts the daemon fixes it for every later
        // run until the daemon stops. Claiming the tier here, before the client
        // connects, is what keeps a full_access run from leaving an
        // approval-free daemon behind and an auto_review run from silently
        // downgrading a full_access one.
        await this.cuaBridge.claimDaemonMode(state.request.permissionLevel, state.id)
      }
      client = await this.mcpClient(resolved.utility)
      state.clients.set(utilityId, client)
    }
    if (this.isComputerUseUtility(resolved) && !state.cuaSessionIds.has(utilityId)) {
      await this.prepareComputerUseSession(state, utilityId, client)
    }
    return client
  }

  /**
   * Re-dump one utility's full capability docs by id alone. This is the
   * post-compaction recovery path: the model may have forgotten the original
   * activation payload, so the banked id is all it needs to re-list the docs.
   * It also marks the utility active so a following invoke works directly.
   */
  private async docsLookup(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    const resolved = state.activated.get(utilityId) ?? state.eligible.get(utilityId)
    if (!resolved) {
      throw new Error(
        state.bank.has(utilityId)
          ? 'This banked utility is not available to the current turn (disabled, out of scope, or filtered); ask the user to re-enable it in Utilities'
          : 'Utility is unavailable in this project, thread, or harness'
      )
    }
    state.activated.set(utilityId, resolved)
    await this.registerThreadBankEntry(state, resolved.utility)
    const capability = await this.capabilityFor(state, resolved)
    await this.audit(state, 'utility.docs_looked_up', {
      utilityId,
      kind: resolved.utility.kind
    })
    return {
      utility: {
        id: resolved.utility.id,
        name: resolved.utility.name,
        kind: resolved.utility.kind
      },
      capability
    }
  }

  private async invoke(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    const operation = requiredString(input['operation'], 'operation', 256)
    const operationInput = recordValue(input['input'] ?? {})
    let resolved = state.activated.get(utilityId)
    if (!resolved) {
      // Straight-to-usage banked reuse: a utility registered in this thread's
      // utilities bank can be invoked by id without re-activating it. The
      // per-turn eligibility gate still applies; the MCP client is reconnected
      // lazily below (stateless per turn, id persistent per thread).
      if (!state.bank.has(utilityId)) {
        const reason = await this.unreachableUtilityReason(utilityId)
        throw new Error(reason ?? 'Activate this utility before invoking it')
      }
      const eligible = state.eligible.get(utilityId)
      if (!eligible) {
        const reason = await this.unreachableUtilityReason(utilityId)
        throw new Error(
          reason ??
            'This banked utility is not available to the current turn (disabled, out of scope, or filtered); search for a replacement or ask the user to re-enable it in Utilities'
        )
      }
      resolved = eligible
      state.activated.set(utilityId, resolved)
    }

    let result: unknown
    if (resolved.utility.id === APP_SCOPE_UTILITY_ID) {
      // The capability's `operation` is the scope action, and its `input` is
      // exactly the field set the scope capability accepts.
      result = await this.runScopeTool(state, { ...operationInput, action: operation })
    } else if (resolved.utility.id === BRAINSTORM_ALIGNMENT_UTILITY_ID) {
      if (operation !== 'save_notes' || !state.request.saveBrainstormNotes) {
        throw new Error('Alignment notes are only available during an active Brainstorm interview')
      }
      const markdown = requiredString(
        operationInput['markdown'],
        'markdown',
        BRAINSTORM_ALIGNMENT_NOTE_LIMIT
      )
      result = await state.request.saveBrainstormNotes(markdown)
    } else if (resolved.utility.id === ROUTINE_AUTHORING_UTILITY_ID) {
      if (operation !== 'save_checkpoint' || !state.request.saveRoutineCheckpoint) {
        throw new Error(
          'The getting-started checkpoint is only available while a routine\u2019s how-to is being written'
        )
      }
      const markdown = requiredString(
        operationInput['markdown'],
        'markdown',
        ROUTINE_AUTHORING_CHECKPOINT_LIMIT
      )
      result = await state.request.saveRoutineCheckpoint(markdown)
    } else if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      const executor = this.browserExecutor
      if (!executor) throw new Error('The in-app browser is unavailable')
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.id === APP_DESIGN_UTILITY_ID) {
      // One capability, three operation groups with different owners: `preview`
      // serves the design folder, `delegate` runs the model the user assigned,
      // and `save-media` brings a generated asset in as a file.
      const executors = new Map<string, DesignCapabilityExecutor | null>([
        ['preview', this.designPreviewExecutor],
        ['delegate', this.designAssignmentExecutor],
        ['save-media', this.designMediaExecutor]
      ])
      const executor = executors.get(operation)
      if (!executor) {
        throw new Error(
          executors.has(operation)
            ? `The design capability's "${operation}" operation is unavailable`
            : `The design capability has no operation named "${operation}"`
        )
      }
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const client = await this.ensureMcpClient(state, resolved)
      const routedInput = this.routeComputerUseInput(state, utilityId, operationInput)
      try {
        result = await client.callTool(operation, routedInput)
      } catch (error) {
        await this.dropDeadComputerUseTransport(state, resolved, client, error)
        throw error
      }
      if (this.isComputerUseUtility(resolved)) {
        this.cuaActivityListener?.({
          threadId: state.request.threadId,
          operation,
          pid: operationPid(routedInput),
          sessionId: state.cuaSessionIds.get(utilityId),
          permissionLevel: state.request.permissionLevel
        })
      }
    } else if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      result = await this.invokeWeb(state, resolved.utility, operation, operationInput)
    } else if (resolved.utility.kind === 'image_descriptor') {
      if (operation !== 'describe') {
        throw new Error(`Image descriptor does not expose the operation "${operation}"`)
      }
      const executor = this.imageDescriptorExecutor
      if (!executor) {
        throw new Error('The image descriptor vision model is not configured')
      }
      result = {
        results: await executor({
          images: resolveImageEntries(operationInput),
          projectId: state.request.projectId,
          threadId: state.request.threadId,
          projectPath: state.request.projectPath,
          sessionId: state.request.sessionId,
          pinnedSelection: await this.pinnedImageDescriptorSelection()
        })
      }
    } else if (resolved.utility.kind === 'skill') {
      // A skill is documentation. Its whole contract arrived at activation, so
      // there is nothing to invoke; say so instead of reporting a kind mismatch.
      throw new Error(
        `\`${resolved.utility.id}\` is a skill: it exposes no tool. Its instructions arrived when it was activated, so re-list them with ${UTILITY_DOCS_TOOL_NAME} if they are gone, then do the work with your own tools.`
      )
    } else {
      throw new Error(`Utility kind "${resolved.utility.kind}" does not expose runtime operations`)
    }
    await this.audit(state, 'utility.invoked', { utilityId, operation })
    // A picture that travels inline as base64 is billed as text, at roughly one
    // token per character; the same bytes delivered as an image content part are
    // billed on the pixels they cover, which measured about 22x cheaper on a real
    // screenshot (40,788 tokens against 1,844 at 1568px). Both bridges forward a
    // `content` array verbatim, so an image-bearing result is handed back in that
    // shape and everything else keeps its existing form.
    return resultWithImageParts(result) ?? result
  }

  /**
   * Vision model pinned by the configured image-descriptor utility, read fresh
   * from the registry at invoke time. Reading the registry (not the turn-start
   * utility snapshot) means a model the user re-pins mid-turn applies to every
   * later descriptor call in that same turn.
   */
  private async pinnedImageDescriptorSelection(): Promise<
    { harnessId: string; providerId: string; modelId: string } | undefined
  > {
    const utility = await this.registry.get(APP_IMAGE_DESCRIPTOR_UTILITY_ID)
    if (!utility || utility.kind !== 'image_descriptor') return undefined
    if (!utility.config.providerId || !utility.config.modelId) return undefined
    return {
      harnessId: utility.config.harnessId,
      providerId: utility.config.providerId,
      modelId: utility.config.modelId
    }
  }

  private isComputerUseUtility(resolved: ResolvedUtility): boolean {
    if (resolved.utility.id === CUA_UTILITY_ID) return true
    const capability = normalizeCapability(resolved.binding.nativeCapability ?? '')
    return capability === 'computer_use'
  }

  /**
   * Drop a Cua client whose daemon connection died mid-turn.
   *
   * The `cua-driver mcp` server owns one connection to the shared Cua daemon and
   * never re-establishes it, so a daemon that dies while a run is in flight (a
   * crash, a driver update, a quit from the menu bar) leaves every remaining
   * computer-use call of that turn failing against a connection that can never
   * work again   measured against cua-driver 0.17.0: the connected server keeps
   * answering `daemon transport error ... cua-driver.sock: No such file or
   * directory` while a freshly spawned one starts a new daemon and works.
   *
   * Closing the client and forgetting its session is what lets the next call
   * reconnect: reconnecting re-claims the daemon, which starts a fresh one on
   * macOS, and the cursor session is re-created on it. The session id is dropped
   * with the client because that session lived inside the daemon that just died.
   *
   * The call that failed is deliberately never retried: a computer-use operation
   * may already have moved the mouse or typed, so replaying it is not safe.
   *
   * The failing client is the one named here, and it is only forgotten when it is
   * still the cached one: the gateway serves concurrent requests, so another call
   * may already have replaced it with a fresh connection that must survive.
   */
  private async dropDeadComputerUseTransport(
    state: TurnState,
    resolved: ResolvedUtility,
    client: McpClient,
    error: unknown
  ): Promise<void> {
    if (!this.isComputerUseUtility(resolved)) return
    const message = error instanceof Error ? error.message : String(error)
    if (!isCuaDaemonTransportFailure(message)) return
    const utilityId = resolved.utility.id
    if (state.clients.get(utilityId) === client) {
      state.clients.delete(utilityId)
      state.cuaSessionIds.delete(utilityId)
    }
    await client.close().catch(() => undefined)
    Logger.dev('Cua daemon connection was lost; the next computer-use call reconnects')
  }

  /** Establish a visible, never-idle-hidden cursor for one Cua turn. */
  private async prepareComputerUseSession(
    state: TurnState,
    utilityId: string,
    client: McpClient
  ): Promise<void> {
    const sessionId = buildCuaSessionId(state.request.threadTitle, state.id)
    try {
      await client.callTool('start_session', { session: sessionId })
    } catch (error) {
      Logger.dev('Cua cursor session could not be started:', error)
      return
    }
    state.cuaSessionIds.set(utilityId, sessionId)
    try {
      await client.callTool('set_agent_cursor_enabled', { session: sessionId, enabled: true })
    } catch (error) {
      Logger.dev('Cua agent cursor could not be enabled:', error)
    }
    try {
      await client.callTool('set_agent_cursor_motion', {
        session: sessionId,
        idle_hide_ms: 0
      })
    } catch (error) {
      Logger.dev('Cua agent cursor motion could not be configured:', error)
    }
  }

  /** Keep every Cua operation on the app-owned visible session. */
  private routeComputerUseInput(
    state: TurnState,
    utilityId: string,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const sessionId = state.cuaSessionIds.get(utilityId)
    return sessionId ? { ...input, session: sessionId } : input
  }

  private async endComputerUseSessions(state: TurnState): Promise<void> {
    await Promise.allSettled(
      [...state.cuaSessionIds.entries()].map(async ([utilityId, sessionId]) => {
        const client = state.clients.get(utilityId)
        if (!client) return
        await client.callTool('end_session', { session: sessionId }).catch(() => undefined)
      })
    )
    state.cuaSessionIds.clear()
  }

  private async invokeWeb(
    state: TurnState,
    utility: UtilityDefinitionFor<'web_search'> | UtilityDefinitionFor<'web_fetch'>,
    operation: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    state.attributionSequence += 1
    const featureCallId = `${state.id}:${utility.id}:${operation}:${state.attributionSequence}`
    try {
      const environment = await this.credentialEnvironment(utility)
      const provider = utility.config.provider ?? 'custom'
      const text = await executeWebTool(utility.kind, provider, input, utility.config, environment)
      let budgeted = budgetToolResult({
        content: text,
        turnTokens: state.request.budgetContext.composedTurnTokens,
        contextWindow:
          state.request.budgetContext.selectedModelInputTokens +
          DEFAULT_PROMPT_BUDGET.outputReserveTokens +
          DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
      })
      if (budgeted.truncated) {
        const sourceIndex = webSourceIndex(text)
        if (sourceIndex) {
          budgeted = budgetToolResult({
            content: `${sourceIndex}\n\n${text}`,
            turnTokens: state.request.budgetContext.composedTurnTokens,
            contextWindow:
              state.request.budgetContext.selectedModelInputTokens +
              DEFAULT_PROMPT_BUDGET.outputReserveTokens +
              DEFAULT_PROMPT_BUDGET.toolHeadroomTokens
          })
        }
      }
      state.request.attributeReinjectedResult({
        featureCallId,
        utilityId: utility.id,
        reinjectedTokens: budgeted.reinjectedTokens,
        truncatedTokens: budgeted.truncatedTokens,
        success: true,
        retryCause: null
      })
      return { content: [{ type: 'text', text: budgeted.content }] }
    } catch (error) {
      state.request.attributeReinjectedResult({
        featureCallId,
        utilityId: utility.id,
        reinjectedTokens: 0,
        truncatedTokens: 0,
        success: false,
        retryCause: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private async mcpClient(
    utility: UtilityDefinitionFor<'mcp'> | UtilityDefinitionFor<'computer_use'>
  ): Promise<McpClient> {
    if (utility.kind === 'computer_use') {
      if (!utility.config.endpoint) {
        throw new Error(`Computer-use utility "${utility.name}" requires an MCP endpoint`)
      }
      return RemoteMcpClient.connect(utility.config.endpoint, {})
    }
    // One shared starter, which the Utilities connection test calls too, so a
    // server that tests green is a server this gateway can start.
    return connectMcpServer({
      config: utility.config,
      environment: await this.credentialEnvironment(utility),
      credentials: utility.credentials,
      owner: { name: utility.name, credentials: utility.credentials }
    })
  }

  private async credentialEnvironment(utility: UtilityDefinition): Promise<Record<string, string>> {
    return resolveCredentialEnvironment(utility.credentials, (secretRef) =>
      this.vault.resolve(secretRef)
    )
  }

  private async audit(
    state: TurnState,
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.storage.appendRaw(
      dailyLogRelativePath(UTILITY_EVENTS_LOG_FILE),
      `${JSON.stringify({
        timestamp: Date.now(),
        action,
        turnId: state.id,
        harnessId: state.request.harnessId,
        projectId: state.request.projectId,
        threadId: state.request.threadId,
        ...details
      })}\n`
    )
  }

  private respond(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
}
