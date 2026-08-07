import { spawn } from 'child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentRateLimitWindow,
  AgentTokenUsage,
  ProviderCatalog,
  ProviderModel,
  PromptAttachment,
  ThinkingPreset
} from '../../lib/types'
import { fastSelectionModelId, resolveFastModelId } from '../../lib/fast-inference'
import type { StorageEngine } from '../storage-engine'
import { BaseUrlProviderService } from '../base-url-provider-service'
import { Logger } from '../logger'
import { SecretVault } from '../secret-vault'
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
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { buildHarnessEnvironment } from './cli-environment'
import { attachmentReference } from './attachment-reference'

const THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  {
    id: 'xhigh',
    label: 'Extra high',
    description: 'Extra-high effort; uses significantly more quota'
  },
  {
    id: 'max',
    label: 'Max · high usage',
    description: 'Maximum effort; uses significantly more quota'
  }
]

const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 15_000
const CLAUDE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const CLAUDE_TEXT_MIMES = new Set([
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/xml',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-sh',
  'application/x-typescript'
])

type ClaudeImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
type ClaudeInputBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        { type: 'base64'; media_type: ClaudeImageMime; data: string } | { type: 'url'; url: string }
    }
  | {
      type: 'document'
      source:
        | { type: 'base64'; media_type: 'application/pdf'; data: string }
        | { type: 'text'; media_type: 'text/plain'; data: string }
        | { type: 'url'; url: string }
      title?: string
    }

function fallbackClaudeModel(): ProviderModel {
  return {
    id: 'default',
    providerId: 'anthropic',
    name: 'Default (recommended)',
    reasoning: true,
    thinkingPresets: THINKING_PRESETS,
    attachment: true,
    toolcall: true,
    fastSupported: false
  }
}

function claudeModelName(model: ModelInfo): string {
  const resolvedName = model.description.split(' · ', 1)[0]?.trim()
  if (!resolvedName) return model.displayName
  if (model.value === 'default') return `${model.displayName} · ${resolvedName}`
  return model.resolvedModel && model.resolvedModel !== model.value
    ? `${resolvedName} (latest)`
    : resolvedName
}

function mapClaudeModel(model: ModelInfo): ProviderModel {
  const supportedEffortLevels = new Set<string>(model.supportedEffortLevels ?? [])
  const thinkingPresets = THINKING_PRESETS.filter((preset) => supportedEffortLevels.has(preset.id))
  const reasoning = model.supportsEffort === true || model.supportsAdaptiveThinking === true
  return {
    id: model.value,
    providerId: 'anthropic',
    name: claudeModelName(model),
    reasoning,
    thinkingPresets: reasoning ? thinkingPresets : undefined,
    attachment: true,
    toolcall: true,
    fastSupported: model.supportsFastMode ?? false
  }
}

function keepClaudeDiscoveryOpen(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined)
      }
    }
  }
}

async function discoverClaudeModels(projectPath: string): Promise<ProviderModel[]> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const handle = query({
    prompt: keepClaudeDiscoveryOpen(),
    options: {
      cwd: projectPath,
      env: buildHarnessEnvironment(),
      pathToClaudeCodeExecutable: 'claude',
      tools: []
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const models = await Promise.race([
      handle.supportedModels(),
      new Promise<ModelInfo[]>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Claude Code model discovery timed out')),
          CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS
        )
      })
    ])
    return models.map(mapClaudeModel)
  } finally {
    if (timer) clearTimeout(timer)
    handle.close()
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function numberProperty(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = number(value[key])
    if (candidate !== undefined) return candidate
  }
  return undefined
}

