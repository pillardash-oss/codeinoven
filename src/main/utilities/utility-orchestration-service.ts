import { randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityDefinition,
  UtilityDefinitionFor,
  UtilityKind,
  PermissionLevel
} from '../../lib/types'
import { UTILITY_KIND_VALUES } from '../../lib/types'
import { StorageEngine } from '../storage/storage-engine'
import { SecretVault } from '../storage/secret-vault'
import { APP_BROWSER_UTILITY_ID, UtilityRegistryService } from './utility-registry-service'
import { CuaBridgeService } from './cua-bridge-service'
import {
  GATEWAY_TOOLS,
  RETRIEVE_MCP_HOST_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME
} from '../../lib/gateway-tools'
import {
  StdioMcpClient,
  MCP_TIMEOUT_MS,
  type JsonRpcResponse,
  type McpClient,
  type McpTool
} from '../agents/mcp-stdio-client'
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
import { Logger } from '../system/logger'
import { instanceRegistry } from '../system/instance-registry'

const BRIDGE_SCRIPT_PATH = 'runtime/utility-gateway/bridge.mjs'
const RETRIEVE_MCP_HOST_ROUTE = '/retrieve-mcp-host'
const RETRIEVE_MCP_HOST_SCRIPT_PATH = `runtime/utility-gateway/${RETRIEVE_MCP_HOST_TOOL_NAME}.mjs`
const MAX_REQUEST_BYTES = 1_000_000
const CUA_UTILITY_ID = 'codeinoven:cua-driver'
const UTILITY_SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'capability',
  'for',
  'i',
  'need',
  'of',
  'or',
  'the',
  'to',
  'tool',
  'use',
  'using',
  'utility',
  'with'
])

export interface UtilityTurnRequest {
  harnessId: string
  projectId: string
  threadId: string
  projectPath: string
  /** Main thread session that owns this turn, for scoped user-decision events. */
  sessionId: string
  nativeCapabilities: string[]
  permissionLevel: PermissionLevel
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

export interface UtilityTurnGateway {
  id: string
  resolvedUtilities: ResolvedUtility[]
  instructions: string
  /** Shell-callable fallback for harnesses that cannot safely load a per-turn MCP runtime. */
  directInstructions: string
  cleanup(): Promise<void>
}

export type BrowserUtilityExecutor = (
  operation: string,
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string }
) => Promise<unknown>

