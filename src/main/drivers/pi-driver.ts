import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { promisify } from 'util'
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

const execFileAsync = promisify(execFile)

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

/** Read-only Pi built-in tools used for temporary inspection chats. */
const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls']

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
        attachment: false,
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

/** Parse a human-readable `pi --list-models` table into provider catalogs. */
function parsePiModelTable(output: string): ProviderCatalog[] {
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return []
  const header = lines[0] ?? ''
  if (!header.includes('provider')) return []

  const byProvider = new Map<string, ProviderModel[]>()
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s{2,}/u)
    if (columns.length < 2) continue
    const provider = columns[0]?.trim()
    const model = columns[1]?.trim()
    if (!provider || !model) continue
    const context = columns[2]?.trim()
    const thinking = (columns[4]?.trim() ?? 'no') === 'yes'
    const images = (columns[5]?.trim() ?? 'no') === 'yes'
    const contextWindow = parseSize(context)
    const models = byProvider.get(provider) ?? []
    models.push({
      id: model,
      providerId: provider,
      name: model,
      reasoning: thinking,
      ...(thinking ? { thinkingPresets: THINKING_PRESETS } : {}),
      attachment: images,
      toolcall: true,
      ...(contextWindow ? { contextWindow } : {})
    })
    byProvider.set(provider, models)
  }
  const catalogs = [...byProvider.entries()].map(([provider, models]) => ({
    id: provider,
    name: provider,
    harnessId: 'pi',
    models
  }))
  return catalogs
}

/** Parse sizes like `128K` or `16.4K` into an approximate token count. */
function parseSize(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = value.trim().match(/^([\d.]+)\s*([KM])?$/u)
  if (!match) return undefined
  const magnitude = Number.parseFloat(match[1] ?? '')
  if (!Number.isFinite(magnitude)) return undefined
  const unit = match[2]
  if (unit === 'K') return Math.round(magnitude * 1024)
  if (unit === 'M') return Math.round(magnitude * 1024 * 1024)
  return Math.round(magnitude)
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
    streaming: true,
    steering: false,
    nativeResume: true,
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
    try {
      await execFileAsync('pi', ['--version'], {
        env: buildHarnessEnvironment(),
        timeout: 15_000
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error'
      throw new Error(`Pi CLI is unavailable: ${detail}`, { cause: error })
    }
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    let catalogs: ProviderCatalog[]
    try {
      const { stdout } = await execFileAsync('pi', ['--list-models'], {
        env: buildHarnessEnvironment(),
        timeout: 15_000
      })
      catalogs = parsePiModelTable(stdout)
      if (catalogs.length === 0) catalogs = structuredClone(PI_FALLBACK_CATALOG)
    } catch {
      catalogs = structuredClone(PI_FALLBACK_CATALOG)
    }
    if (this.baseUrlProviders) {
      const customProviders = await this.baseUrlProviders.listEnabled(this.id)
      for (const custom of customProviders) {
        catalogs.push({
          id: custom.id,
          name: custom.name,
          harnessId: 'pi',
          models: custom.models.map((model) => ({
            id: model.id,
            providerId: custom.id,
            name: model.name || model.id,
            reasoning: model.reasoning,
            thinkingPresets: model.reasoning ? THINKING_PRESETS : undefined,
            attachment: false,
            toolcall: true,
            ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
          }))
        })
      }
    }
    return catalogs
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
    this.turnStates.clear()
    super.dispose()
  }
}