function epochMilliseconds(value: unknown): number | undefined {
  const numeric = number(value)
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

function tokenUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberProperty(usage, 'input_tokens', 'inputTokens') ?? 0
  const output = numberProperty(usage, 'output_tokens', 'outputTokens') ?? 0
  const cacheRead = numberProperty(usage, 'cache_read_input_tokens', 'cacheReadInputTokens') ?? 0
  const cacheWrite =
    numberProperty(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0
  const outputDetails = record(usage['output_tokens_details'] ?? usage['outputTokensDetails'])
  const reasoning =
    numberProperty(usage, 'reasoning_tokens', 'reasoningTokens') ??
    numberProperty(outputDetails ?? {}, 'thinking_tokens', 'thinkingTokens') ??
    0
  const total =
    numberProperty(usage, 'total_tokens', 'totalTokens') ?? input + output + cacheRead + cacheWrite
  return total > 0 ? { input, output, reasoning, cacheRead, cacheWrite, total } : undefined
}

/**
 * Claude's top-level result usage is cumulative across agent/tool iterations and
 * represents billable processing, not the prompt currently occupying context.
 * The final iteration is the closest provider-reported snapshot of live context.
 */
function latestIterationContextUsed(value: unknown): number | undefined {
  const usage = record(value)
  const iterations = usage?.['iterations']
  if (!Array.isArray(iterations)) return undefined
  return tokenUsage(iterations.at(-1))?.total
}

function preserveReasoningUsage(
  reported: AgentTokenUsage | undefined,
  existing: AgentTokenUsage | undefined
): AgentTokenUsage | undefined {
  if (!reported || !existing || existing.reasoning <= reported.reasoning)
    return reported ?? existing
  return { ...reported, reasoning: existing.reasoning }
}

function modelUsageRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map(record).filter((item): item is Record<string, unknown> => item !== null)
  const usage = record(value)
  return usage
    ? Object.values(usage)
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
    : []
}

function aggregateModelUsage(value: unknown): {
  tokens?: AgentTokenUsage
  cost?: number
  contextWindow?: number
} {
  const entries = modelUsageRecords(value)
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let contextWindow: number | undefined
  for (const entry of entries) {
    input += numberProperty(entry, 'inputTokens', 'input_tokens') ?? 0
    output += numberProperty(entry, 'outputTokens', 'output_tokens') ?? 0
    reasoning += numberProperty(entry, 'reasoningTokens', 'reasoning_tokens') ?? 0
    cacheRead += numberProperty(entry, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0
    cacheWrite +=
      numberProperty(entry, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0
    cost += numberProperty(entry, 'costUSD', 'costUsd', 'cost_usd') ?? 0
    const candidateWindow = numberProperty(entry, 'contextWindow', 'context_window')
    if (candidateWindow !== undefined) contextWindow = Math.max(contextWindow ?? 0, candidateWindow)
  }
  const total = input + output + reasoning + cacheRead + cacheWrite
  return {
    ...(total > 0 ? { tokens: { input, output, reasoning, cacheRead, cacheWrite, total } } : {}),
    ...(cost > 0 ? { cost } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {})
  }
}

function rateLimitWindow(
  value: unknown,
  fallbackId = 'claude-rate-limit'
): AgentRateLimitWindow | null {
  const limit = record(value)
  if (!limit) return null
  const status = string(limit['status'])
  const limitType = string(limit['rateLimitType']) ?? string(limit['rate_limit_type'])
  const utilization = numberProperty(limit, 'utilization', 'used_percentage', 'usedPercent')
  const usedPercent =
    utilization === undefined ? undefined : utilization <= 1 ? utilization * 100 : utilization
  const resetsAt = epochMilliseconds(limit['resetsAt'] ?? limit['resets_at'])
  const windowMinutes = numberProperty(limit, 'window_duration_mins', 'windowDurationMins')
  const overageStatus = string(limit['overageStatus']) ?? string(limit['overage_status'])
  const overageDisabledReason =
    string(limit['overageDisabledReason']) ?? string(limit['overage_disabled_reason'])
  const isUsingOverageValue = limit['isUsingOverage'] ?? limit['is_using_overage']
  const isUsingOverage = typeof isUsingOverageValue === 'boolean' ? isUsingOverageValue : undefined
  const id = string(limit['id']) ?? limitType ?? fallbackId ?? status ?? 'claude-rate-limit'
  const label = windowLabel(limitType, windowMinutes, fallbackId)
  return {
    id,
    label,
    ...(status === undefined ? {} : { status }),
    ...(usedPercent === undefined ? {} : { usedPercent: Math.min(100, usedPercent) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(overageStatus === undefined ? {} : { overageStatus }),
    ...(overageDisabledReason === undefined ? {} : { overageDisabledReason }),
    ...(isUsingOverage === undefined ? {} : { isUsingOverage })
  }
}

/** Human label for a Claude rate-limit type, e.g. `five_hour` → `5-hour`. */
function windowLabel(
  limitType: string | undefined,
  windowMinutes: number | undefined,
  fallbackId?: string
): string {
  if (windowMinutes !== undefined) {
    if (windowMinutes === 300) return '5-hour limit'
    if (windowMinutes === 10_080) return 'Weekly limit'
    if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}-day limit`
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`
    return `${windowMinutes}-minute limit`
  }
  const type = (limitType ?? fallbackId)?.toLowerCase()
  if (type === 'five_hour' || type === '5h' || type === '5hour') return '5-hour limit'
  if (type === 'seven_day' || type === '7day' || type === 'weekly') return 'Weekly limit'
  if (limitType) return limitType.replaceAll('_', ' ')
  return 'usage limit'
}

function rateLimitWindows(value: unknown): AgentRateLimitWindow[] {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => rateLimitWindow(item, `claude-rate-limit-${index}`))
      .filter((item): item is AgentRateLimitWindow => item !== null)
  }
  const limits = record(value)
  if (!limits) return []
  if ('status' in limits || 'utilization' in limits) {
    const mapped = rateLimitWindow(limits)
    return mapped ? [mapped] : []
  }
  return Object.entries(limits)
    .map(([id, item]) => rateLimitWindow(item, id))
    .filter((item): item is AgentRateLimitWindow => item !== null)
}

function latestClaudeRateLimits(context: CliLineParseContext): AgentRateLimitWindow[] {
  for (let index = context.session.messages.length - 1; index >= 0; index -= 1) {
    const limits = context.session.messages[index]?.rateLimits
    if (limits && limits.length > 0) return limits
  }
  return []
}

function claudeSessionLimitResetAt(message: string, now = Date.now()): number | undefined {
  const match = message.match(/\bresets\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/iu)
  if (!match) return undefined
  const parsedHour = Number(match[1])
  const minute = Number(match[2])
  if (parsedHour < 1 || parsedHour > 12 || minute < 0 || minute > 59) return undefined
  const meridiem = match[3]?.toLowerCase()
  const hour = (parsedHour % 12) + (meridiem === 'pm' ? 12 : 0)
  const reset = new Date(now)
  reset.setHours(hour, minute, 0, 0)
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1)
  return reset.getTime()
}

