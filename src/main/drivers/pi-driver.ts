import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'url'
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession
} from '@earendil-works/pi-coding-agent'
import type {
  AgentMessage,
  AgentPart,
  AgentTokenUsage,
  PromptAttachment,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent,
  ThinkingPreset
} from '../../lib/types'
import { buildHarnessEnvironment } from './cli-environment'
import { hasNativeProviderCatalog } from '../native-provider-config-service'
import type {
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession
} from './persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from './svg-attachment'
import { piMcpExtension } from './pi-mcp-extension'
import { piCustomProvidersExtension } from './pi-providers-extension'
import type { BaseUrlProviderService } from '../base-url-provider-service'
import type { SecretVault } from '../secret-vault'
import type { StorageEngine } from '../storage-engine'

const THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning effort' }
]

/** Pi thinking levels accepted by `--thinking` (off, minimal, low, medium, high, xhigh). */
const PI_THINKING_LEVELS: Record<string, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
  ultra: 'xhigh'
}

function piThinkingLevel(value: string): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' {
  const resolved = PI_THINKING_LEVELS[value]
  if (
    resolved === 'minimal' ||
    resolved === 'low' ||
    resolved === 'medium' ||
    resolved === 'high' ||
    resolved === 'xhigh'
  ) {
    return resolved
  }
  return 'medium'
}

/** Read-only Pi built-in tools used for temporary inspection chats. */
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Fallback catalog used when `pi --list-models` cannot be parsed. */
const PI_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: 'pi',
    name: 'Pi',
    harnessId: 'pi',
    models: [
      {
        id: 'default',
        providerId: 'pi',
        name: 'Default',
        reasoning: true,
        thinkingPresets: THINKING_PRESETS,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'utility'
  )
}

/** Parse a Pi token/cost accounting object into the shared usage shape. */
function mapPiUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['input']) ?? 0
  const output = numberValue(usage['output']) ?? 0
  const cacheRead = numberValue(usage['cacheRead']) ?? 0
  const cacheWrite = numberValue(usage['cacheWrite']) ?? 0
  const reasoning = numberValue(usage['reasoning']) ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite
  }
}

/** Extract assistant cost in USD from a Pi usage object. */
function mapPiCost(value: unknown): number | undefined {
  const usage = record(value)
  const cost = record(usage?.['cost'])
  if (typeof cost?.['total'] === 'number') return cost['total']
  if (typeof usage?.['total'] === 'number') return usage['total']
  return undefined
}

function errorText(value: Record<string, unknown>): string {
  return (
    stringValue(value['errorMessage']) ??
    stringValue(value['error']) ??
    stringValue(value['message']) ??
    'Pi turn failed'
  )
}

function messageTimestamp(value: Record<string, unknown>): number {
  return numberValue(value['timestamp']) ?? Date.now()
}

/** Map one Pi content block into a CodeInOven AgentPart. */
function mapPiContentBlock(
  blockValue: unknown,
  messageId: string,
  index: number,
  callID: string
): AgentPart | null {
  const block = record(blockValue)
  if (!block) return null
  const type = stringValue(block['type'])
  if (type === 'text') {
    return {
      type: 'text',
      id: `${messageId}:text:${index}`,
      messageID: messageId,
      text: stringValue(block['text']) ?? ''
    }
  }
  if (type === 'thinking') {
    const summary = stringValue(block['summary'])
    return {
      type: 'reasoning',
      id: `${messageId}:reasoning:${index}`,
      messageID: messageId,
      text: stringValue(block['thinking']) ?? '',
      ...(summary ? { summary } : {})
    }
  }
  if (type === 'toolCall') {
    return {
      type: 'tool',
      id: `${messageId}:tool:${callID}`,
      messageID: messageId,
      callID,
      tool: stringValue(block['name']) ?? 'tool',
      state: {
        status: 'pending',
        input: record(block['arguments']) ?? {}
      }
    }
  }
  return null
}

function toolCallId(blockValue: unknown): string {
  const block = record(blockValue)
  return stringValue(block?.['id']) ?? ''
}