const BROWSER_UTILITY_TOOLS: McpTool[] = [
  {
    name: 'open',
    description: 'Open an http(s) URL in a visible in-app browser tab.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'snapshot',
    description: 'Read the current page title, URL, visible text, and interactive elements.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'click',
    description: 'Click the first page element matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description: 'Replace an input, textarea, or editable element value and emit input/change.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'navigate',
    description: 'Navigate the current in-app browser tab to an http(s) URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description: 'Capture the visible browser page as a PNG data URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

interface TurnState {
  id: string
  request: UtilityTurnRequest
  eligible: Map<string, ResolvedUtility>
  activated: Map<string, ResolvedUtility>
  clients: Map<string, McpClient>
  attributionSequence: number
  /** True once the agent has called utility_search this turn. */
  searched: boolean
  /** Session ids created for Cua utilities so cursor state is turn-scoped. */
  cuaSessionIds: Map<string, string>
}

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
  private cuaActivityListener:
    ((pid: number, threadId: string, sessionId?: string) => void) | null = null
  private imageDescriptorExecutor: ImageDescriptorExecutor | null = null
  private browserExecutor: BrowserUtilityExecutor | null = null
  constructor(
    private readonly storage: StorageEngine,
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
   * Register a listener invoked whenever a computer-use utility is called with
   * a target pid — used by the PiP monitor to latch onto the app a thread's
   * agent is driving.
   */
  onCuaActivity(listener: (pid: number, threadId: string, sessionId?: string) => void): void {
    this.cuaActivityListener = listener
  }

  async startTurn(request: UtilityTurnRequest): Promise<UtilityTurnGateway> {
    const id = randomUUID()
    const eligible = await this.registry.resolve({
      harnessId: request.harnessId,
      projectId: request.projectId,
      threadId: request.threadId,
      nativeCapabilities: request.nativeCapabilities,
      includeOnDemand: true
    })
    const hasNativeComputerUse = request.nativeCapabilities
      .map(normalizeCapability)
      .includes('computer_use')
    if (!hasNativeComputerUse) {
      const cuaUtility = await this.cuaBridge.resolveUtility(
        request.harnessId,
        request.permissionLevel
      )
      if (cuaUtility) eligible.push(cuaUtility)
    }
    const always = eligible.filter(
      ({ utility }) => utility.activation === 'always' && utility.kind !== 'mcp'
    )
    const hasOnDemand = eligible.some(({ utility }) => utility.activation === 'on_demand')
    const gatewayTools = hasOnDemand ? GATEWAY_TOOLS : []
    if (gatewayTools.length === 0) {
      return {
        id,
        resolvedUtilities: always,
        instructions: '',
        directInstructions: '',
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
      cuaSessionIds: new Map()
    }
    const bridgeUrl = await this.ensureGatewayServer()
    const token = randomBytes(32).toString('hex')
    const scriptPath = `${BRIDGE_SCRIPT_PATH}.${id}.mjs`
    await this.storage.writeRaw(scriptPath, buildUtilityGatewayScript(gatewayTools))
    const retrieverPath = await this.ensureMcpHostRetriever()
    this.turns.set(id, { state, scriptPath, token })
    this.turnIdsByToken.set(token, id)

    const gateway = gatewayUtility(request, this.storage.resolve(scriptPath), bridgeUrl, token)
    const recoveryInstruction = `The always-active ${RETRIEVE_MCP_HOST_TOOL_NAME} utility is independent of MCP. If the advertised app gateway is unreachable, call it through the shell with \`bun ${shellQuote(retrieverPath)} ${shellQuote(request.sessionId)}\`. It discovers the owning live CodeInOven instance and returns the current \`mcpHost\`. Retry the original route against that host with the current turn's authorization header. Never print or persist the bearer token.`
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
      instructions: hasOnDemand
        ? `A minimal app gateway is available. When you need a skill, MCP, utility, or other capability that is not directly available in this session, use ${UTILITY_SEARCH_TOOL_NAME} to discover it. If you already know an eligible utility, activate it directly with ${UTILITY_ACTIVATE_TOOL_NAME}, then use ${UTILITY_INVOKE_TOOL_NAME}. When you search, the result reports an explicit \`notFound\` boolean: only when it is true may you conclude that the capability does not exist in this session. Activated utilities exist only for this turn. ${recoveryInstruction}`
        : '',
      directInstructions: [
        'App-managed utilities are available through a turn-scoped loopback gateway. Use the shell to POST JSON with curl, setting Content-Type: application/json and the authorization header below; never print or persist the bearer token.',
        `Gateway: ${bridgeUrl}`,
        `Authorization header: Bearer ${token}`,
        recoveryInstruction,
        'Search when you need to discover a capability: POST /search with {"query":"capability","kinds":["mcp","skill","computer_use","image_descriptor"]}; the response includes a `notFound` boolean indicating no eligible match.',
        'Activate: POST /activate with {"utility_id":"id-from-search"}; if you already know an eligible utility id, activate it directly without searching first.',
        'Invoke: POST /invoke with {"utility_id":"id","operation":"tool-or-operation","input":{}}.',
        'Describe images: search for the image descriptor utility with {"query":"describe image","kinds":["image_descriptor"]}, activate its id, then POST /invoke with {"utility_id":"id","operation":"describe","input":{"images":[{"id":"image-1","source":"path-or-url","type":"path"}]}}.',
        'Treat these endpoints exactly like utility_search, utility_activate, and utility_invoke tool calls.'
      ].join('\n'),
      cleanup
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.turns.keys()].map((id) => this.cleanupTurn(id)))
    const server = this.gatewayServer
    this.gatewayServer = null
    this.gatewayBaseUrl = null
    this.gatewayStarting = null
    instanceRegistry.setMcpHost(null)
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** Whether the agent has called utility_search at least once this turn. */
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

  private async cleanupTurn(id: string): Promise<void> {
    const turn = this.turns.get(id)
    if (!turn) return
    this.turns.delete(id)
    this.turnIdsByToken.delete(turn.token)
    await this.endComputerUseSessions(turn.state)
    await Promise.allSettled([...turn.state.clients.values()].map((client) => client.close()))
    await this.storage.remove(turn.scriptPath)
    await this.audit(turn.state, 'turn.cleaned', {
      activatedUtilityIds: [...turn.state.activated.keys()]
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === 'POST' && request.url === RETRIEVE_MCP_HOST_ROUTE) {
        const input = await readJsonBody(request)
        const sessionId = requiredString(input['session_id'], 'session_id', 128)
        const ownsSession = [...this.turns.values()].some(
          ({ state }) => state.request.sessionId === sessionId
        )
        if (!ownsSession || !this.gatewayBaseUrl) {
          this.respond(response, 404, { error: 'Utility session is not owned by this instance' })
          return
        }
        this.respond(response, 200, { mcpHost: this.gatewayBaseUrl })
        return
      }
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
        instanceRegistry.setMcpHost(this.gatewayBaseUrl)
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

  /**
   * Materialize one durable app-owned recovery module. Turn instructions pass
   * their session id as data, so cleanup can retire turn state without leaving
   * a command in persistent agent context that points at a deleted module.
   */
  private async ensureMcpHostRetriever(): Promise<string> {
    const script = buildMcpHostRetrieverScript(this.storage.resolve('instances'))
    if ((await this.storage.readRaw(RETRIEVE_MCP_HOST_SCRIPT_PATH)) !== script) {
      await this.storage.writeRaw(RETRIEVE_MCP_HOST_SCRIPT_PATH, script)
    }
    return this.storage.resolve(RETRIEVE_MCP_HOST_SCRIPT_PATH)
  }

  private async search(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const query = optionalString(input['query'], 500)
    const kinds = optionalKinds(input['kinds'])
    const requestedLimit = optionalNumber(input['limit'])
    const limit = Math.min(Math.max(requestedLimit ?? 8, 1), 20)
    const ranked = [...state.eligible.values()]
      .filter((resolved) => matchesUtilityKinds(resolved, kinds))
      .map((resolved) => ({ resolved, score: utilitySearchScore(resolved, query) }))
      .sort((left, right) => right.score - left.score)
    const matches = query ? ranked.filter(({ score }) => score > 0) : ranked
    const fallback = Boolean(query) && matches.length === 0 && ranked.length > 0
    const utilities = (fallback ? ranked : matches)
      .slice(0, limit)
      .map(({ resolved: { utility } }) => ({
        id: utility.id,
        name: utility.name,
        kind: utility.kind,
        description: utility.description,
        active: state.activated.has(utility.id)
      }))
    // An explicit, unambiguous verdict the agent must honor: `true` means no
    // eligible utility matched the query (or none is eligible at all), so it can
    // confidently conclude the capability is not available in this session.
    // This must be distinguished from an ambiguous empty array.
    const notFound = query ? matches.length === 0 : ranked.length === 0
    state.searched = true
    await this.audit(state, 'utility.searched', {
      query,
      fallback,
      notFound,
      resultIds: utilities.map(({ id }) => id)
    })
    return {
      utilities,
      fallback,
      notFound,
      ...(fallback
        ? {
            message:
              'No direct match was found. These available utilities may still help; inspect or search again with shorter capability terms.'
          }
        : {})
    }
  }

  private async activate(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    const resolved = state.eligible.get(utilityId)
    if (!resolved) throw new Error('Utility is unavailable in this project, thread, or harness')
    state.activated.set(utilityId, resolved)

    let capability: unknown
    if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      if (!this.browserExecutor) throw new Error('The in-app browser is unavailable')
      capability = { tools: BROWSER_UTILITY_TOOLS }
    } else if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const previousClient = state.clients.get(utilityId)
      const previousSessionId = state.cuaSessionIds.get(utilityId)
      if (previousClient && previousSessionId) {
        await previousClient
          .callTool('end_session', { session: previousSessionId })
          .catch(() => undefined)
      }
      await previousClient?.close()
      state.cuaSessionIds.delete(utilityId)
      const client = await this.mcpClient(resolved.utility)
      state.clients.set(utilityId, client)
      if (this.isComputerUseUtility(resolved)) {
        await this.prepareComputerUseSession(state, utilityId, client)
      }
      capability = { tools: await client.listTools() }
    } else if (resolved.utility.kind === 'skill') {
      capability = { instructions: resolved.utility.config.instructions }
    } else if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      capability = {
        operations: [resolved.utility.kind],
        inputSchema: WEB_TOOL_INPUT_SCHEMAS[resolved.utility.kind],
        outputSchema: WEB_TOOL_OUTPUT_SCHEMAS[resolved.utility.kind]
      }
    } else if (resolved.utility.kind === 'image_descriptor') {
      capability = {
        operations: ['describe'],
        inputSchema: IMAGE_DESCRIPTOR_INPUT_SCHEMA,
        outputSchema: IMAGE_DESCRIPTOR_OUTPUT_SCHEMA
      }
    } else {
      capability = {
        note: 'Provider activation changes launch configuration and cannot safely mutate a running turn.'
      }
    }
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

  private async invoke(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const utilityId = requiredString(input['utility_id'], 'utility_id', 256)
    const operation = requiredString(input['operation'], 'operation', 256)
    const operationInput = recordValue(input['input'] ?? {})
    const resolved = state.activated.get(utilityId)
    if (!resolved) throw new Error('Activate this utility before invoking it')

    let result: unknown
    if (resolved.utility.id === APP_BROWSER_UTILITY_ID) {
      const executor = this.browserExecutor
      if (!executor) throw new Error('The in-app browser is unavailable')
      result = await executor(operation, operationInput, {
        projectId: state.request.projectId,
        threadId: state.request.threadId
      })
    } else if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const client = state.clients.get(utilityId)
      if (!client) throw new Error('Activated MCP client is unavailable')
      const routedInput = this.routeComputerUseInput(state, utilityId, operationInput)
      result = await client.callTool(operation, routedInput)
      if (this.isComputerUseUtility(resolved)) {
        const pid = operationPid(routedInput)
        if (pid !== null) {
          this.cuaActivityListener?.(
            pid,
            state.request.threadId,
            state.cuaSessionIds.get(utilityId)
          )
        }
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
          pinnedSelection: this.pinnedImageDescriptorSelection(state)
        })
      }
    } else {
      throw new Error(`Utility kind "${resolved.utility.kind}" does not expose runtime operations`)
    }
    await this.audit(state, 'utility.invoked', { utilityId, operation })
    return result
  }

  /** Vision model pinned by an eligible, configured image-descriptor utility. */
  private pinnedImageDescriptorSelection(
    state: TurnState
  ): { harnessId: string; providerId: string; modelId: string } | undefined {
    for (const { utility } of state.eligible.values()) {
      if (utility.kind !== 'image_descriptor') continue
      if (!utility.config.providerId || !utility.config.modelId) continue
      return {
        harnessId: utility.config.harnessId,
        providerId: utility.config.providerId,
        modelId: utility.config.modelId
      }
    }
    return undefined
  }

  private isComputerUseUtility(resolved: ResolvedUtility): boolean {
    if (resolved.utility.id === CUA_UTILITY_ID) return true
    const capability = normalizeCapability(resolved.binding.nativeCapability ?? '')
    return capability === 'computer_use'
  }

  /** Establish a visible, never-idle-hidden cursor for one Cua turn. */
  private async prepareComputerUseSession(
    state: TurnState,
    utilityId: string,
    client: McpClient
  ): Promise<void> {
    const sessionId = `codeinoven-${state.id}`
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
    const environment = await this.credentialEnvironment(utility)
    if (utility.config.transport === 'stdio') {
      if (!utility.config.command) throw new Error('stdio MCP command is not configured')
      return StdioMcpClient.connect(utility.config.command, utility.config.args ?? [], {
        ...utility.config.environment,
        ...environment
      })
    }
    if (!utility.config.url) throw new Error('Remote MCP URL is not configured')
    return RemoteMcpClient.connect(
      utility.config.url,
      resolveEnvironmentReferences(utility.config.headers ?? {}, environment)
    )
  }

  private async credentialEnvironment(utility: UtilityDefinition): Promise<Record<string, string>> {
    const environment: Record<string, string> = {}
    for (const credential of utility.credentials) {
      if (!credential.environmentVariable) continue
      try {
        environment[credential.environmentVariable] = await this.vault.resolve(credential.secretRef)
      } catch (error) {
        if (credential.required) throw error
      }
    }
    return environment
  }

  private async audit(
    state: TurnState,
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.storage.appendRaw(
      'logs/utility-events.jsonl',
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

class RemoteMcpClient implements McpClient {
  private nextId = 1
  private sessionId: string | undefined

  private constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>
  ) {}

  static async connect(url: string, headers: Record<string, string>): Promise<RemoteMcpClient> {
    const client = new RemoteMcpClient(url, headers)
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'codeinoven-utility-gateway', version: '1' }
    })
    await client.notify('notifications/initialized', {})
    return client
  }

  async listTools(): Promise<McpTool[]> {
    const result = recordValue(await this.request('tools/list', {}))
    const tools = Array.isArray(result['tools']) ? result['tools'] : []
    return tools.flatMap((value) => {
      if (!isRecord(value) || typeof value['name'] !== 'string') return []
      return [
        {
          name: value['name'],
          ...(typeof value['description'] === 'string'
            ? { description: value['description'] }
            : {}),
          ...(isRecord(value['inputSchema']) ? { inputSchema: value['inputSchema'] } : {})
        }
      ]
    })
  }

  callTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: input })
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId }
      }).catch(() => undefined)
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send({ jsonrpc: '2.0', id: this.nextId++, method, params }, true)
  }

  private notify(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.send({ jsonrpc: '2.0', method, params }, false)
  }

  private async send(payload: Record<string, unknown>, expectsResult: boolean): Promise<unknown> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`Remote MCP request failed (${response.status})`)
    this.sessionId ??= response.headers.get('mcp-session-id') ?? undefined
    if (!expectsResult || response.status === 202) return undefined
    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    const raw = contentType.includes('text/event-stream')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim()
      : text
    if (!raw) throw new Error('Remote MCP returned no result')
    const result = JSON.parse(raw) as JsonRpcResponse
    if (result.error) throw new Error(result.error.message)
    return result.result
  }
}