function claudeSessionLimitIssue(
  error: string | undefined,
  rateLimits: AgentRateLimitWindow[]
): AgentProviderIssue | undefined {
  if (
    !error ||
    !/(?:you(?:'|’)ve|you have) hit your session limit|session limit reached/iu.test(error)
  ) {
    return undefined
  }
  const retryAt =
    rateLimits.find((limit) => limit.resetsAt !== undefined)?.resetsAt ??
    claudeSessionLimitResetAt(error)
  return {
    kind: 'quota',
    message: error,
    rawError: error,
    harnessId: 'claude-code',
    retryable: retryAt !== undefined,
    ...(retryAt === undefined ? {} : { retryAt })
  }
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

function serializeContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => serializeContent(item))
      .filter((item): item is string => Boolean(item))
      .join('\n')
  }
  const item = record(value)
  if (!item) return undefined
  return string(item['text']) ?? string(item['content']) ?? JSON.stringify(item)
}

function toolPart(
  messageId: string,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  status: 'pending' | 'completed' | 'error',
  output?: string
): AgentPart {
  return {
    type: 'tool',
    id: `claude-tool-${callId}`,
    messageID: messageId,
    callID: callId,
    tool: name,
    state: { status, input, output }
  }
}

function summaryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const summary = value
    .map((item) => string(record(item)?.['text']) ?? string(record(item)?.['summary']))
    .filter((item): item is string => Boolean(item))
    .join('\n')
  return summary || undefined
}

function attachmentLabel(attachment: PromptAttachment): string {
  if (attachment.filename) return attachment.filename
  try {
    return basename(
      attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
    )
  } catch {
    return attachment.url
  }
}

