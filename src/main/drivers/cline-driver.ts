import { execFile, spawn } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type {
  AgentMessage,
  AgentPart,
  AgentTokenUsage,
  BaseUrlProvider,
  ProviderCatalog,
  SessionAgentEvent,
  ProviderModel,
  ThinkingPreset
} from '../../lib/types'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import type {
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { buildHarnessEnvironment } from './cli-environment'
import type { BaseUrlProviderService } from '../base-url-provider-service'
import type { SecretVault } from '../secret-vault'
import type { StorageEngine } from '../storage-engine'

const CLINE_THINKING_LEVELS: Record<string, string> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh'
}

const CLINE_CATALOG_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
const CLINE_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CLINE_PASS_PROVIDER_ID = 'cline-pass'

const CLINE_THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning effort' }
]

/** Stable Cline gateway models used when the remote catalog is unavailable. */
const CLINE_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: 'cline',
    name: 'Cline',
    harnessId: 'cline',
    models: [
      {
        id: 'anthropic/claude-sonnet-4-6',
        providerId: 'cline',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'google/gemini-2.5-pro',
        providerId: 'cline',
        name: 'Gemini 2.5 Pro',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'openai/gpt-4o',
        providerId: 'cline',
        name: 'GPT-4o',
        reasoning: false,
        attachment: true,
        toolcall: true
      },
      {
        id: 'deepseek/deepseek-chat',
        providerId: 'cline',
        name: 'DeepSeek Chat',
        reasoning: false,
        attachment: false,
        toolcall: true
      },
      {
        id: 'minimax/minimax-m2.5',
        providerId: 'cline',
        name: 'MiniMax M2.5',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  },
  {
    id: CLINE_PASS_PROVIDER_ID,
    name: 'ClinePass',
    harnessId: 'cline',
    models: [
      {
        id: 'cline-pass/qwen3.8-max',
        providerId: CLINE_PASS_PROVIDER_ID,
        name: 'Qwen 3.8 Max',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      },
      {
        id: 'cline-pass/deepseek-v4-flash',
        providerId: CLINE_PASS_PROVIDER_ID,
        name: 'DeepSeek V4 Flash',
        reasoning: true,
        thinkingPresets: CLINE_THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

let clineCatalogCache: { cachedAt: number; catalogs: ProviderCatalog[] } | null = null
let clineFreeModelIds: string[] = []

function cloneCatalogs(catalogs: ProviderCatalog[]): ProviderCatalog[] {
  return catalogs.map((catalog) => ({ ...catalog, models: [...catalog.models] }))
}

function mapRemoteClineModel(value: unknown, providerId: string): ProviderModel | null {
  const raw = record(value)
  const id = stringValue(raw?.['id'])
  if (!id) return null
  const name = stringValue(raw?.['name']) ?? id
  const reasoning = /reason|opus|sonnet|gemini|qwen|deepseek|kimi|mimo/iu.test(`${id} ${name}`)
  return {
    id,
    providerId,
    name,
    reasoning,
    ...(reasoning ? { thinkingPresets: CLINE_THINKING_PRESETS } : {}),
    attachment: /gemini|gpt-4o|kimi|qwen|mimo/iu.test(`${id} ${name}`),
    toolcall: true
  }
}

function uniqueModels(models: ProviderModel[]): ProviderModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()]
}

function mapRemoteClineCatalog(value: unknown): ProviderCatalog[] {
  const payload = record(value)
  if (!payload) return []

  const mapModels = (key: string, providerId: string): ProviderModel[] => {
    const values = payload[key]
    return Array.isArray(values)
      ? uniqueModels(
          values
            .map((model) => mapRemoteClineModel(model, providerId))
            .filter((model): model is ProviderModel => model !== null)
        )
      : []
  }

  const catalogs: ProviderCatalog[] = []
  const freeModels = mapModels('free', 'cline')
  clineFreeModelIds = freeModels.map((model) => model.id)
  const clineModels = uniqueModels([...mapModels('recommended', 'cline'), ...freeModels])
  if (clineModels.length > 0) {
    catalogs.push({ id: 'cline', name: 'Cline', harnessId: 'cline', models: clineModels })
  }

  const clinePassModels = mapModels('clinePass', CLINE_PASS_PROVIDER_ID)
  if (clinePassModels.length > 0) {
    catalogs.push({
      id: CLINE_PASS_PROVIDER_ID,
      name: 'ClinePass',
      harnessId: 'cline',
      models: clinePassModels
    })
  }
  return catalogs
}

async function fetchClineCatalog(): Promise<ProviderCatalog[]> {
  if (clineCatalogCache && Date.now() - clineCatalogCache.cachedAt < CLINE_CATALOG_CACHE_TTL_MS) {
    return cloneCatalogs(clineCatalogCache.catalogs)
  }

  try {
    const response = await fetch(CLINE_CATALOG_URL, {
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) return []
    const catalogs = mapRemoteClineCatalog(await response.json())
    if (catalogs.length === 0) return []
    clineCatalogCache = { cachedAt: Date.now(), catalogs }
    return cloneCatalogs(catalogs)
  } catch {
    return []
  }
}

/** Dedupes concurrent remote-catalog refreshes (e.g. several pickers open at once). */
let clineRemoteInflight: Promise<ProviderCatalog[]> | null = null

function refreshClineCatalogOnce(): Promise<ProviderCatalog[]> {
  clineRemoteInflight ??= fetchClineCatalog().finally(() => {
    clineRemoteInflight = null
  })
  return clineRemoteInflight
}

const CLINE_AVAILABILITY_CACHE_TTL_MS = 60_000
let clineAvailabilityCache: { checkedAt: number; available: boolean } | null = null

/**
 * Whether the `cline` binary is present on the harness PATH. Fetching the
 * remote model catalog costs a network round-trip for every provider-catalog
 * refresh, so it is pointless when Cline is not installed — gate on the binary
 * instead and fall back to the static catalog. The probe result is cached for
 * a short window so rapid refreshes don't respawn `which`.
 */
async function isClineAvailable(): Promise<boolean> {
  if (
    clineAvailabilityCache &&
    Date.now() - clineAvailabilityCache.checkedAt < CLINE_AVAILABILITY_CACHE_TTL_MS
  ) {
    return clineAvailabilityCache.available
  }
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const available = await new Promise<boolean>((resolve) => {
    execFile(probe, ['cline'], { env: buildHarnessEnvironment(), timeout: 5_000 }, (error) => {
      resolve(!error)
    })
  })
  clineAvailabilityCache = { checkedAt: Date.now(), available }
  return available
}

function utilityKey(value: string): string {
  const key = value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return key || 'utility'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestampValue(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function mapClineUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['inputTokens']) ?? 0
  const output = numberValue(usage['outputTokens']) ?? 0
  const reasoning = numberValue(usage['reasoningTokens']) ?? 0
  const cacheRead = numberValue(usage['cacheReadTokens']) ?? 0
  const cacheWrite = numberValue(usage['cacheWriteTokens']) ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite
  }
}

function serializeToolOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

interface ClineTurnState {
  turnIndex: number
  iteration: number
  messageId: string
  createdAt: number
  parts: AgentPart[]
}

function clineMessage(state: ClineTurnState): AgentMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    parts: [...state.parts],
    createdAt: state.createdAt,
    harnessId: 'cline'
  }
}