function gatewayUtility(
  request: UtilityTurnRequest,
  scriptPath: string,
  bridgeUrl: string,
  token: string
): ResolvedUtility {
  const now = Date.now()
  const utility: UtilityDefinitionFor<'mcp'> = {
    id: `codeinoven-utility-gateway:${request.threadId}`,
    kind: 'mcp',
    name: 'CodeInOven utilities',
    description: 'Search, activate, and invoke scoped app-owned utilities on demand.',
    enabled: true,
    activation: 'always',
    scope: { level: 'thread', projectId: request.projectId, threadId: request.threadId },
    config: {
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEINOVEN_UTILITY_BRIDGE_URL: bridgeUrl,
        CODEINOVEN_UTILITY_BRIDGE_TOKEN: token
      }
    },
    credentials: [],
    harnessBindings: [
      { harnessId: request.harnessId, strategy: 'mcp', transportName: 'utilities' }
    ],
    appOwned: false,
    createdAt: now,
    updatedAt: now
  }
  const binding: HarnessUtilityBinding = utility.harnessBindings[0]!
  return { utility, binding }
}

function normalizeCapability(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s-]+/gu, '_')
}

function operationPid(input: Record<string, unknown>): number | null {
  const directPid = input['pid']
  if (typeof directPid === 'number' && Number.isInteger(directPid) && directPid > 0) {
    return directPid
  }
  const target = recordValue(input['target'])
  const targetPid = target['pid']
  return typeof targetPid === 'number' && Number.isInteger(targetPid) && targetPid > 0
    ? targetPid
    : null
}

