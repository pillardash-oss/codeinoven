import { execFile, spawn } from 'child_process'
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
  AgentUsageCredits,
  ProviderCatalog,
  ProviderModel,
  PromptAttachment,
  ThinkingPreset
} from '../../lib/types'
import { fastSelectionModelId, resolveFastModelId } from '../../lib/fast-inference'
import type { StorageEngine } from '../storage/storage-engine'
import { BaseUrlProviderService } from '../providers/base-url-provider-service'
import { Logger } from '../system/logger'
import { SecretVault } from '../storage/secret-vault'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import type {
  GenerateTitleOptions,
  HarnessAuthStatus,
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
const CLAUDE_USAGE_TIMEOUT_MS = 12_000
/** How long a successful `claude auth status` pre-flight verdict is trusted. */
const PRE_FLIGHT_AUTH_PROBE_TTL_MS = 30_000
/** Bounded wait for the `claude auth status` pre-flight probe. */
const PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS = 8_000
/**
 * How long a first-party session spawn may hold the credential-refresh gate
 * while it resolves authentication. The gate exists because Claude Code's
 * macOS keychain OAuth store races when two processes refresh a single-use
 * token concurrently (anthropics/claude-code#76905); it is released early as
 * soon as the session proves authentication, and this bound keeps unrelated
 * threads/projects from ever stalling indefinitely.
 */
const AUTH_CONFIRM_TIMEOUT_MS = 1_500
/** Poll interval while waiting for a spawned session to prove authentication. */
const AUTH_CONFIRM_POLL_MS = 200
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
type ClaudeAccountUsage = {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  contextWindow?: number
  contextUsed?: number
}

interface ClaudeUsageProbe {
  usageRequestId: string
  contextRequestId: string
  rateLimitsPayload: Record<string, unknown> | null
  rateLimitsResponded: boolean
  contextPayload: Record<string, unknown> | null
  contextResponded: boolean
  timer: ReturnType<typeof setTimeout>
  promise: Promise<Record<string, unknown> | null>
  resolve: (value: Record<string, unknown> | null) => void
}

interface ClaudeAuthenticationReadiness {
  promise: Promise<boolean>
  resolve: (authenticated: boolean) => void
  settled: boolean
}
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

function claudeAuthenticationResult(value: unknown): boolean | undefined {
  const entry = record(value)
  const type = string(entry?.['type'])
  if (type === 'assistant') {
    return entry?.['error'] === 'authentication_failed' ||
      entry?.['error'] === 'oauth_org_not_allowed'
      ? false
      : true
  }
  if (type !== 'stream_event') return undefined
  return string(record(entry?.['event'])?.['type']) === 'message_start' ? true : undefined
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
  // The `get_usage` rate_limits object mixes real windows (five_hour, seven_day,
  // per-model windows) with account-state payloads (extra_usage, limits, spend,
  // member_dashboard_available) that carry no window utilization or reset. Only
  // surface entries that represent an actual quota window so the battery never
  // renders meaningless "usage limit" rows.
  if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
    return null
  }
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
    const rawError = mapped.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    const authenticationFailure = entry['error'] === 'authentication_failed'
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
        ...usageEvent,
        ...(authenticationFailure
          ? [
              {
                type: 'message.completed' as const,
                sessionId: context.sessionId,
                messageId: mapped.id,
                error: rawError || 'Claude Code authentication failed.',
                issue: {
                  kind: 'authentication' as const,
                  message: 'Claude Code sign-in expired. Sign in again, then retry this message.',
                  rawError: rawError || 'Claude Code authentication failed.',
                  harnessId: 'claude-code',
                  retryable: true
                }
              }
            ]
          : [])
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
    runtimeTopology: { kind: 'turn_process', scope: 'session' },
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
  private readonly activeUsageProbes = new Map<string, ClaudeUsageProbe>()
  private readonly authenticationReadiness = new Map<string, ClaudeAuthenticationReadiness>()
  /** Cached `claude auth status` verdict per project, so a fresh thread never
   *  re-spawns the CLI for auth on every message. */
  private readonly authProbeCache = new Map<string, { authenticated: boolean; at: number }>()
  /**
   * Sessions whose live process has already proven authentication this run.
   * Once any live session authenticates, the shared keychain credential is
   * fresh, so concurrent spawns are safe and the credential-refresh gate is
   * skipped for every other thread and project.
   */
  private readonly authenticatedSessions = new Set<string>()
  /** First-party sessions (shared Anthropic OAuth credential) spawned this run. */
  private readonly firstPartySessions = new Set<string>()
  /** Held while a first-party session spawn may be refreshing the credential. */
  private authSlotHeld = false
  /** Resolved when the current credential-refresh window closes. */
  private authSlot: Promise<void> = Promise.resolve()
  private usageProbeSequence = 0

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
      const models = await this.runAuthSerialized(() => discoverClaudeModels(projectPath))
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
    const firstParty = !options.settings.providerId || options.settings.providerId === 'anthropic'
    if (
      firstParty &&
      (!options.parentSessionId ||
        !(await this.waitForParentAuthentication(options.parentSessionId)))
    ) {
      return null
    }
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
    // Pre-flight auth gate at message-send time (buildTurnCommand runs per turn,
    // never on thread open). For first-party Anthropic turns, probe the CLI's
    // stored credential so the CLI's own silent OAuth refresh is triggered up
    // front; if it genuinely cannot authenticate, fail with a clean early
    // authentication issue instead of a confusing mid-turn authentication_failed.
    const firstParty = !options.settings.providerId || options.settings.providerId === 'anthropic'
    if (firstParty && !this.isTitleSession(session.id)) {
      const authenticated = await this.probeFirstPartyAuthentication(_projectPath)
      if (!authenticated) {
        throw new Error('Claude Code sign-in required. Sign in, then retry this message.')
      }
    }
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
    const input = await claudeStreamInput(options.text, options.attachments)
    const trackAuthentication =
      !this.isTitleSession(session.id) &&
      (!options.settings.providerId || options.settings.providerId === 'anthropic')
    if (trackAuthentication) this.beginAuthenticationReadiness(session.id)
    return {
      command: 'claude',
      args,
      input,
      keepInputOpen: true,
      env,
      provenanceModelId: resolveFastModelId(modelId, fastInference ? 'fast' : 'normal'),
      ...(trackAuthentication
        ? {
            onJsonRecord: (value: unknown) => {
              const result = claudeAuthenticationResult(value)
              if (result !== undefined) this.settleAuthenticationReadiness(session.id, result)
            },
            onProcessExit: () => this.settleAuthenticationReadiness(session.id, false)
          }
        : {})
    }
  }

  private beginAuthenticationReadiness(sessionId: string): void {
    let resolveReadiness: (authenticated: boolean) => void = () => undefined
    const promise = new Promise<boolean>((resolve) => {
      resolveReadiness = resolve
    })
    this.authenticationReadiness.set(sessionId, {
      promise,
      resolve: resolveReadiness,
      settled: false
    })
  }

  private settleAuthenticationReadiness(sessionId: string, authenticated: boolean): void {
    const readiness = this.authenticationReadiness.get(sessionId)
    if (!readiness || readiness.settled) return
    readiness.settled = true
    readiness.resolve(authenticated)
  }

  private async waitForParentAuthentication(sessionId: string): Promise<boolean> {
    const readiness = this.authenticationReadiness.get(sessionId)
    if (!readiness) return false
    const authenticated = await readiness.promise
    if (this.authenticationReadiness.get(sessionId) === readiness) {
      this.authenticationReadiness.delete(sessionId)
    }
    return authenticated
  }

  /**
   * Serialize the credential-refresh window for first-party session spawns.
   * Claude Code's macOS keychain OAuth store races when two processes refresh
   * a single-use token concurrently and the loser wipes the shared credential
   * (anthropics/claude-code#76905), forcing repeated re-logins. Only the first
   * spawn that has not yet authenticated may touch the credential; every other
   * thread/project waits only until that session proves authentication, then
   * spawns freely. Custom base-URL providers never share the Anthropic OAuth
   * credential, so they bypass the gate entirely.
   */
  override async sendPrompt(projectPath: string, opts: SendPromptOptions): Promise<void> {
    const firstParty = !opts.settings.providerId || opts.settings.providerId === 'anthropic'
    if (firstParty) this.firstPartySessions.add(opts.sessionId)
    if (firstParty && !this.hasLiveAuthenticatedSession()) {
      const release = await this.acquireAuthSlot()
      try {
        if (this.hasLiveAuthenticatedSession()) {
          await super.sendPrompt(projectPath, opts)
          return
        }
        await super.sendPrompt(projectPath, opts)
        await this.waitForAuthConfirmation(opts.sessionId)
      } finally {
        release()
      }
      return
    }
    await super.sendPrompt(projectPath, opts)
  }

  /**
   * Whether any live session has already authenticated this run. The shared
   * credential is considered fresh in that case, so no serialization is needed.
   */
  private hasLiveAuthenticatedSession(): boolean {
    const live = this.activeSessionIds()
    return live.some(
      (sessionId) =>
        this.firstPartySessions.has(sessionId) && this.authenticatedSessions.has(sessionId)
    )
  }

  /**
   * Claim the credential-refresh window, waiting for any in-flight window to
   * close first. The window covers the CLI's silent OAuth refresh at process
   * startup — only one first-party spawn may be inside it at a time.
   */
  private async acquireAuthSlot(): Promise<() => void> {
    for (;;) {
      if (this.authSlotHeld) {
        await this.authSlot
        continue
      }
      this.authSlotHeld = true
      break
    }
    let release: (() => void) | undefined
    this.authSlot = new Promise<void>((resolve) => (release = resolve))
    return () => {
      release?.()
      this.authSlotHeld = false
    }
  }

  /**
   * Run an auth-touching CLI operation under the credential-refresh gate. The
   * gate is engaged only while no live session has authenticated; once one has,
   * the credential is fresh and the operation runs with full concurrency.
   */
  private async runAuthSerialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.hasLiveAuthenticatedSession()) return operation()
    const release = await this.acquireAuthSlot()
    try {
      return await operation()
    } finally {
      release()
    }
  }

  /**
   * Hold the credential-refresh window until the guarded session proves
   * authentication, exits, or the bound expires — the window in which the CLI
   * may refresh the shared keychain credential. Resolving early on
   * authentication lets the next concurrent spawn proceed without a refresh.
   */
  private async waitForAuthConfirmation(sessionId: string): Promise<void> {
    const deadline = Date.now() + AUTH_CONFIRM_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.authenticatedSessions.has(sessionId)) return
      if (!this.activeSessionIds().includes(sessionId)) return
      await new Promise<void>((resolve) => setTimeout(resolve, AUTH_CONFIRM_POLL_MS))
    }
  }

  /**
   * Pre-flight probe of the first-party Anthropic credential. Shells
   * `claude auth status --json` and trusts its `loggedIn` verdict, letting the
   * CLI's own silent OAuth refresh run before a turn is dispatched. The result
   * is cached per project for a short window so a session's consecutive
   * messages do not each re-spawn the CLI. On any probe failure (CLI missing,
   * timeout, unparseable output) we assume authenticated so the turn still has
   * a chance to report the real error mid-stream rather than being silently
   * blocked by an unreliable pre-check.
   */
  private async probeFirstPartyAuthentication(projectPath: string): Promise<boolean> {
    const now = Date.now()
    const cached = this.authProbeCache.get(projectPath)
    if (cached && now - cached.at < PRE_FLIGHT_AUTH_PROBE_TTL_MS) return cached.authenticated
    const authenticated = await new Promise<boolean>((resolve) => {
      execFile(
        'claude',
        ['auth', 'status', '--json'],
        {
          cwd: projectPath,
          env: buildHarnessEnvironment(),
          timeout: PRE_FLIGHT_AUTH_PROBE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024
        },
        (error, stdout) => {
          if (error) {
            resolve(true)
            return
          }
          try {
            const parsed = JSON.parse(stdout) as { loggedIn?: unknown }
            resolve(parsed['loggedIn'] === true)
          } catch {
            resolve(true)
          }
        }
      )
    })
    this.authProbeCache.delete(projectPath)
    if (authenticated) this.authProbeCache.set(projectPath, { authenticated, at: now })
    return authenticated
  }

  /**
   * Current authentication state of the shared first-party credential, probed
   * through the credential-refresh gate so a thread-open check can never race
   * a concurrent refresh (anthropics/claude-code#76905). Probe failures are
   * reported as authenticated so real errors still surface at message time.
   */
  async getAuthStatus(projectPath: string): Promise<HarnessAuthStatus> {
    const authenticated = await this.runAuthSerialized(() =>
      this.probeFirstPartyAuthentication(projectPath)
    )
    if (!authenticated) {
      return {
        state: 'unauthenticated',
        accounts: [],
        detail: 'Claude Code could not authenticate with the stored credential.'
      }
    }
    return {
      state: 'authenticated',
      accounts: [{ id: 'anthropic', label: 'Anthropic', method: 'oauth', active: true }]
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

  private readUsageFromActiveSession(sessionId: string): Promise<Record<string, unknown> | null> {
    const existing = this.activeUsageProbes.get(sessionId)
    if (existing) return existing.promise

    const sequence = ++this.usageProbeSequence
    const usageRequestId = `codeinoven-usage-${sequence}`
    const contextRequestId = `codeinoven-context-${sequence}`
    let resolveProbe: (value: Record<string, unknown> | null) => void = () => undefined
    const promise = new Promise<Record<string, unknown> | null>((resolve) => {
      resolveProbe = resolve
    })
    const probe: ClaudeUsageProbe = {
      usageRequestId,
      contextRequestId,
      rateLimitsPayload: null,
      rateLimitsResponded: false,
      contextPayload: null,
      contextResponded: false,
      timer: setTimeout(
        () => this.finishActiveUsageProbe(sessionId, null),
        CLAUDE_USAGE_TIMEOUT_MS
      ),
      promise,
      resolve: resolveProbe
    }
    this.activeUsageProbes.set(sessionId, probe)
    try {
      this.writeActiveInput(
        sessionId,
        `${JSON.stringify({
          type: 'control_request',
          request_id: usageRequestId,
          request: { subtype: 'get_usage' }
        })}\n`
      )
      this.writeActiveInput(
        sessionId,
        `${JSON.stringify({
          type: 'control_request',
          request_id: contextRequestId,
          request: { subtype: 'get_context_usage' }
        })}\n`
      )
    } catch {
      this.finishActiveUsageProbe(sessionId, null)
    }
    return promise
  }

  private finishActiveUsageProbe(sessionId: string, value: Record<string, unknown> | null): void {
    const probe = this.activeUsageProbes.get(sessionId)
    if (!probe) return
    this.activeUsageProbes.delete(sessionId)
    clearTimeout(probe.timer)
    probe.resolve(value)
  }

  private captureActiveUsageResponse(
    sessionId: string,
    entry: Record<string, unknown> | null
  ): void {
    const probe = this.activeUsageProbes.get(sessionId)
    if (!probe || entry?.['type'] !== 'control_response') return
    const response = record(entry['response'])
    const inner = record(response?.['response'])
    const requestId = string(response?.['request_id'])
    if (requestId === probe.usageRequestId) {
      probe.rateLimitsResponded = true
      const rateLimits = record(inner?.['rate_limits'])
      probe.rateLimitsPayload =
        inner?.['rate_limits_available'] === true && rateLimits ? inner : null
    } else if (requestId === probe.contextRequestId) {
      probe.contextResponded = true
      probe.contextPayload = inner
    } else {
      return
    }

    if (probe.rateLimitsResponded && probe.rateLimitsPayload === null) {
      this.finishActiveUsageProbe(sessionId, {
        rateLimits: null,
        context: probe.contextPayload
      })
    } else if (probe.rateLimitsResponded && probe.contextResponded) {
      this.finishActiveUsageProbe(sessionId, {
        rateLimits: probe.rateLimitsPayload,
        context: probe.contextPayload
      })
    }
  }

  private mapAccountUsage(telemetry: Record<string, unknown> | null): ClaudeAccountUsage | null {
    if (!telemetry) return null
    const usage = record(telemetry['rateLimits'])
    const context = record(telemetry['context'])
    const rateLimits = usage ? rateLimitWindows(usage['rate_limits']) : []
    if (rateLimits.length === 0 && !context) return null
    const contextWindow =
      context === null ? undefined : numberProperty(context, 'maxTokens', 'max_tokens')
    const contextUsed =
      context === null ? undefined : numberProperty(context, 'totalTokens', 'total_tokens')
    return {
      rateLimits,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextUsed === undefined ? {} : { contextUsed })
    }
  }

  /**
   * Fetch the account's current plan rate-limit windows and live context-window
   * usage on demand via the `get_usage` + `get_context_usage` control requests.
   * These run WITHOUT a model turn (`total_api_duration_ms` stays 0), so the
   * battery can show live quota and the context percent for old threads whose
   * turns predate capture. Returns null when the session has no plan limits
   * (API key, Bedrock, Vertex) or on any failure.
   */
  async readAccountUsage(projectPath: string): Promise<ClaudeAccountUsage | null> {
    const activeSessionId = this.activeSessionIds()[0]
    if (activeSessionId) {
      return this.mapAccountUsage(await this.readUsageFromActiveSession(activeSessionId))
    }
    try {
      const telemetry = await this.runAuthSerialized(
        () =>
          new Promise<Record<string, unknown> | null>((resolve) => {
            const child = spawn(
              'claude',
              [
                '--print',
                '--output-format',
                'stream-json',
                '--input-format',
                'stream-json',
                '--verbose'
              ],
              {
                cwd: projectPath,
                env: buildHarnessEnvironment(),
                stdio: ['pipe', 'pipe', 'pipe']
              }
            )
            let buffer = ''
            let settled = false
            const timer = setTimeout(() => finish(null), CLAUDE_USAGE_TIMEOUT_MS)
            const finish = (value: Record<string, unknown> | null): void => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              if (!child.killed) child.kill()
              resolve(value)
            }
            let rateLimitsPayload: Record<string, unknown> | null = null
            let rateLimitsResponded = false
            let contextPayload: Record<string, unknown> | null = null
            let contextResponded = false
            const attemptFinish = (): void => {
              if (settled) return
              // If the session has no plan rate limits, stop waiting for context and
              // report nothing. Otherwise wait for both responses so quota and
              // context are reported together; the timeout covers a missing response.
              if (rateLimitsResponded && rateLimitsPayload === null) {
                finish({ rateLimits: null, context: contextPayload })
                return
              }
              if (rateLimitsResponded && contextResponded) {
                finish({ rateLimits: rateLimitsPayload, context: contextPayload })
              }
            }
            const consume = (line: string): void => {
              if (!line.trim()) return
              const payload = record(JSON.parse(line) as unknown)
              if (!payload) return
              if (payload['type'] !== 'control_response') return
              const response = record(payload['response'])
              const inner = record(response?.['response'])
              const requestId = string(response?.['request_id'])
              if (requestId === 'usage') {
                rateLimitsResponded = true
                const rateLimits = record(inner?.['rate_limits'])
                rateLimitsPayload =
                  inner?.['rate_limits_available'] === true && rateLimits ? inner : null
              } else if (requestId === 'context') {
                contextResponded = true
                contextPayload = inner
              }
              attemptFinish()
            }
            child.stdout?.on('data', (chunk: Buffer) => {
              buffer += chunk.toString()
              const lines = buffer.split(/\r?\n/u)
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                try {
                  consume(line)
                } catch {
                  // Ignore malformed side-channel output.
                }
              }
            })
            child.on('error', () => finish(null))
            child.on('exit', () => {
              if (!settled) finish(null)
            })
            // Send both control requests immediately; `--print` waits on stdin.
            child.stdin?.write(
              `${JSON.stringify({
                type: 'control_request',
                request_id: 'usage',
                request: { subtype: 'get_usage' }
              })}\n`
            )
            child.stdin?.write(
              `${JSON.stringify({
                type: 'control_request',
                request_id: 'context',
                request: { subtype: 'get_context_usage' }
              })}\n`
            )
          })
      )
      return this.mapAccountUsage(telemetry)
    } catch (error) {
      Logger.dev('Claude on-demand account usage refresh unavailable:', error)
      return null
    }
  }

  override dispose(): void {
    this.authProbeCache.clear()
    this.authenticatedSessions.clear()
    this.firstPartySessions.clear()
    for (const sessionId of this.activeUsageProbes.keys()) {
      this.finishActiveUsageProbe(sessionId, null)
    }
    for (const [sessionId, readiness] of this.authenticationReadiness) {
      if (!readiness.settled) readiness.resolve(false)
      this.authenticationReadiness.delete(sessionId)
    }
    super.dispose()
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const entry = record(value)
    if (claudeAuthenticationResult(entry) === true) {
      this.authenticatedSessions.add(context.sessionId)
    }
    this.captureActiveUsageResponse(context.sessionId, entry)
    const type = string(entry?.['type'])
    if (type === 'rate_limit_event' && !latestAssistant(context)) {
      const limits = rateLimitWindows(entry?.['rate_limit_info'] ?? entry?.['rateLimitInfo'])
      if (limits.length > 0) this.pendingRateLimits.set(context.sessionId, limits)
    }

    const result = mapClaudeCodeRecord(value, context)
    if (type === 'result') {
      this.finishActiveUsageProbe(context.sessionId, null)
      this.closeActiveInput(context.sessionId)
    }
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