function upsertPart(state: ClineTurnState, part: AgentPart): void {
  const index = state.parts.findIndex((candidate) => candidate.id === part.id)
  if (index === -1) state.parts.push(part)
  else state.parts[index] = part
}

function beginClineIteration(
  context: CliLineParseContext,
  state: ClineTurnState,
  iteration: number,
  createdAt: number
): CliLineParseResult {
  state.iteration = iteration
  state.messageId = `cline:${context.sessionId}:${state.turnIndex}:${iteration}`
  state.createdAt = createdAt
  state.parts = []
  return { messages: [clineMessage(state)] }
}

function mapClineContentEvent(
  event: Record<string, unknown>,
  context: CliLineParseContext,
  state: ClineTurnState,
  complete: boolean
): CliLineParseResult {
  const contentType = stringValue(event['contentType'])
  const messageId = state.messageId
  if (
    contentType === 'text' ||
    contentType === 'reasoning' ||
    contentType === 'reasoning_summary'
  ) {
    const partType = contentType === 'text' ? 'text' : 'reasoning'
    const partId = `${messageId}:${partType}`
    const existing = state.parts.find(
      (part): part is Extract<AgentPart, { type: 'text' | 'reasoning' }> =>
        part.id === partId && (part.type === 'text' || part.type === 'reasoning')
    )
    const chunk = contentType === 'reasoning_summary' ? '' : (stringValue(event[contentType]) ?? '')
    const text = complete ? chunk : `${existing?.text ?? ''}${chunk}`
    const summary =
      stringValue(event['summary']) ??
      (contentType === 'reasoning_summary' ? stringValue(event['reasoning_summary']) : undefined)
    const part: Extract<AgentPart, { type: 'text' | 'reasoning' }> =
      partType === 'reasoning'
        ? {
            type: 'reasoning',
            id: partId,
            messageID: messageId,
            text,
            ...(summary ? { summary } : {})
          }
        : { type: 'text', id: partId, messageID: messageId, text }
    upsertPart(state, part)
    return {
      messages: [clineMessage(state)],
      events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
    }
  }

  if (contentType === 'tool') {
    const callId = stringValue(event['toolCallId']) ?? `${messageId}:call`
    const toolName = stringValue(event['toolName']) ?? 'tool'
    const output = serializeToolOutput(event['output'])
    const failed =
      event['isError'] === true ||
      (Array.isArray(event['output']) &&
        event['output'].some((entry) => record(entry)?.['success'] === false))
    const previous = state.parts.find(
      (part): part is Extract<AgentPart, { type: 'tool' }> =>
        part.type === 'tool' && part.callID === callId
    )
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: `${messageId}:tool:${callId}`,
      messageID: messageId,
      callID: callId,
      tool: toolName,
      state: {
        status: complete ? (failed ? 'error' : 'completed') : 'running',
        input: record(event['input']) ?? previous?.state.input ?? {},
        ...(output ? { output } : {}),
        ...(failed ? { error: output ?? `${toolName} failed` } : {})
      }
    }
    upsertPart(state, part)
    return {
      messages: [clineMessage(state)],
      events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
    }
  }

  return { events: [] }
}

