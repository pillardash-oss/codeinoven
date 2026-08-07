import { randomBytes, randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityDefinition,
  UtilityDefinitionFor,
  UtilityKind,
  PermissionLevel
} from '../lib/types'
import type { StorageEngine } from './storage-engine'
import { SecretVault } from './secret-vault'
import { UtilityRegistryService } from './utility-registry-service'
import { CuaBridgeService } from './cua-bridge-service'
import {
  StdioMcpClient,
  MCP_TIMEOUT_MS,
  type JsonRpcResponse,
  type McpClient,
  type McpTool
} from './mcp-stdio-client'
import {
  WEB_TOOL_INPUT_SCHEMAS,
  WEB_TOOL_OUTPUT_SCHEMAS,
  executeWebTool
} from './web-tool-providers'
import {
  IMAGE_DESCRIPTOR_INPUT_SCHEMA,
  IMAGE_DESCRIPTOR_OUTPUT_SCHEMA,
  resolveImageEntries,
  type ImageDescriptorExecutor
} from './image-descriptor-provider'

const BRIDGE_SCRIPT_PATH = 'runtime/utility-gateway/bridge.mjs'
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
  nativeCapabilities: string[]
  permissionLevel: PermissionLevel
}

export interface UtilityTurnGateway {
  id: string
  resolvedUtilities: ResolvedUtility[]
  instructions: string
  cleanup(): Promise<void>
}

interface TurnState {
  id: string
  request: UtilityTurnRequest
  eligible: Map<string, ResolvedUtility>
  activated: Map<string, ResolvedUtility>
  clients: Map<string, McpClient>
}

/**
 * Provides one small, app-owned MCP gateway instead of eagerly injecting every
 * utility schema. Utility selection and use remain scoped to a single turn.
 */
export class UtilityOrchestrationService {
  private readonly registry: UtilityRegistryService
  private readonly vault: SecretVault
  private readonly turns = new Map<string, { server: Server; state: TurnState }>()
  private cuaActivityListener: ((pid: number) => void) | null = null
  private imageDescriptorExecutor: ImageDescriptorExecutor | null = null
  constructor(
    private readonly storage: StorageEngine,
    private readonly cuaBridge = new CuaBridgeService(storage)
  ) {
    this.registry = new UtilityRegistryService(storage)
    this.vault = new SecretVault(storage)
  }

  /**
   * Register the executor that runs a vision model for `image_descriptor`
   * utilities. The chat engine supplies it because it owns driver sessions
   * and the resolved image-descriptor model selection.
   */
  setImageDescriptorExecutor(executor: ImageDescriptorExecutor | null): void {
    this.imageDescriptorExecutor = executor
  }

  /**
   * Register a listener invoked whenever a computer-use utility is called with
   * a target pid — used by the PiP monitor to latch onto the app an agent is
   * driving.
   */
  onCuaActivity(listener: (pid: number) => void): void {
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
    const state: TurnState = {
      id,
      request,
      eligible: new Map(eligible.map((entry) => [entry.utility.id, entry])),
      activated: new Map(always.map((entry) => [entry.utility.id, entry])),
      clients: new Map()
    }
    const token = randomBytes(32).toString('hex')
    const server = createServer((incoming, response) => {
      void this.handleRequest(state, token, incoming, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Utility gateway could not bind to loopback')
    }
    await this.storage.writeRaw(BRIDGE_SCRIPT_PATH, UTILITY_GATEWAY_SCRIPT)
    this.turns.set(id, { server, state })

    const gateway = gatewayUtility(
      request,
      this.storage.resolve(BRIDGE_SCRIPT_PATH),
      `http://127.0.0.1:${address.port}`,
      token
    )
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
      instructions: `A minimal app gateway is available. When you need a skill or MCP that is not directly available in this session, use utility_search to search for it first; only after searching and confirming no relevant result may you conclude that it does not exist. Activate one result with utility_activate, then use utility_invoke. Activated utilities exist only for this turn.`,
      cleanup
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.turns.keys()].map((id) => this.cleanupTurn(id)))
  }

  private async cleanupTurn(id: string): Promise<void> {
    const turn = this.turns.get(id)
    if (!turn) return
    this.turns.delete(id)
    await Promise.allSettled([...turn.state.clients.values()].map((client) => client.close()))
    await new Promise<void>((resolve) => turn.server.close(() => resolve()))
    await this.audit(turn.state, 'turn.cleaned', {
      activatedUtilityIds: [...turn.state.activated.keys()]
    })
  }