async function attachmentBytes(attachment: PromptAttachment): Promise<Buffer> {
  if (attachment.url.startsWith('data:')) {
    const separator = attachment.url.indexOf(',')
    if (separator < 0)
      throw new Error(`Claude attachment is invalid: ${attachmentLabel(attachment)}`)
    const metadata = attachment.url.slice(0, separator)
    const payload = attachment.url.slice(separator + 1)
    return metadata.endsWith(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
  }
  let path: string
  try {
    path = attachment.url.startsWith('file:') ? fileURLToPath(attachment.url) : attachment.url
  } catch {
    throw new Error(`Claude attachment path is invalid: ${attachmentLabel(attachment)}`)
  }
  try {
    return await readFile(path)
  } catch {
    throw new Error(`Claude attachment is not readable: ${attachmentLabel(attachment)}`)
  }
}

async function claudeInputBlocks(
  text: string,
  attachments: PromptAttachment[]
): Promise<ClaudeInputBlock[]> {
  const content: ClaudeInputBlock[] = [{ type: 'text', text }]
  for (const attachment of attachments) {
    const mime = attachment.mime.toLowerCase().split(';', 1)[0] ?? ''
    const title = attachmentLabel(attachment)
    const remote = /^https?:\/\//u.test(attachment.url)
    if (CLAUDE_IMAGE_MIMES.has(mime)) {
      content.push({
        type: 'image',
        source: remote
          ? { type: 'url', url: attachment.url }
          : {
              type: 'base64',
              media_type: mime as ClaudeImageMime,
              data: (await attachmentBytes(attachment)).toString('base64')
            }
      })
      continue
    }
    if (mime === 'application/pdf') {
      content.push({
        type: 'document',
        source: remote
          ? { type: 'url', url: attachment.url }
          : {
              type: 'base64',
              media_type: 'application/pdf',
              data: (await attachmentBytes(attachment)).toString('base64')
            },
        title
      })
      continue
    }
    if (mime.startsWith('text/') || CLAUDE_TEXT_MIMES.has(mime)) {
      if (remote) {
        throw new Error(`Claude cannot attach remote text files directly: ${title}`)
      }
      content.push({
        type: 'document',
        source: {
          type: 'text',
          media_type: 'text/plain',
          data: (await attachmentBytes(attachment)).toString('utf8')
        },
        title
      })
      continue
    }
    content.push({ type: 'text', text: await attachmentReference(attachment) })
  }
  return content
}

async function claudeStreamInput(
  text: string,
  attachments: PromptAttachment[],
  priority?: 'now'
): Promise<string> {
  const message: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: attachments.length > 0 ? await claudeInputBlocks(text, attachments) : text
    },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  }
  return `${JSON.stringify(message)}\n`
}

function partFromBlock(
  messageId: string,
  block: Record<string, unknown>,
  index: number
): AgentPart | null {
  const type = string(block['type'])
  if (type === 'text') {
    return {
      type: 'text',
      id: `claude-text-${messageId}-${index}`,
      messageID: messageId,
      text: string(block['text']) ?? ''
    }
  }
  if (type === 'thinking') {
    const summary = summaryText(block['summary'])
    return {
      type: 'reasoning',
      id: `claude-thinking-${messageId}-${index}`,
      messageID: messageId,
      text: string(block['thinking']) ?? '',
      ...(summary ? { summary } : {})
    }
  }
  if (type === 'tool_use') {
    const callId = string(block['id']) ?? `claude-call-${messageId}-${index}`
    return toolPart(
      messageId,
      callId,
      string(block['name']) ?? 'unknown',
      record(block['input']) ?? {},
      'pending'
    )
  }
  return null
}

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

function messageFromAssistant(message: Record<string, unknown>): AgentMessage {
  const messageId = string(message['id']) ?? `claude-assistant-${Date.now()}`
  const content = Array.isArray(message['content']) ? message['content'] : []
  const parts: AgentPart[] = []
  const now = Date.now()
  for (const [index, blockValue] of content.entries()) {
    const block = record(blockValue)
    if (!block) continue
    const part = partFromBlock(messageId, block, index)
    if (part) parts.push(part)
  }
  const tokens = tokenUsage(message['usage'])
  return { id: messageId, role: 'assistant', parts, createdAt: now, ...(tokens ? { tokens } : {}) }
}

function latestAssistant(context: CliLineParseContext): AgentMessage | undefined {
  return [...context.session.messages].reverse().find((message) => message.role === 'assistant')
}