function matchesUtilityKinds(
  { utility, binding }: ResolvedUtility,
  kinds: Set<UtilityKind> | null
): boolean {
  if (!kinds || kinds.has(utility.kind)) return true
  if (!binding.nativeCapability) return false
  const capability = normalizeCapability(binding.nativeCapability)
  return [...kinds].some((kind) => normalizeCapability(kind) === capability)
}

function utilitySearchScore({ utility, binding }: ResolvedUtility, query: string): number {
  if (!query) return 0
  const normalizedQuery = normalizeSearchText(query)
  const name = normalizeSearchText(utility.name)
  const description = normalizeSearchText(utility.description)
  const metadata = normalizeSearchText(
    [
      utility.id,
      utility.kind,
      binding.nativeCapability,
      binding.transportName,
      utilitySearchAliases(utility.kind, binding.nativeCapability)
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
  )
  let score = 0
  if (name.includes(normalizedQuery)) score += 100
  if (description.includes(normalizedQuery)) score += 60
  if (metadata.includes(normalizedQuery)) score += 40

  const tokens = searchTokens(normalizedQuery)
  for (const token of tokens) {
    if (name.includes(token)) score += 12
    if (description.includes(token)) score += 6
    if (metadata.includes(token)) score += 3
  }
  return score
}

function utilitySearchAliases(kind: UtilityKind, nativeCapability?: string): string {
  const aliases: string[] = []
  if (normalizeCapability(nativeCapability ?? '') === 'computer_use') {
    aliases.push(
      'computer desktop screen mouse keyboard click type scroll gui ui application app browser chrome safari firefox visual automation control interact open launch'
    )
  }
  if (kind === 'mcp') aliases.push('mcp integration connector server external tools')
  if (kind === 'skill') aliases.push('skill instructions workflow knowledge procedure')
  if (kind === 'web_search') aliases.push('web internet online search research lookup')
  if (kind === 'web_fetch') aliases.push('web internet url page website fetch read download')
  if (kind === 'computer_use') {
    aliases.push(
      'computer desktop screen mouse keyboard click type scroll gui ui application app browser chrome safari firefox visual automation control interact open launch'
    )
  }
  if (kind === 'provider') aliases.push('provider model api inference')
  if (kind === 'image_descriptor') {
    aliases.push(
      'image descriptor describe vision picture photo screenshot see look visual ocr caption alt text'
    )
  }
  return aliases.join(' ')
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function searchTokens(value: string): string[] {
  return [
    ...new Set(
      value
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((token) => token.length > 2 && !UTILITY_SEARCH_STOP_WORDS.has(token)) ?? []
    )
  ]
}

function resolveEnvironmentReferences(
  values: Record<string, string>,
  environment: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
        const resolved = environment[name]
        if (resolved === undefined)
          throw new Error(`Credential environment is unavailable: ${name}`)
        return resolved
      })
    ])
  )
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('Utility request is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  return recordValue(parsed)
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value.trim()
}