  private async handleRequest(
    state: TurnState,
    token: string,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    try {
      if (
        request.method !== 'POST' ||
        request.headers.authorization !== `Bearer ${token}` ||
        !request.url
      ) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      const input = await readJsonBody(request)
      const result =
        request.url === '/search'
          ? await this.search(state, input)
          : request.url === '/activate'
            ? await this.activate(state, input)
            : request.url === '/invoke'
              ? await this.invoke(state, input)
              : request.url === '/image_descriptor'
                ? await this.describeImages(state, input)
                : null
      if (result === null) {
        this.respond(response, 404, { error: 'Not found' })
        return
      }
      this.respond(response, 200, result)
    } catch (error) {
      this.respond(response, 400, {
        error: error instanceof Error ? error.message : 'Utility gateway request failed'
      })
    }
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
    await this.audit(state, 'utility.searched', {
      query,
      fallback,
      resultIds: utilities.map(({ id }) => id)
    })
    return {
      utilities,
      fallback,
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
    if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      await state.clients.get(utilityId)?.close()
      const client = await this.mcpClient(resolved.utility)
      state.clients.set(utilityId, client)
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
    if (resolved.utility.kind === 'mcp' || resolved.utility.kind === 'computer_use') {
      const client = state.clients.get(utilityId)
      if (!client) throw new Error('Activated MCP client is unavailable')
      result = await client.callTool(operation, operationInput)
      if (this.isComputerUseUtility(resolved) && Number.isInteger(operationInput['pid'])) {
        const pid = Number(operationInput['pid'])
        if (pid > 0) this.cuaActivityListener?.(pid)
      }
    } else if (resolved.utility.kind === 'web_search' || resolved.utility.kind === 'web_fetch') {
      result = await this.invokeWeb(resolved.utility, operationInput)
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
          pinnedSelection: this.pinnedImageDescriptorSelection(state)
        })
      }
    } else {
      throw new Error(`Utility kind "${resolved.utility.kind}" does not expose runtime operations`)
    }
    await this.audit(state, 'utility.invoked', { utilityId, operation })
    return result
  }

  /**
   * Direct `image_descriptor` tool handler. Unlike the on-demand utility path
   * this is always exposed by the gateway, so text-only models can describe
   * images without any registry configuration.
   */
  private async describeImages(state: TurnState, input: Record<string, unknown>): Promise<unknown> {
    const executor = this.imageDescriptorExecutor
    if (!executor) {
      throw new Error('The image descriptor vision model is not configured')
    }
    const results = await executor({
      images: resolveImageEntries(input),
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      pinnedSelection: this.pinnedImageDescriptorSelection(state)
    })
    await this.audit(state, 'utility.invoked', {
      utilityId: 'codeinoven:image-descriptor',
      operation: 'describe'
    })
    return { results }
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

  private async invokeWeb(
    utility: UtilityDefinitionFor<'web_search'> | UtilityDefinitionFor<'web_fetch'>,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const environment = await this.credentialEnvironment(utility)
    const provider = utility.config.provider ?? 'custom'
    const text = await executeWebTool(utility.kind, provider, input, utility.config, environment)
    return { content: [{ type: 'text', text }] }
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
  const allowed = new Set<UtilityKind>([
    'mcp',
    'skill',
    'web_search',
    'web_fetch',
    'computer_use',
    'provider',
    'image_descriptor'
  ])
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

const UTILITY_GATEWAY_SCRIPT = String.raw`import readline from 'node:readline'

const baseUrl = process.env.CODEINOVEN_UTILITY_BRIDGE_URL
const token = process.env.CODEINOVEN_UTILITY_BRIDGE_TOKEN
const tools = [
  {
    name: 'utility_search',
    description: 'Search installed utilities for a skill or MCP when one is not directly available; only conclude it does not exist after a search returns no relevant result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        kinds: { type: 'array', items: { enum: ['mcp', 'skill', 'web_search', 'web_fetch', 'computer_use', 'provider', 'image_descriptor'] } },
        limit: { type: 'number', minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'utility_activate',
    description: 'Activate one search result for this turn and inspect its available operations.',
    inputSchema: {
      type: 'object',
      properties: { utility_id: { type: 'string' } },
      required: ['utility_id'],
      additionalProperties: false
    }
  },
  {
    name: 'utility_invoke',
    description: 'Invoke an operation exposed by a utility activated during this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true }
      },
      required: ['utility_id', 'operation'],
      additionalProperties: false
    }
  },
  {
    name: 'image_descriptor',
    description: 'Describe images with a vision-capable model so a text-only model can reason about them. Provide every image entry with a unique id; each entry has a source and a type: "part" when source is a file path or URL, "binary" when source is base64 image data. Accepts up to 8 images per call (batch several frames at once; call again for more). Returns a text description per image tagged with its id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        images: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 256 },
              source: { type: 'string', minLength: 1 },
              type: { type: 'string', enum: ['part', 'binary'] }
            },
            required: ['id', 'source', 'type']
          }
        }
      },
      required: ['images']
    }
  }
]

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
      const path = name === 'utility_search' ? '/search' : name === 'utility_activate' ? '/activate' : name === 'utility_invoke' ? '/invoke' : name === 'image_descriptor' ? '/image_descriptor' : ''
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