function mapCurrentClineRecord(
  entry: Record<string, unknown>,
  context: CliLineParseContext,
  state: ClineTurnState
): CliLineParseResult | null {
  const type = stringValue(entry['type'])
  if (type === 'agent_event') {
    const event = record(entry['event'])
    if (!event) return null
    const eventType = stringValue(event['type'])
    if (eventType === 'iteration_start') {
      return beginClineIteration(
        context,
        state,
        numberValue(event['iteration']) ?? state.iteration + 1,
        timestampValue(entry['ts'])
      )
    }
    if (eventType === 'content_start' || eventType === 'content_end') {
      return mapClineContentEvent(event, context, state, eventType === 'content_end')
    }
    if (eventType === 'iteration_end') {
      return {
        messages: [{ ...clineMessage(state), completedAt: timestampValue(entry['ts']) }],
        events: [
          { type: 'message.completed', sessionId: context.sessionId, messageId: state.messageId }
        ]
      }
    }
    return { events: [] }
  }

  if (type === 'run_result') {
    const finishReason = stringValue(entry['finishReason'])
    const failed = finishReason === 'error'
    const finalText = stringValue(entry['text']) ?? ''
    let finalTextPart: AgentPart | undefined
    if (finalText) {
      const part: AgentPart = {
        type: 'text',
        id: `${state.messageId}:text`,
        messageID: state.messageId,
        text: finalText
      }
      upsertPart(state, part)
      finalTextPart = part
    }
    const model = record(entry['model'])
    const usage = mapClineUsage(entry['usage'])
    const cost = numberValue(record(entry['usage'])?.['totalCost'])
    const message: AgentMessage = {
      ...clineMessage(state),
      completedAt: timestampValue(entry['ts']),
      modelId: stringValue(model?.['id']),
      providerId: stringValue(model?.['provider']),
      ...(usage ? { tokens: usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(failed ? { error: finalText || 'Cline turn failed' } : {})
    }
    const events: SessionAgentEvent[] = []
    if (finalTextPart) {
      events.push({
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: finalTextPart
      })
    }
    events.push({
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId: state.messageId,
      ...(failed ? { error: finalText || 'Cline turn failed' } : {})
    })
    return {
      messages: [message],
      events
    }
  }

  return null
}

function mapClineRecordToEvents(
  value: Record<string, unknown>,
  sessionId: string,
  messageId: string
): { events: SessionAgentEvent[] } | undefined {
  const type = stringValue(value['type'])
  if (type !== 'say' && type !== 'ask') return undefined

  const text = stringValue(value['text']) ?? ''
  const say = stringValue(value['say'])
  const ask = stringValue(value['ask'])
  const reasoning = stringValue(value['reasoning'])
  const partial = value['partial'] === true

  if (type === 'say' && say === 'reasoning' && reasoning) {
    const partId = `${messageId}:reasoning`
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'reasoning',
            id: partId,
            messageID: messageId,
            text: reasoning
          }
        }
      ]
    }
  }

  if (type === 'say' && say === 'text') {
    const partId = `${messageId}:text`
    if (partial) {
      return {
        events: [
          {
            type: 'message.part.delta',
            sessionId,
            messageId,
            partId,
            field: 'text',
            delta: text
          }
        ]
      }
    }
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'text',
            id: partId,
            messageID: messageId,
            text
          }
        }
      ]
    }
  }

  if (type === 'say' && say === 'tool') {
    const partId = `${messageId}:tool`
    const toolName = stringValue(value['tool']) ?? 'unknown'
    const toolInput = record(value['input'])
    const toolOutput = stringValue(value['output'])

    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'tool',
            id: partId,
            messageID: messageId,
            callID: `${messageId}:call`,
            tool: toolName,
            state: {
              status: partial ? 'running' : toolOutput ? 'completed' : 'running',
              input: toolInput ?? {},
              ...(toolOutput ? { output: toolOutput } : {}),
              title: toolName
            }
          }
        }
      ]
    }
  }

  if (type === 'ask') {
    const partId = `${messageId}:ask`
    const questionType = ask ?? 'tool'
    const questionText = text || `Allow ${questionType}?`

    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'question',
            id: partId,
            messageID: messageId,
            question: {
              prompt: questionText,
              multiple: false,
              options: questionType === 'tool' ? ['Allow', 'Deny'] : ['Yes', 'No']
            }
          }
        }
      ]
    }
  }

  return undefined
}