function mergeAssistantRecord(existing: AgentMessage, incoming: AgentMessage): AgentMessage {
  const parts = new Map(existing.parts.map((part) => [part.id, part]))
  for (const part of incoming.parts) parts.set(part.id, part)
  return {
    ...existing,
    ...incoming,
    createdAt: existing.createdAt,
    parts: [...parts.values()]
  }
}

/** Map one documented Claude Code stream-json record to CodeInOven's stable shapes. */
export function mapClaudeCodeRecord(
  value: unknown,
  context: CliLineParseContext
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  const type = string(entry['type'])
  const nativeSessionId = string(entry['session_id'])
  if (type === 'system' && entry['subtype'] === 'init') return { nativeSessionId }

  if (type === 'system' && entry['subtype'] === 'api_retry') {
    const delayMs = numberProperty(entry, 'retry_delay_ms', 'retryDelayMs') ?? 0
    const rawError =
      serializeContent(entry['error']) ?? 'Claude Code is retrying the provider request'
    return {
      nativeSessionId,
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'waiting',
            issue: {
              kind: 'rate_limit',
              message: 'Claude Code is waiting before retrying the provider request.',
              rawError,
              harnessId: 'claude-code',
              retryable: true,
              ...(delayMs > 0 ? { retryAt: Date.now() + delayMs } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'assistant') {
    const rawMessage = record(entry['message'])
    if (!rawMessage) return nativeSessionId ? { nativeSessionId } : null
    const incoming = messageFromAssistant(rawMessage)
    const existing = context.session.messages.find((message) => message.id === incoming.id)
    const mapped = existing ? mergeAssistantRecord(existing, incoming) : incoming
    const usageEvent = mapped.tokens
      ? [
          {
            type: 'usage.updated' as const,
            sessionId: context.sessionId,
            messageId: mapped.id,
            tokens: mapped.tokens
          }
        ]
      : []
    return {
      nativeSessionId,
      messages: [mapped],
      events: [
        { type: 'session.status', sessionId: context.sessionId, status: { state: 'working' } },
        ...mapped.parts.map((part) => ({
          type: 'message.part.updated' as const,
          sessionId: context.sessionId,
          part
        })),
        ...usageEvent
      ]
    }
  }

  if (type === 'user') {
    const rawMessage = record(entry['message'])
    const content = rawMessage && Array.isArray(rawMessage['content']) ? rawMessage['content'] : []
    const parts: AgentPart[] = []
    for (const blockValue of content) {
      const block = record(blockValue)
      if (!block || block['type'] !== 'tool_result') continue
      const callId = string(block['tool_use_id'])
      if (!callId) continue
      const existing = findToolPart(context, callId)
      if (!existing) continue
      const output = serializeContent(block['content'])
      const failed = block['is_error'] === true
      parts.push(
        toolPart(
          existing.messageID,
          callId,
          existing.tool,
          existing.state.input,
          failed ? 'error' : 'completed',
          output
        )
      )
    }
    if (!parts.length) return nativeSessionId ? { nativeSessionId } : null
    const updated = parts.map((part) => ({
      type: 'message.part.updated' as const,
      sessionId: context.sessionId,
      part
    }))
    return { nativeSessionId, events: updated }
  }

  if (type === 'stream_event') {
    const event = record(entry['event'])
    const eventType = string(event?.['type'])
    if (eventType === 'message_start') {
      const rawMessage = record(event?.['message'])
      if (!rawMessage) return nativeSessionId ? { nativeSessionId } : null
      const incoming = messageFromAssistant(rawMessage)
      const existing = context.session.messages.find((message) => message.id === incoming.id)
      return {
        nativeSessionId,
        messages: [existing ? mergeAssistantRecord(existing, incoming) : incoming]
      }
    }
    const current = latestAssistant(context)
    if (eventType === 'content_block_start' && current) {
      const block = record(event?.['content_block'])
      const index = number(event?.['index']) ?? current.parts.length
      const part = block ? partFromBlock(current.id, block, index) : null
      return part
        ? {
            nativeSessionId,
            events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
          }
        : nativeSessionId
          ? { nativeSessionId }
          : null
    }
    if (eventType === 'message_delta' && current) {
      const tokens = tokenUsage(event?.['usage'])
      return tokens
        ? {
            nativeSessionId,
            events: [
              {
                type: 'usage.updated',
                sessionId: context.sessionId,
                messageId: current.id,
                tokens
              }
            ]
          }
        : nativeSessionId
          ? { nativeSessionId }
          : null
    }
    const delta = event && record(event['delta'])
    if (eventType !== 'content_block_delta' || !delta || !current) {
      return nativeSessionId ? { nativeSessionId } : null
    }
    const deltaType = string(delta['type'])
    const text =
      deltaType === 'thinking_delta'
        ? string(delta['thinking'])
        : deltaType === 'text_delta'
          ? string(delta['text'])
          : undefined
    if (!text) return nativeSessionId ? { nativeSessionId } : null
    const index = number(event['index']) ?? 0
    const partKind = deltaType === 'thinking_delta' ? 'thinking' : 'text'
    return {
      nativeSessionId,
      events: [
        {
          type: 'message.part.delta',
          sessionId: context.sessionId,
          messageId: current.id,
          partId: `claude-${partKind}-${current.id}-${index}`,
          field: 'text',
          delta: text
        }
      ]
    }
  }

  if (type === 'rate_limit_event') {
    const info = entry['rate_limit_info'] ?? entry['rateLimitInfo']
    const limits = rateLimitWindows(info)
    const latest = latestAssistant(context)
    const details = record(info)
    const status = string(details?.['status'])
    const retryAt = epochMilliseconds(details?.['resetsAt'] ?? details?.['resets_at'])
    return {
      nativeSessionId,
      events: [
        ...(latest && limits.length > 0
          ? [
              {
                type: 'usage.updated' as const,
                sessionId: context.sessionId,
                messageId: latest.id,
                rateLimits: limits
              }
            ]
          : []),
        ...(status === 'rejected'
          ? [
              {
                type: 'session.error' as const,
                sessionId: context.sessionId,
                error: 'Claude session limit reached.',
                issue: {
                  kind: 'quota' as const,
                  message: 'Claude session limit reached.',
                  harnessId: 'claude-code',
                  retryable: retryAt !== undefined,
                  ...(retryAt === undefined ? {} : { retryAt })
                }
              }
            ]
          : [])
      ]
    }
  }

  if (type === 'result') {
    const latest = latestAssistant(context)
    const modelUsage = aggregateModelUsage(entry['modelUsage'] ?? entry['model_usage'])
    const tokens = preserveReasoningUsage(
      tokenUsage(entry['usage']) ?? modelUsage.tokens,
      latest?.tokens
    )
    const cost = numberProperty(entry, 'total_cost_usd', 'totalCostUsd') ?? modelUsage.cost
    const contextWindow =
      numberProperty(entry, 'context_window', 'contextWindow') ?? modelUsage.contextWindow
    const contextUsed =
      numberProperty(entry, 'context_used', 'contextUsed', 'current_usage') ??
      latestIterationContextUsed(entry['usage'])
    const reportedRateLimits = rateLimitWindows(entry['rate_limits'] ?? entry['rateLimits'])
    const structuredOutput = entry['structured_output'] ?? entry['structuredOutput']
    const error =
      entry['subtype'] === 'success' && entry['is_error'] !== true
        ? undefined
        : (string(entry['result']) ?? string(entry['subtype']) ?? 'Claude Code turn failed')
    const inheritedRateLimits = claudeSessionLimitIssue(error, [])
      ? latestClaudeRateLimits(context)
      : []
    const rateLimits = reportedRateLimits.length > 0 ? reportedRateLimits : inheritedRateLimits
    const issue = claudeSessionLimitIssue(error, rateLimits)
    return {
      nativeSessionId,
      events: latest
        ? [
            ...(tokens ||
            cost !== undefined ||
            contextWindow !== undefined ||
            contextUsed !== undefined ||
            rateLimits.length > 0
              ? [
                  {
                    type: 'usage.updated' as const,
                    sessionId: context.sessionId,
                    messageId: latest.id,
                    ...(tokens ? { tokens } : {}),
                    ...(cost === undefined ? {} : { cost }),
                    ...(contextWindow === undefined ? {} : { contextWindow }),
                    ...(contextUsed === undefined ? {} : { contextUsed }),
                    ...(rateLimits.length > 0 ? { rateLimits } : {})
                  }
                ]
              : []),
            {
              type: 'message.completed',
              sessionId: context.sessionId,
              messageId: latest.id,
              error,
              ...(tokens ? { tokens } : {}),
              ...(contextWindow === undefined ? {} : { contextWindow }),
              ...(contextUsed === undefined ? {} : { contextUsed }),
              ...(rateLimits.length > 0 ? { rateLimits } : {}),
              ...(issue ? { issue } : {}),
              ...(structuredOutput === undefined ? {} : { structuredOutput })
            }
          ]
        : error
          ? [
              {
                type: 'session.error',
                sessionId: context.sessionId,
                error,
                ...(issue ? { issue } : {})
              }
            ]
          : []
    }
  }
  return nativeSessionId ? { nativeSessionId } : null
}

/** Claude Code CLI driver backed by one documented stream-json process per turn. */
export class ClaudeCodeDriver extends PersistentCliDriver {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'mirrored',
    interactivePermissions: false,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: false,
    subagents: false,
    structuredOutput: true,
    nativeUtilities: ['web_search', 'web_fetch']
  }
  private readonly pendingRateLimits = new Map<string, AgentRateLimitWindow[]>()

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {
    super(storage)
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    let anthropicCatalog: ProviderCatalog
    try {
      const models = await discoverClaudeModels(projectPath)
      if (models.length === 0) throw new Error('Claude Code returned no account-selectable models')
      anthropicCatalog = {
        id: 'anthropic',
        name: 'Anthropic',
        harnessId: 'claude-code',
        models
      }
    } catch (error) {
      Logger.info('Claude Code model discovery fell back to the account default', {
        error: error instanceof Error ? error.message : String(error)
      })
      anthropicCatalog = {
        id: 'anthropic',
        name: 'Anthropic',
        harnessId: 'claude-code',
        models: [fallbackClaudeModel()],
        catalogStatus: 'unavailable',
        catalogMessage: 'Claude Code could not report account-selectable models; using Default.'
      }
    }
    if (!this.baseUrlProviders) return [anthropicCatalog]
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    if (customProviders.length === 0) return [anthropicCatalog]
    return [
      anthropicCatalog,
      ...customProviders.map((custom) => ({
        id: custom.id,
        name: custom.name,
        harnessId: 'claude-code',
        models: custom.models.map((model) => ({
          id: model.id,
          providerId: custom.id,
          name: model.name || model.id,
          reasoning: model.reasoning,
          thinkingPresets: model.reasoning
            ? (model.thinkingPresets ?? THINKING_PRESETS)
            : undefined,
          attachment: true,
          toolcall: true,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
        }))
      }))
    ]
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const anthropic = (await this.listProviders(projectPath)).find(
      (catalog) => catalog.id === 'anthropic'
    )
    const candidates = ['haiku', 'sonnet'].flatMap((modelId) =>
      anthropic?.models.some((model) => model.id === modelId)
        ? [{ providerId: 'anthropic', modelId }]
        : []
    )
    return this.generateTitleWithCandidates(projectPath, options, candidates)
  }

  /** Append user input to Claude's realtime stream while its turn is active. */
  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    this.writeActiveInput(
      session.id,
      await claudeStreamInput(options.text, options.attachments, 'now')
    )
    this.appendUserMessage(session, options)
    await this.persistSession(session)
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
          throw new TypeError(`Claude MCP utility "${utility.name}" requires a command`)
        }
        mcpServers[key] = {
          type: 'stdio',
          command: config.command,
          args: [...(config.args ?? [])],
          env: { ...(config.environment ?? {}) }
        }
        continue
      }
      if (!config.url) {
        throw new TypeError(`Claude MCP utility "${utility.name}" requires a URL`)
      }
      mcpServers[key] = {
        type: config.transport,
        url: config.url
      }
    }

    if (Object.keys(mcpServers).length === 0) return {}
    return {
      args: ['--mcp-config', '{{config:claude-mcp}}', '--strict-mcp-config'],
      configFiles: [
        {
          id: 'claude-mcp',
          relativePath: 'claude/mcp.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        }
      ]
    }
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('claude', ['--version'], {
        cwd: projectPath,
        env: buildHarnessEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) =>
        reject(new Error(`Claude Code CLI is unavailable: ${error.message}`))
      )
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(`Claude Code CLI version probe failed${stderr ? `: ${stderr.trim()}` : ''}`)
            )
      )
    })
  }

  /** Claude Code accepts ephemeral settings JSON, avoiding global or project config writes. */
  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--thinking-display',
      'summarized'
    ]
    if (session.nativeSessionId) args.push('--resume', session.nativeSessionId)
    const fastInference =
      options.settings.inferenceMode === 'fast' && options.settings.providerId === 'anthropic'
    const modelId = fastInference
      ? fastSelectionModelId(options.settings.harnessId, options.settings.modelId)
      : options.settings.modelId
    if (modelId) args.push('--model', modelId)
    args.push('--effort', claudeEffort(options.settings.thinkingLevel))
    args.push(
      '--settings',
      JSON.stringify({ showThinkingSummaries: true, ...(fastInference ? { fastMode: true } : {}) })
    )
    if (options.systemPrompt) args.push('--append-system-prompt', options.systemPrompt)
    if (options.allowedTools !== undefined) args.push('--tools', options.allowedTools.join(','))
    else if (options.readOnly) args.push('--tools', 'Read,Glob,Grep,WebFetch,WebSearch')
    if (options.structuredOutput)
      args.push('--json-schema', JSON.stringify(options.structuredOutput.schema))
    if (options.settings.permissionLevel === 'full_access')
      args.push('--permission-mode', 'bypassPermissions')
    else if (options.settings.permissionLevel === 'auto_review')
      args.push('--permission-mode', 'dontAsk')
    else args.push('--permission-mode', 'dontAsk')
    const env = await this.customProviderEnv(options.settings.providerId)
    return {
      command: 'claude',
      args,
      input: await claudeStreamInput(options.text, options.attachments),
      keepInputOpen: true,
      env,
      provenanceModelId: resolveFastModelId(modelId, fastInference ? 'fast' : 'normal')
    }
  }

  /**
   * Route a custom base-URL provider into Claude Code's env when the selected
   * provider is one of our custom endpoints. Claude Code supports a single
   * active endpoint per process, so only the selected provider is applied.
   */
  private async customProviderEnv(providerId: string): Promise<NodeJS.ProcessEnv> {
    const env = buildHarnessEnvironment()
    if (!this.baseUrlProviders || !this.secretVault || !providerId) return env
    const provider = await this.baseUrlProviders.getProvider(this.id, providerId)
    if (!provider || provider.harnessId !== this.id || !provider.enabled) return env
    env['ANTHROPIC_BASE_URL'] = provider.baseURL
    if (provider.apiKeyRef) {
      const apiKey = await this.secretVault.resolve(provider.apiKeyRef)
      if (apiKey) env['ANTHROPIC_AUTH_TOKEN'] = apiKey
    }
    return env
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const entry = record(value)
    const type = string(entry?.['type'])
    if (type === 'rate_limit_event' && !latestAssistant(context)) {
      const limits = rateLimitWindows(entry?.['rate_limit_info'] ?? entry?.['rateLimitInfo'])
      if (limits.length > 0) this.pendingRateLimits.set(context.sessionId, limits)
    }

    const result = mapClaudeCodeRecord(value, context)
    if (type === 'result') this.closeActiveInput(context.sessionId)
    if (!result) return null
    const assistant = result.messages?.find((message) => message.role === 'assistant')
    const pending = this.pendingRateLimits.get(context.sessionId)
    if (assistant && pending?.length) {
      assistant.rateLimits = pending
      result.events = [
        ...(result.events ?? []),
        {
          type: 'usage.updated',
          sessionId: context.sessionId,
          messageId: assistant.id,
          rateLimits: pending
        }
      ]
      this.pendingRateLimits.delete(context.sessionId)
    } else if (type === 'result') {
      this.pendingRateLimits.delete(context.sessionId)
    }
    return result
  }
}

function claudeEffort(value: SendPromptOptions['settings']['thinkingLevel']): string {
  if (value === 'minimal') return 'low'
  if (value === 'ultra') return 'max'
  return value
}