/** Serialize the `content` of a Pi message or tool result into plain text. */
function serializeContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (typeof entry === 'string') return entry
        const item = record(entry)
        return (
          stringValue(item?.['text']) ?? stringValue(item?.['thinking']) ?? JSON.stringify(item)
        )
      })
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
    return text || undefined
  }
  return undefined
}

/** Find the running tool part for a call id so results preserve its input. */
function findToolPart(
  context: CliLineParseContext,
  callId: string
): Extract<AgentPart, { type: 'tool' }> | undefined {
  for (const message of [...context.session.messages].reverse()) {
    const part = message.parts.find(
      (candidate): candidate is Extract<AgentPart, { type: 'tool' }> =>
        candidate.type === 'tool' && candidate.callID === callId
    )
    if (part) return part
  }
  return undefined
}

/** Turn-scoped state kept so parts of one assistant message can be correlated. */
interface PiTurnState {
  assistantMessageId: string | null
  turnIndex: number
}

/** Map one documented Pi JSON print-mode record into CodeInOven's stable shapes. */
export function mapPiRecord(
  value: unknown,
  context: CliLineParseContext,
  turnState: PiTurnState
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  const type = stringValue(entry['type'])

  if (type === 'session') {
    const nativeSessionId = stringValue(entry['id'])
    return nativeSessionId ? { nativeSessionId } : null
  }

  if (type === 'turn_start') {
    turnState.turnIndex += 1
    turnState.assistantMessageId = null
    return { events: [] }
  }

  if (type === 'message_start' && entry['message']) {
    const message = record(entry['message'])
    if (message?.['role'] === 'assistant') {
      turnState.assistantMessageId = `pi-${context.sessionId}-${turnState.turnIndex}`
    }
    return { events: [] }
  }

  if (type === 'message_update') {
    const message = record(entry['message'])
    const event = record(entry['assistantMessageEvent'])
    const messageId =
      stringValue(message?.['id']) ??
      turnState.assistantMessageId ??
      `pi-${context.sessionId}-${turnState.turnIndex}`
    const eventType = stringValue(event?.['type'])
    const contentIndex = numberValue(event?.['contentIndex']) ?? 0
    if (eventType === 'text_delta') {
      const delta = stringValue(event?.['delta'])
      if (!delta) return { events: [] }
      return {
        events: [
          {
            type: 'message.part.delta',
            sessionId: context.sessionId,
            messageId,
            partId: `${messageId}:text:${contentIndex}`,
            field: 'text',
            delta
          }
        ]
      }
    }
    if (eventType === 'thinking_delta') {
      const delta = stringValue(event?.['delta'])
      if (!delta) return { events: [] }
      return {
        events: [
          {
            type: 'message.part.delta',
            sessionId: context.sessionId,
            messageId,
            partId: `${messageId}:reasoning:${contentIndex}`,
            field: 'text',
            delta
          }
        ]
      }
    }
    return { events: [] }
  }

  if (type === 'message_end' && entry['message']) {
    const message = record(entry['message'])
    if (message?.['role'] !== 'assistant') return { events: [] }
    return buildAssistantMessage(message, context, turnState)
  }

  if (type === 'tool_execution_start' || type === 'tool_execution_update') {
    const callId = stringValue(entry['toolCallId'])
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    if (!callId) return { events: [] }
    const toolName = stringValue(entry['toolName']) ?? 'tool'
    const partialResult = record(entry['partialResult'])
    const partialOutput = serializeContent(partialResult?.['content'])
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'tool',
            id: `${messageId}:tool:${callId}`,
            messageID: messageId,
            callID: callId,
            tool: toolName,
            state: {
              status: 'running',
              input: record(entry['args']) ?? {},
              ...(partialOutput ? { output: partialOutput } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'tool_execution_end') {
    const callId = stringValue(entry['toolCallId'])
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    if (!callId) return { events: [] }
    const toolName = stringValue(entry['toolName']) ?? 'tool'
    const failed = entry['isError'] === true
    const result = record(entry['result'])
    const output = serializeContent(result?.['content']) ?? stringValue(result?.['text'])
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'tool',
            id: `${messageId}:tool:${callId}`,
            messageID: messageId,
            callID: callId,
            tool: toolName,
            state: {
              status: failed ? 'error' : 'completed',
              input: record(entry['args']) ?? {},
              ...(output ? { output } : {}),
              ...(failed ? { error: stringValue(result?.['error']) } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'turn_end' && entry['message']) {
    const rawMessage = record(entry['message'])
    if (!rawMessage) return { events: [] }
    const message = rawMessage
    const messageId =
      stringValue(message?.['id']) ??
      turnState.assistantMessageId ??
      `pi-${context.sessionId}-${turnState.turnIndex}`
    const events: SessionAgentEvent[] = []
    const toolResults = Array.isArray(entry['toolResults']) ? entry['toolResults'] : []
    for (const resultValue of toolResults) {
      const result = record(resultValue)
      const callId = stringValue(result?.['toolCallId'])
      if (!callId) continue
      const failed = result?.['isError'] === true
      const output = serializeContent(result?.['content'])
      const existing = findToolPart(context, callId)
      events.push({
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: {
          type: 'tool',
          id: existing?.id ?? `${messageId}:tool:${callId}`,
          messageID: existing?.messageID ?? messageId,
          callID: callId,
          tool: existing?.tool ?? stringValue(result?.['toolName']) ?? 'tool',
          state: {
            status: failed ? 'error' : 'completed',
            input: existing?.state.input ?? {},
            ...(output ? { output } : {}),
            ...(failed ? { error: serializeContent(result?.['content']) } : {})
          }
        }
      })
    }
    const usage = mapPiUsage(message['usage'])
    const cost = mapPiCost(message['usage'])
    const failed = message['stopReason'] === 'error' || message['stopReason'] === 'aborted'
    const completed: SessionAgentEvent = {
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId,
      ...(usage ? { tokens: usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(failed ? { error: errorText(message) } : {})
    }
    events.push(completed)
    return { events }
  }

  if (type === 'compaction_start' || type === 'compaction_end') {
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'compaction',
            id: `${messageId}:compaction`,
            messageID: messageId,
            auto: type === 'compaction_end'
          }
        }
      ]
    }
  }

  if (type === 'auto_retry_start') {
    return {
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'waiting',
            issue: {
              kind: 'provider_unavailable',
              message: stringValue(entry['errorMessage']) ?? 'Pi is waiting to retry',
              harnessId: 'pi',
              retryable: true
            }
          }
        }
      ]
    }
  }

  if (type === 'extension_error') {
    return {
      events: [
        {
          type: 'session.error',
          sessionId: context.sessionId,
          error: stringValue(entry['error']) ?? 'A Pi extension failed'
        }
      ]
    }
  }

  if (type === 'agent_end') {
    const messages = Array.isArray(entry['messages']) ? entry['messages'] : []
    const lastAssistant = [...messages].reverse().find((m) => {
      const message = record(m)
      return message?.['role'] === 'assistant'
    })
    const message = record(lastAssistant)
    const willRetry = entry['willRetry'] === true
    if (message && !willRetry && message['stopReason'] === 'error') {
      return {
        events: [{ type: 'session.error', sessionId: context.sessionId, error: errorText(message) }]
      }
    }
    return { events: [] }
  }

  return { events: [] }
}