function mapClineRecord(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
  const record_ = record(value)
  if (!record_) return null

  const type = stringValue(record_['type'])
  if (!type) return null

  const ts = numberValue(record_['ts']) ?? Date.now()
  const messageId = `cline:${context.sessionId}:${ts}`

  const result = mapClineRecordToEvents(record_, context.sessionId, messageId)
  if (!result) return null

  const messages: AgentMessage[] = []
  for (const event of result.events) {
    if (event.type === 'message.part.updated') {
      const existingMessage = messages.find((m) => m.id === messageId)
      if (existingMessage) {
        const partIndex = existingMessage.parts.findIndex((p) => p.id === event.part.id)
        if (partIndex === -1) {
          existingMessage.parts.push(event.part)
        } else {
          existingMessage.parts[partIndex] = event.part
        }
      } else {
        messages.push({
          id: messageId,
          role: 'assistant',
          parts: [event.part],
          createdAt: ts,
          harnessId: 'cline'
        })
      }
    }
  }

  const nativeSessionId = stringValue(record_['session_id'])

  return {
    events: result.events,
    messages: messages.length > 0 ? messages : undefined,
    nativeSessionId
  }
}

/** Process-per-turn bridge for Cline's `--json` protocol. */
export class ClineDriver extends PersistentCliDriver {
  readonly id = 'cline'
  readonly name = 'Cline'
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    steering: false,
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: false,
    attachments: false,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: false,
    compaction: false,
    subagents: false,
    nativeUtilities: ['web_search', 'web_fetch']
  }

  private turnStates = new Map<string, ClineTurnState>()
  private turnCounts = new Map<string, number>()

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {
    super(storage)
  }

  /** The enabled custom base-URL provider matching a selected provider id, if any. */
  private async resolveCustomProvider(
    providerId: string | undefined
  ): Promise<BaseUrlProvider | null> {
    if (!providerId || !this.baseUrlProviders || !this.secretVault) return null
    const provider = await this.baseUrlProviders.getProvider(this.id, providerId)
    if (!provider || provider.harnessId !== this.id || !provider.enabled) return null
    return provider
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('cline', ['--version'], {
        cwd: projectPath,
        env: buildHarnessEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => reject(new Error(`Cline CLI is unavailable: ${error.message}`)))
      child.on('exit', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Cline CLI version probe failed${stderr ? `: ${stderr.trim()}` : ''}`))
        }
      })
    })
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const customProviders = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id)
      : []
    const appendCustom = (catalogs: ProviderCatalog[]): ProviderCatalog[] => {
      for (const custom of customProviders) {
        catalogs.push({
          id: custom.id,
          name: custom.name,
          harnessId: 'cline',
          models: custom.models.map((model) => ({
            id: model.id,
            providerId: custom.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            thinkingPresets: model.reasoning ? CLINE_THINKING_PRESETS : undefined,
            attachment: false,
            toolcall: true,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
          }))
        })
      }
      return catalogs
    }

    // Do not pay a network round-trip for Cline's remote catalog when the
    // harness is not installed — return the static fallback instead.
    if (!(await isClineAvailable())) {
      return appendCustom(cloneCatalogs(CLINE_FALLBACK_CATALOG))
    }
    // A cached remote catalog (fetched on a previous open) is returned as-is.
    if (clineCatalogCache && Date.now() - clineCatalogCache.cachedAt < CLINE_CATALOG_CACHE_TTL_MS) {
      return appendCustom(cloneCatalogs(clineCatalogCache.catalogs))
    }
    // Otherwise never block the caller on the network: hand back the fallback
    // immediately and enrich the cache in the background. When the remote list
    // lands, a `catalog.updated` event lets the chat engine re-merge and push
    // the fresher catalog to open pickers.
    void refreshClineCatalogOnce().then((remote) => {
      if (remote.length > 0) this.emit({ type: 'catalog.updated', harnessId: 'cline' })
    })
    return appendCustom(cloneCatalogs(CLINE_FALLBACK_CATALOG))
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const remote = await fetchClineCatalog()
    const catalogs = remote.length > 0 ? remote : await this.listProviders()
    const models = catalogs.flatMap((catalog) => catalog.models)
    const free = clineFreeModelIds
      .map((modelId) => models.find((model) => model.id === modelId))
      .filter((model): model is ProviderModel => model !== undefined)
      .sort(
        (left, right) => Number(!/flash/iu.test(left.id)) - Number(!/flash/iu.test(right.id))
      )[0]
    const passFlash = models.find(
      (model) =>
        model.providerId === CLINE_PASS_PROVIDER_ID && model.id === 'cline-pass/deepseek-v4-flash'
    )
    return this.generateTitleWithCandidates(projectPath, options, [
      ...(free ? [{ providerId: free.providerId, modelId: free.id }] : []),
      ...(passFlash ? [{ providerId: passFlash.providerId, modelId: passFlash.id }] : [])
    ])
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      const config = utility.config
      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new TypeError(`Cline MCP utility "${utility.name}" requires a command`)
        }
        mcpServers[key] = {
          command: config.command,
          args: [...(config.args ?? [])],
          env: { ...(config.environment ?? {}) },
          disabled: false
        }
        continue
      }
      if (!config.url) throw new TypeError(`Cline MCP utility "${utility.name}" requires a URL`)
      mcpServers[key] = {
        type: config.transport === 'sse' ? 'sse' : 'streamableHttp',
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        disabled: false
      }
    }

    if (Object.keys(mcpServers).length === 0) return {}
    return {
      args: ['--data-dir', '{{runtime-directory}}/cline-data'],
      configFiles: [
        {
          id: 'cline-mcp',
          relativePath: 'cline-data/data/settings/cline_mcp_settings.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        }
      ]
    }
  }

  protected async buildTurnCommand(
    projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    if (options.attachments.length) {
      throw new Error('Cline CLI driver does not support prompt attachments')
    }

    const args: string[] = ['--json']
    const previousTurnCount = Math.max(
      this.turnCounts.get(session.id) ?? 0,
      session.messages.filter((message) => message.role === 'assistant').length
    )
    const turnIndex = previousTurnCount + 1
    this.turnCounts.set(session.id, turnIndex)
    this.turnStates.set(session.id, {
      turnIndex,
      iteration: 1,
      messageId: `cline:${session.id}:${turnIndex}:1`,
      createdAt: Date.now(),
      parts: []
    })

    const customProvider = await this.resolveCustomProvider(options.settings.providerId)
    const modelId =
      options.settings.modelId && options.settings.modelId !== 'default'
        ? options.settings.modelId
        : (customProvider?.models[0]?.id ?? options.settings.modelId)

    if (customProvider) {
      // Cline keeps a single `openai-compatible` slot, so a custom endpoint is
      // seeded into an app-owned data dir and selected through that stable id.
      args.push('-P', 'openai-compatible')
      if (modelId) args.push('-m', modelId)
    } else {
      if (modelId && modelId !== 'default') args.push('-m', modelId)
      if (options.settings.providerId) args.push('-P', options.settings.providerId)
    }

    if (options.systemPrompt) {
      args.push('-s', options.systemPrompt)
    }

    const thinking = CLINE_THINKING_LEVELS[options.settings.thinkingLevel]
    if (thinking) args.push('--thinking', thinking)

    if (options.settings.permissionLevel === 'full_access') {
      args.push('--auto-approve', 'true')
    } else {
      args.push('--auto-approve', 'false')
    }

    args.push('-c', projectPath)

    // Cline 3 treats a single-word positional prompt as an unquoted command.
    // A trailing newline preserves the prompt while selecting headless prompt mode.
    const prompt = /\s/u.test(options.text) ? options.text : `${options.text}\n`
    args.push(prompt)

    const env = buildHarnessEnvironment()
    if (customProvider) {
      await this.seedCustomProvider(customProvider, modelId, session, env)
    }

    return { command: 'cline', args, env }
  }

  /**
   * Write Cline's `providers.json` for one custom endpoint and point Cline at
   * the app-owned data dir. When a per-turn utility runtime is active its
   * directory is reused (auto-cleaned after the turn); otherwise a stable
   * driver-owned directory beneath the config root is used. When no custom
   * provider is selected Cline keeps running against the user's real `~/.cline`.
   */
  private async seedCustomProvider(
    provider: BaseUrlProvider,
    modelId: string | undefined,
    session: PersistentCliSession,
    env: NodeJS.ProcessEnv
  ): Promise<void> {
    const runtime = this.utilityRuntime(session.id)
    const dataDir = runtime
      ? join(runtime.directory, 'cline-data')
      : join(this.storage.resolve('drivers/cline'), 'isolated')
    const apiKey = provider.apiKeyRef
      ? await this.secretVault?.resolve(provider.apiKeyRef)
      : undefined
    const store = {
      version: 1,
      lastUsedProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          settings: {
            provider: 'openai-compatible',
            ...(apiKey ? { apiKey } : { apiKey: 'local' }),
            ...(modelId ? { model: modelId } : {}),
            baseUrl: provider.baseURL
          },
          updatedAt: new Date().toISOString(),
          tokenSource: 'manual'
        }
      }
    }
    await mkdir(join(dataDir, 'settings'), { recursive: true })
    await writeFile(
      join(dataDir, 'settings', 'providers.json'),
      `${JSON.stringify(store, null, 2)}\n`
    )
    env['CLINE_DATA_DIR'] = dataDir
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const entry = record(value)
    const state = this.turnStates.get(context.sessionId)
    if (entry && state) {
      const current = mapCurrentClineRecord(entry, context, state)
      if (current) return current
    }
    return mapClineRecord(value, context)
  }

  dispose(): void {
    this.turnStates.clear()
    this.turnCounts.clear()
    super.dispose()
  }
}