function optionalString(value: unknown, maximum: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new TypeError('String input is invalid')
  }
  return value.trim()
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Numeric input is invalid')
  }
  return value
}

function optionalKinds(value: unknown): Set<UtilityKind> | null {
  if (value === undefined) return null
  const allowed = new Set<UtilityKind>(UTILITY_KIND_VALUES)
  if (
    !Array.isArray(value) ||
    value.some((kind) => typeof kind !== 'string' || !allowed.has(kind as UtilityKind))
  ) {
    throw new TypeError('Utility kinds are invalid')
  }
  return new Set(value as UtilityKind[])
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected an object')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build the stdio MCP gateway script. The tool list and the tools/call route
 *  map are generated from `GATEWAY_TOOLS`, so the agent-facing contract always
 *  matches the catalog — no hand-synchronized copy to drift. */
function buildUtilityGatewayScript(gatewayTools = GATEWAY_TOOLS): string {
  const tools = gatewayTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }))
  const routes: Record<string, string> = {}
  for (const tool of gatewayTools) routes[tool.name] = tool.route
  return String.raw`import readline from 'node:readline'

const baseUrl = process.env.CODEINOVEN_UTILITY_BRIDGE_URL
const token = process.env.CODEINOVEN_UTILITY_BRIDGE_TOKEN
const tools = ${JSON.stringify(tools)}
const routes = ${JSON.stringify(routes)}

async function bridge(path, args) {
  if (!baseUrl || !token) throw new Error('Utility bridge environment is unavailable')
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Utility bridge call failed')
  return body
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
    if (request.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'codeinoven-utilities', version: '1' }
        }
      })
    } else if (request.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      const name = request.params?.name
      const args = request.params?.arguments || {}
      const path = routes[name]
      if (!path) throw new Error('Unknown utility gateway tool')
      const result = await bridge(path, args)
      const content = Array.isArray(result?.content)
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result) }]
      write({ jsonrpc: '2.0', id: request.id, result: { content } })
    } else if (request.id !== undefined) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  } catch (error) {
    if (request?.id !== undefined) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Gateway failure' } })
    }
  }
}
`
}