/** Build the full assistant message and its part events from a Pi message object. */
function buildAssistantMessage(
  message: Record<string, unknown>,
  context: CliLineParseContext,
  turnState: PiTurnState
): CliLineParseResult | null {
  const content = Array.isArray(message['content']) ? message['content'] : []
  const messageId = `pi-${context.sessionId}-${turnState.turnIndex}`
  const now = messageTimestamp(message)
  const parts: AgentPart[] = []
  const events: SessionAgentEvent[] = []
  content.forEach((blockValue, index) => {
    const callId = toolCallId(blockValue) || `call-${index}`
    const part = mapPiContentBlock(blockValue, messageId, index, callId)
    if (!part) return
    parts.push(part)
    events.push({ type: 'message.part.updated', sessionId: context.sessionId, part })
  })
  const usage = mapPiUsage(message['usage'])
  const cost = mapPiCost(message['usage'])
  const failed = message['stopReason'] === 'error' || message['stopReason'] === 'aborted'
  const completed: AgentMessage = {
    id: messageId,
    role: 'assistant',
    parts,
    createdAt: now,
    harnessId: 'pi',
    modelId: stringValue(message['model']),
    providerId: stringValue(message['provider']),
    ...(usage ? { tokens: usage } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(failed ? { error: errorText(message) } : {})
  }
  return { events, messages: [completed] }
}

async function localAttachmentPath(attachment: PromptAttachment): Promise<string> {
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(
      `Pi attachment is not a valid local file: ${attachment.filename ?? attachment.url}`
    )
  }
  return path
}