/**
 * Build the durable, shell-callable host resolver. It reads only public process
 * metadata and probes every loopback gateway in parallel; bearer credentials
 * never enter the registry, command arguments, or tool output.
 */
function buildMcpHostRetrieverScript(instanceDirectory: string): string {
  return String.raw`import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const instanceDirectory = ${JSON.stringify(instanceDirectory)}
const sessionId = process.argv[2]?.trim()

if (!sessionId || sessionId.length > 128) {
  process.stderr.write('retrieve_mcp_host requires the current utility session id.\n')
  process.exit(1)
}

function validLoopbackHost(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.origin : null
  } catch {
    return null
  }
}

async function registeredHosts() {
  let files
  try {
    files = await fs.readdir(instanceDirectory)
  } catch {
    return []
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          return JSON.parse(await fs.readFile(join(instanceDirectory, file), 'utf8'))
        } catch {
          return null
        }
      })
  )
  const newestAllowedHeartbeat = Date.now() - 120_000
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            typeof entry?.lastHeartbeat === 'number' &&
            entry.lastHeartbeat >= newestAllowedHeartbeat
        )
        .map((entry) => validLoopbackHost(entry.mcpHost))
        .filter(Boolean)
    )
  ]
}

async function resolveHost(host) {
  try {
    const response = await fetch(host + ${JSON.stringify(RETRIEVE_MCP_HOST_ROUTE)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(1500)
    })
    if (!response.ok) return null
    const body = await response.json()
    return validLoopbackHost(body?.mcpHost)
  } catch {
    return null
  }
}

const hosts = await registeredHosts()
let resolved = null
try {
  resolved = await Promise.any(
    hosts.map(async (host) => {
      const candidate = await resolveHost(host)
      if (!candidate) throw new Error('Not the owning instance')
      return candidate
    })
  )
} catch {
  // No registered live instance owns this session.
}
if (!resolved) {
  process.stderr.write('No live CodeInOven instance owns this utility session.\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({ mcpHost: resolved }) + '\n')
}
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