/** Process-per-turn bridge for Pi's `--mode json` print protocol. */
export class PiDriver extends PersistentCliDriver {
  readonly id = 'pi'
  readonly name = 'Pi'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'embedded', scope: 'application' },
    streaming: true,
    steering: true,
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: false,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: false,
    compaction: false,
    subagents: false,
    nativeUtilities: []
  }

  private turnStates = new Map<string, PiTurnState>()
  private sdkSessions = new Map<string, AgentSession>()
  private sdkSystemPrompts = new Map<string, string>()
  private activeSdkTurns = new Set<string>()
  private modelRuntime: Promise<ModelRuntime> | null = null

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {
    super(storage)
  }

  generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(projectPath, options, [])
  }

  protected async ensureCliReady(): Promise<void> {
    await this.ensureModelRuntime()
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const runtime = await this.ensureModelRuntime()
    const byProvider = new Map<string, ProviderModel[]>()
    for (const model of runtime.getModels()) {
      const raw = model as unknown as Record<string, unknown>
      const providerId = stringValue(raw['provider']) ?? stringValue(raw['providerId'])
      const modelId = stringValue(raw['id'])
      if (!providerId || !modelId) continue
      const reasoning = raw['reasoning'] === true
      const models = byProvider.get(providerId) ?? []
      models.push({
        id: modelId,
        providerId,
        name: stringValue(raw['name']) ?? modelId,
        reasoning,
        ...(reasoning ? { thinkingPresets: THINKING_PRESETS } : {}),
        attachment: Array.isArray(raw['input']) ? raw['input'].includes('image') : true,
        toolcall: true,
        ...(numberValue(raw['contextWindow'])
          ? { contextWindow: numberValue(raw['contextWindow']) }
          : {})
      })
      byProvider.set(providerId, models)
    }
    const catalogs = [...byProvider.entries()].map(([id, models]) => ({
      id,
      name: id,
      harnessId: 'pi',
      models
    }))
    if (catalogs.length === 0) return structuredClone(PI_FALLBACK_CATALOG)
    return catalogs
  }

  private async ensureModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntime ??= ModelRuntime.create({ allowModelNetwork: true }).then(async (runtime) => {
      if (!this.baseUrlProviders) return runtime
      const customProviders = await this.baseUrlProviders.listEnabled(this.id)
      for (const provider of customProviders) {
        const api =
          provider.npm === '@ai-sdk/openai'
            ? 'openai-responses'
            : provider.npm === '@ai-sdk/anthropic'
              ? 'anthropic-messages'
              : 'openai-completions'
        runtime.registerProvider(provider.id, {
          name: provider.name,
          baseUrl: provider.baseURL,
          api,
          apiKey: provider.apiKeyRef ? undefined : 'local',
          ...(provider.headers ? { headers: provider.headers } : {}),
          models: provider.models.map((model) => ({
            id: model.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            input: ['text', 'image'],
            contextWindow: model.contextWindow ?? 128_000,
            maxTokens: model.maxOutputTokens ?? 16_384,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }))
        })
        if (provider.apiKeyRef && this.secretVault) {
          await runtime.setRuntimeApiKey(
            provider.id,
            await this.secretVault.resolve(provider.apiKeyRef)
          )
        }
      }
      return runtime
    })
    return this.modelRuntime
  }

  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const persistent = await this.requireSession(projectPath, options.sessionId)
    if (this.activeSdkTurns.has(persistent.id)) {
      throw new Error(`A turn is already active for session ${persistent.id}`)
    }
    const runtime = await this.ensureModelRuntime()
    const model = runtime.getModel(options.settings.providerId, options.settings.modelId)
    if (!model) {
      throw new Error(
        `Pi model is unavailable: ${options.settings.providerId}/${options.settings.modelId}`
      )
    }
    let sdkSession = this.sdkSessions.get(persistent.id)
    if (!sdkSession) {
      const loader = new DefaultResourceLoader({
        cwd: projectPath,
        agentDir: getAgentDir(),
        noContextFiles: true,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        ...(options.systemPrompt ? { appendSystemPrompt: [options.systemPrompt] } : {})
      })
      await loader.reload()
      sdkSession = (
        await createAgentSession({
          cwd: projectPath,
          modelRuntime: runtime,
          model,
          thinkingLevel: piThinkingLevel(options.settings.thinkingLevel),
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(projectPath),
          ...(options.readOnly ? { tools: READ_ONLY_TOOLS } : {})
        })
      ).session
      this.sdkSessions.set(persistent.id, sdkSession)
      this.sdkSystemPrompts.set(persistent.id, options.systemPrompt ?? '')
      persistent.nativeSessionId = sdkSession.sessionId
      sdkSession.subscribe((event) => {
        const result = this.parseJsonLine(event, {
          session: persistent,
          sessionId: persistent.id,
          projectPath
        })
        if (!result) return
        if (result.messages) this.mergeMessages(persistent, result.messages)
        for (const mapped of result.events ?? []) {
          this.applyEventToSession(persistent, mapped)
          this.emit(mapped)
        }
      })
    } else {
      if (sdkSession.model?.id !== model.id || sdkSession.model?.provider !== model.provider) {
        await sdkSession.setModel(model)
      }
      sdkSession.setThinkingLevel(piThinkingLevel(options.settings.thinkingLevel))
    }

    this.setTurnProvenance(persistent.id, options.settings.providerId, options.settings.modelId)
    this.appendUserMessage(persistent, options)
    this.activeSdkTurns.add(persistent.id)
    const priorSystemPrompt = this.sdkSystemPrompts.get(persistent.id) ?? ''
    const systemUpdate =
      options.systemPrompt && options.systemPrompt !== priorSystemPrompt
        ? `System instruction update for this turn:\n${options.systemPrompt}`
        : ''
    this.sdkSystemPrompts.set(persistent.id, options.systemPrompt ?? '')
    const inlineSvg = await inlineSvgAttachments(options.attachments)
    const images: PiImageContent[] = []
    const references: string[] = []
    for (const attachment of options.attachments) {
      if (isSvgAttachment(attachment)) continue
      const path = await localAttachmentPath(attachment)
      if (attachment.mime.toLowerCase().startsWith('image/')) {
        images.push({
          type: 'image',
          data: (await readFile(path)).toString('base64'),
          mimeType: attachment.mime
        })
      } else {
        references.push(`Attached file: ${path}`)
      }
    }
    const prompt = [systemUpdate, inlineSvg, ...references, options.text]
      .filter(Boolean)
      .join('\n\n')
    void sdkSession
      .prompt(prompt, { ...(images.length > 0 ? { images } : {}), source: 'rpc' })
      .catch((error: unknown) => {
        this.emit({
          type: 'session.error',
          sessionId: persistent.id,
          error: error instanceof Error ? error.message : 'Pi SDK turn failed'
        })
      })
      .finally(() => {
        this.activeSdkTurns.delete(persistent.id)
        void this.persistSession(persistent).catch((error: unknown) => {
          this.emit({
            type: 'session.error',
            sessionId: persistent.id,
            error: error instanceof Error ? error.message : 'Pi session could not be persisted'
          })
        })
        this.emit({ type: 'session.idle', sessionId: persistent.id })
      })
  }

  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    await this.requireSession(projectPath, options.sessionId)
    const sdkSession = this.sdkSessions.get(options.sessionId)
    if (!sdkSession || !this.activeSdkTurns.has(options.sessionId)) {
      throw new Error(`No active Pi turn is available to steer for session ${options.sessionId}`)
    }
    await sdkSession.steer(options.text)
  }

  override async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    await this.sdkSessions.get(sessionId)?.abort()
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.sdkSessions.get(sessionId)?.dispose()
    this.sdkSessions.delete(sessionId)
    this.sdkSystemPrompts.delete(sessionId)
    this.activeSdkTurns.delete(sessionId)
    await super.deleteSession(projectPath, sessionId)
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcpServers: Record<
      string,
      { command: string; args: string[]; env: Record<string, string> }
    > = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      const config = utility.config
      if (config.transport !== 'stdio' || !config.command) {
        throw new TypeError(`Pi MCP utility "${utility.name}" requires a stdio command`)
      }
      mcpServers[key] = {
        command: config.command,
        args: [...(config.args ?? [])],
        env: { ...(config.environment ?? {}) }
      }
    }

    const args: string[] = []
    const configFiles: NonNullable<UtilityRuntimeOverlay['configFiles']> = []
    const env: Record<string, string> = {}

    if (Object.keys(mcpServers).length > 0) {
      args.push('--extension', '{{config:pi-mcp-extension}}')
      configFiles.push({
        id: 'pi-mcp-extension',
        relativePath: 'pi/codeinoven-mcp-extension.ts',
        content: piMcpExtension(mcpServers)
      })
    }

    if (this.baseUrlProviders && this.secretVault && !hasNativeProviderCatalog(this.id)) {
      const customProviders = await this.baseUrlProviders.listEnabled(this.id)
      if (customProviders.length > 0) {
        for (const custom of customProviders) {
          if (!custom.apiKeyRef || !custom.apiKeyEnvVar) continue
          env[custom.apiKeyEnvVar] = await this.secretVault.resolve(custom.apiKeyRef)
        }
        args.push('--extension', '{{config:pi-codeinoven-providers}}')
        configFiles.push({
          id: 'pi-codeinoven-providers',
          relativePath: 'pi/codeinoven-providers.ts',
          content: piCustomProvidersExtension(customProviders)
        })
      }
    }

    if (configFiles.length === 0) return {}
    return { args, configFiles, env }
  }

  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: Parameters<PersistentCliDriver['sendPrompt']>[1]
  ): Promise<CliTurnCommand> {
    const args: string[] = ['--mode', 'json', '-p']
    if (session.nativeSessionId) args.push('--session-id', session.nativeSessionId)
    if (options.settings.providerId) args.push('--provider', options.settings.providerId)
    if (options.settings.modelId) args.push('--model', options.settings.modelId)

    const thinking = PI_THINKING_LEVELS[options.settings.thinkingLevel]
    if (thinking) args.push('--thinking', thinking)

    if (options.systemPrompt) {
      args.push('--append-system-prompt', options.systemPrompt)
    }

    if (options.readOnly) {
      args.push('--tools', READ_ONLY_TOOLS.join(','))
    }

    const inlineSvg = await inlineSvgAttachments(options.attachments)
    for (const attachment of options.attachments) {
      if (isSvgAttachment(attachment)) continue
      const path = await localAttachmentPath(attachment)
      args.push(`@${path}`)
    }

    args.push([inlineSvg, options.text].filter(Boolean).join('\n\n'))
    return { command: 'pi', args, env: buildHarnessEnvironment() }
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId) ?? {
      assistantMessageId: null,
      turnIndex: 0
    }
    this.turnStates.set(context.sessionId, state)
    return mapPiRecord(value, context, state)
  }

  dispose(): void {
    for (const session of this.sdkSessions.values()) session.dispose()
    this.sdkSessions.clear()
    this.sdkSystemPrompts.clear()
    this.activeSdkTurns.clear()
    this.turnStates.clear()
    super.dispose()
  }
}
