import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'url'
import type {
  AgentMessage,
  AgentPart,
  AgentQuestion,
  AgentRateLimitWindow,
  AgentUsageCredits,
  AgentSubagentActivity,
  AgentTokenUsage,
  PromptAttachment,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent
} from '../../lib/types'
import { PI_THINKING_PRESETS } from '../../lib/pi-thinking-presets'
import { normalizeAgentQuestions, parseRecord } from '../../lib/agent-interactions'
import { CIO_SPAWN_AGENT_TOOL_NAME, CIO_SUBAGENT_DONE_MESSAGE_TYPE } from '../../lib/core-tools'
import { buildProcessEnvironment } from './cli-environment'
import { piNativeProviderIds } from '../agents/native-provider-config-service'
import { PiAuthConfigService, piAuthFileIo } from '../providers/pi-auth-config'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import type {
  GenerateTitleOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { QuestionRequestGoneError } from './driver.interface'
import type { HarnessCommand, PermissionReply, ThreadSettings } from '../../lib/types'
import {
  classifyProviderIssue,
  extractProviderErrorEnvelope,
  parseUsageResetAt
} from '../../lib/provider-issue'
import {
  PersistentCliDriver,
  type CliLineParseContext,
  type CliLineParseResult,
  type CliTurnCommand,
  type PersistentCliSession,
  type TitleModelCandidate
} from './persistent-cli-driver'
import { inlineSvgAttachments, isSvgAttachment } from './svg-attachment'
import { piMcpExtension } from './pi-mcp-extension'
import { piCustomProvidersExtension } from './pi-providers-extension'
import {
  CIO_PERMISSION_MARKER,
  CIO_QUESTION_MARKER,
  CIO_SUBAGENT_MARKER,
  piCoreToolsExtension
} from './pi-core-tools-extension'
import { piUtilityGatewayExtension } from './pi-utility-gateway-extension'
import {
  PI_STATUS_COMPACTING,
  PI_STATUS_EXTENSION_KEY,
  PI_STATUS_IDLE,
  PI_STATUS_WORKING,
  piStatusExtension
} from './pi-status-extension'
import { PI_USAGE_EXTENSION_KEY, piUsageExtension } from './pi-usage-extension'
import { fetchPiProviderCredits } from './pi-provider-usage'
import { PiRpcClient } from './pi-rpc-client'
import {
  prepareHarnessInvocation,
  resolveHarnessRuntime,
  runHarnessCommand
} from './harness-runtime'

const THINKING_PRESETS = PI_THINKING_PRESETS
const PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS = 10_000

/** Pi thinking levels accepted by `set_thinking_level`. */
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

interface PiImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Fallback catalog used when the pi runtime reports no models. */
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

/** Numeric header value ('1234' → 1234); non-numeric returns undefined. */
function headerNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse a rate-limit reset value. Providers send either a relative duration
 * ('1s', '6m0s', '1h0m30s') or an absolute ISO timestamp; both resolve to an
 * absolute reset epoch, undefined when unparseable.
 */
function headerResetAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (/^\d/u.test(value)) {
    let seconds = 0
    for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)([hms])/gu)) {
      const n = Number(amount)
      if (!Number.isFinite(n)) return undefined
      seconds += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
    }
    if (seconds > 0) return Date.now() + seconds * 1_000
    return undefined
  }
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : undefined
}

/** Build a usage bar window from remaining/limit header pairs. */
function windowFromHeaders(
  id: string,
  label: string,
  headers: Record<string, string>,
  remainingKey: string,
  limitKey: string,
  resetKey?: string,
  extra?: Partial<AgentRateLimitWindow>
): AgentRateLimitWindow | null {
  const remaining = headerNumber(headers[remainingKey])
  const limit = headerNumber(headers[limitKey])
  if (remaining === undefined && limit === undefined) return null
  const usedPercent =
    remaining !== undefined && limit !== undefined && limit > 0
      ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
      : undefined
  const resetsAt = resetKey ? headerResetAt(headers[resetKey]) : undefined
  if (remaining === undefined && limit === undefined && resetsAt === undefined) return null
  return {
    id,
    label,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...extra
  }
}

/**
 * The pi provider id the captured headers came from, taken from the usage
 * extension's payload (`ctx.model.provider` — the same id space as thread
 * settings' providerId). Used to key persisted windows per provider.
 */
function piUsageProviderId(payload: unknown): string | undefined {
  const provider = record(payload)?.['provider']
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

/**
 * Map the usage extension's captured provider response headers into display
 * usage bars. Recognizes the Anthropic subscription unified windows (5-hour,
 * 7-day, with overage state), Anthropic per-minute request/token buckets, and
 * the OpenAI-compatible `x-ratelimit-*` family (OpenAI, OpenRouter, most
 * base-URL providers). Unrecognized headers are ignored.
 */
export function mapPiRateLimitHeaders(payload: unknown): AgentRateLimitWindow[] {
  const envelope = record(payload)
  const headers = record(envelope?.['headers'])
  if (!headers) return []
  const stringHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') stringHeaders[key.toLowerCase()] = value
  }
  const windows: AgentRateLimitWindow[] = []

  // Anthropic subscription unified windows — the quota Claude Pro/Max usage
  // bars show. Status and overage fields live on the 5-hour window, matching
  // how Claude Code surfaces them.
  const unifiedStatus = stringHeaders['anthropic-ratelimit-unified-5h-status']
  const fiveHour = windowFromHeaders(
    'pi-unified-5h',
    '5-hour limit',
    stringHeaders,
    'anthropic-ratelimit-unified-5h-remaining',
    'anthropic-ratelimit-unified-5h-limit',
    'anthropic-ratelimit-unified-5h-reset',
    {
      windowMinutes: 300,
      ...(unifiedStatus !== undefined ? { status: unifiedStatus } : {}),
      ...(stringHeaders['anthropic-ratelimit-unified-overage-status'] !== undefined
        ? { overageStatus: stringHeaders['anthropic-ratelimit-unified-overage-status'] }
        : {}),
      ...(stringHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] !== undefined
        ? {
            overageDisabledReason:
              stringHeaders['anthropic-ratelimit-unified-overage-disabled-reason']
          }
        : {})
    }
  )
  if (fiveHour) windows.push(fiveHour)
  const sevenDay = windowFromHeaders(
    'pi-unified-7d',
    '7-day limit',
    stringHeaders,
    'anthropic-ratelimit-unified-7d-remaining',
    'anthropic-ratelimit-unified-7d-limit',
    'anthropic-ratelimit-unified-7d-reset',
    { windowMinutes: 10_080 }
  )
  if (sevenDay) windows.push(sevenDay)

  // Anthropic per-minute buckets.
  const requests = windowFromHeaders(
    'pi-requests',
    'Requests',
    stringHeaders,
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-reset'
  )
  if (requests) windows.push(requests)
  const inputTokens = windowFromHeaders(
    'pi-input-tokens',
    'Input tokens',
    stringHeaders,
    'anthropic-ratelimit-input-tokens-remaining',
    'anthropic-ratelimit-input-tokens-limit',
    'anthropic-ratelimit-input-tokens-reset'
  )
  if (inputTokens) windows.push(inputTokens)

  // OpenAI-compatible family (OpenAI, OpenRouter, OpenAI-compatible proxies).
  const openAiRequests = windowFromHeaders(
    'pi-openai-requests',
    'Requests',
    stringHeaders,
    'x-ratelimit-remaining-requests',
    'x-ratelimit-limit-requests',
    'x-ratelimit-reset-requests'
  )
  if (openAiRequests) windows.push(openAiRequests)
  const openAiTokens = windowFromHeaders(
    'pi-openai-tokens',
    'Tokens',
    stringHeaders,
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-reset-tokens'
  )
  if (openAiTokens) windows.push(openAiTokens)

  return windows
}

function messageTimestamp(value: Record<string, unknown>): number {
  return numberValue(value['timestamp']) ?? Date.now()
}

/**
 * True when a Pi failure is a finish-reason flake the model can recover from by
 * simply being asked to continue. pi's provider adapter maps any unrecognized
 * provider `finish_reason` to `stopReason: "error"` with the message
 * `Provider finish_reason: <reason>` — a transient stream/provider issue, not a
 * terminal outcome. `content_filter` is the exception: re-prompting past a
 * moderation stop is wrong, so it stays a real error.
 */
export function isContinuableFinishReasonError(error: string): boolean {
  const match = error.match(/^Provider finish_reason: (.+)$/u)
  return match !== null && match[1] !== 'content_filter'
}

/** The extension tool whose calls render as sub-agent activity cards. */
const CIO_SPAWN_TOOL = CIO_SPAWN_AGENT_TOOL_NAME

/** Build a sub-agent activity part for one spawn-tool call. */
function cioSubagentPart(
  messageId: string,
  callID: string,
  input: Record<string, unknown> | null | undefined,
  patch?: Partial<AgentSubagentActivity>
): Extract<AgentPart, { type: 'subagent' }> {
  const purpose = stringValue(input?.['purpose']) ?? 'sub-agent'
  return {
    type: 'subagent',
    id: `pi-subagent-${callID}`,
    messageID: messageId,
    callID,
    activity: {
      status: 'pending',
      agent: purpose,
      description: purpose,
      prompt: stringValue(input?.['instructions']),
      background: input?.['background'] === true,
      ...patch
    }
  }
}

/** Find the running sub-agent part for a spawn call id. */
function findSubagentPart(
  context: CliLineParseContext,
  callId: string
): Extract<AgentPart, { type: 'subagent' }> | undefined {
  for (const message of [...context.session.messages].reverse()) {
    const part = message.parts.find(
      (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
        candidate.type === 'subagent' && candidate.callID === callId
    )
    if (part) return part
  }
  return undefined
}

/** Find a sub-agent part by its child session id (spawn call id may be unknown). */
function findSubagentPartByChildSession(
  context: CliLineParseContext,
  childSessionId: string | undefined
): Extract<AgentPart, { type: 'subagent' }> | undefined {
  if (!childSessionId) return undefined
  for (const message of [...context.session.messages].reverse()) {
    const part = message.parts.find(
      (candidate): candidate is Extract<AgentPart, { type: 'subagent' }> =>
        candidate.type === 'subagent' && candidate.activity.childSessionId === childSessionId
    )
    if (part) return part
  }
  return undefined
}

/**
 * Parse a `cio-subagent:` marker payload (structured sub-agent progress
 * streamed through tool-execution updates) into activity fields.
 */
function parseSubagentPayload(output: string | undefined): AgentSubagentActivity | undefined {
  if (!output || !output.startsWith(CIO_SUBAGENT_MARKER)) return undefined
  return subagentActivityFromPayload(parseRecord(output.slice(CIO_SUBAGENT_MARKER.length)))
}

/** Activity fields from the extension's structured sub-agent payload. */
function subagentActivityFromPayload(
  payload: Record<string, unknown> | undefined
): AgentSubagentActivity | undefined {
  if (!payload || !stringValue(payload['agentId'])) return undefined
  const status = stringValue(payload['status'])
  const childSessionId = stringValue(payload['childSessionId'])
  const modelId = stringValue(payload['model'])
  const output = stringValue(payload['output'])
  const error = stringValue(payload['error'])
  const sessionFile = stringValue(payload['sessionFile'])
  return {
    status:
      status === 'completed' || status === 'error'
        ? status
        : status === 'running'
          ? 'running'
          : 'pending',
    agent: stringValue(payload['purpose']) ?? 'sub-agent',
    description: stringValue(payload['purpose']) ?? 'sub-agent',
    ...(childSessionId ? { childSessionId } : {}),
    ...(modelId ? { modelId } : {}),
    background: false,
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(sessionFile ? { metadata: { sessionFile } } : {})
  }
}

/**
 * Activity patch for a spawn call whose tool result is a plain failure object
 * (`{ spawned: false, error }`) instead of a `cio-subagent:` marker payload.
 * Failed spawns carry no agentId, so subagentActivityFromPayload skips them —
 * without this patch the driver would mark the card 'completed' with no error,
 * hiding why the sub-agent never ran.
 */
function spawnFailurePatch(output: string | undefined): AgentSubagentActivity | undefined {
  if (!output) return undefined
  const payload = parseRecord(output)
  if (!payload || stringValue(payload['agentId'])) return undefined
  const error = stringValue(payload['error'])
  if (!error) return undefined
  return {
    status: 'error',
    agent: 'sub-agent',
    description: 'sub-agent',
    background: false,
    error
  }
}

/**
 * Close a sub-agent card from the `cio-subagent-done` custom message. Once a
 * background spawn's tool call has returned, pi drops tool-execution updates
 * (`acceptingUpdates` is false after execute resolves), so the extension's
 * terminal marker payload can never arrive through the tool channel and the
 * card would stay "Working" forever. The extension therefore rides the
 * completion notification — a display:false custom message the model still
 * needs for its final output — with the structured payload in `details`.
 */
function spawnDoneCustomEvent(
  message: Record<string, unknown>,
  context: CliLineParseContext
): CliLineParseResult | null {
  if (stringValue(message['customType']) !== CIO_SUBAGENT_DONE_MESSAGE_TYPE) {
    return { events: [] }
  }
  const payload = record(message['details']) ?? undefined
  const activity = subagentActivityFromPayload(payload)
  const existing = findSubagentPartByChildSession(context, stringValue(payload?.['childSessionId']))
  if (!activity || !existing) return { events: [] }
  return {
    events: [
      {
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: {
          type: 'subagent',
          id: existing.id,
          messageID: existing.messageID,
          callID: existing.callID,
          activity: {
            ...existing.activity,
            ...activity,
            background: existing.activity.background,
            time: {
              start: existing.activity.time?.start ?? Date.now(),
              end: Date.now()
            }
          }
        }
      }
    ]
  }
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
    if (stringValue(block['name']) === CIO_SPAWN_TOOL) {
      return cioSubagentPart(messageId, callID, record(block['arguments']))
    }
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

/** Highest driver-generated assistant index already present for this app
 *  session. Pi's RPC process restarts its own turn counter when an old native
 *  transcript is resumed, but CodeInOven message and part IDs must remain
 *  unique across the full persisted session. */
function latestPiTurnIndex(messages: readonly AgentMessage[], sessionId: string): number {
  const prefix = `pi-${sessionId}-`
  let latest = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id.startsWith(prefix)) continue
    const suffix = message.id.slice(prefix.length)
    if (!/^\d+$/u.test(suffix)) continue
    const index = Number(suffix)
    if (Number.isSafeInteger(index)) latest = Math.max(latest, index)
  }
  return latest
}

interface PiUiRequest {
  sessionId: string
  method: string
  client: PiRpcClient
  request: Record<string, unknown>
}

interface PiSilentContinueState {
  attempts: number
  owed: boolean
  lastError: string
}

/** Silent continues per turn before the failure is surfaced as a real error. */
const SILENT_CONTINUE_MAX_ATTEMPTS = 10

/** Map one documented Pi JSON print-mode record into CodeInOven's stable shapes. */
export function mapPiRecord(
  value: unknown,
  context: CliLineParseContext,
  turnState: PiTurnState
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  const type = stringValue(entry['type'])

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
    if (message?.['role'] === 'custom') return spawnDoneCustomEvent(message, context)
    if (message?.['role'] !== 'assistant') return { events: [] }
    return buildAssistantMessage(message, context.sessionId, turnState)
  }

  if (type === 'tool_execution_start' || type === 'tool_execution_update') {
    const callId = stringValue(entry['toolCallId'])
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    if (!callId) return { events: [] }
    const toolName = stringValue(entry['toolName']) ?? 'tool'
    const partialResult = record(entry['partialResult'])
    const partialOutput = serializeContent(partialResult?.['content'])
    if (toolName === CIO_SPAWN_TOOL) {
      const args = record(entry['args'])
      const existing = findSubagentPart(context, callId)
      const base = existing?.activity ?? cioSubagentPart(messageId, callId, args).activity
      const payloadPatch =
        type === 'tool_execution_update' ? parseSubagentPayload(partialOutput) : undefined
      return {
        events: [
          {
            type: 'message.part.updated',
            sessionId: context.sessionId,
            part: {
              type: 'subagent',
              id: existing?.id ?? `pi-subagent-${callId}`,
              messageID: existing?.messageID ?? messageId,
              callID: callId,
              activity: {
                ...base,
                ...(payloadPatch ?? {}),
                status: payloadPatch?.status ?? 'running',
                background: base.background,
                time: base.time ?? { start: Date.now() }
              }
            }
          }
        ]
      }
    }
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
    if (toolName === CIO_SPAWN_TOOL) {
      const existing = findSubagentPart(context, callId)
      const base =
        existing?.activity ?? cioSubagentPart(messageId, callId, record(entry['args'])).activity
      // The final result carries the full structured sub-agent payload.
      const payloadPatch = subagentActivityFromPayload(parseRecord(output ?? ''))
      const failurePatch = payloadPatch ? undefined : spawnFailurePatch(output)
      return {
        events: [
          {
            type: 'message.part.updated',
            sessionId: context.sessionId,
            part: {
              type: 'subagent',
              id: existing?.id ?? `pi-subagent-${callId}`,
              messageID: existing?.messageID ?? messageId,
              callID: callId,
              activity: {
                ...base,
                ...(payloadPatch ?? failurePatch ?? {}),
                status: failed
                  ? 'error'
                  : (payloadPatch?.status ?? failurePatch?.status ?? 'completed'),
                background: base.background,
                time: { start: base.time?.start ?? Date.now(), end: Date.now() }
              }
            }
          }
        ]
      }
    }
    // The end event may not repeat `args`; never wipe the input captured at start.
    const existing = findToolPart(context, callId)
    const endArgs = record(entry['args'])
    const input =
      endArgs && Object.keys(endArgs).length > 0 ? endArgs : (existing?.state.input ?? {})
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
              input,
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
      const existingToolPart = findToolPart(context, callId)
      if ((stringValue(result?.['toolName']) ?? existingToolPart?.tool) === CIO_SPAWN_TOOL) {
        const existingSubagent = findSubagentPart(context, callId)
        const base =
          existingSubagent?.activity ?? cioSubagentPart(messageId, callId, undefined).activity
        const payloadPatch = subagentActivityFromPayload(parseRecord(output ?? ''))
        const failurePatch = payloadPatch ? undefined : spawnFailurePatch(output)
        events.push({
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'subagent',
            id: existingSubagent?.id ?? `pi-subagent-${callId}`,
            messageID: existingSubagent?.messageID ?? messageId,
            callID: callId,
            activity: {
              ...base,
              ...(payloadPatch ?? failurePatch ?? {}),
              status: failed
                ? 'error'
                : (payloadPatch?.status ?? failurePatch?.status ?? 'completed'),
              background: base.background,
              time: { start: base.time?.start ?? Date.now(), end: Date.now() }
            }
          }
        })
        continue
      }
      const existing = existingToolPart
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
    const rawError = errorText(message)
    const continuable =
      message['stopReason'] === 'error' && isContinuableFinishReasonError(rawError)
    const failed =
      (message['stopReason'] === 'error' && !continuable) || message['stopReason'] === 'aborted'
    const completed: SessionAgentEvent = {
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId,
      ...(usage ? { tokens: usage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      // A continuable finish-reason flake is neutralized here; the driver
      // reads the marker back when deciding whether to silently re-prompt.
      ...(continuable ? { silentContinue: { error: rawError } } : failed ? { error: rawError } : {})
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

  if (type === 'auto_retry_end') {
    const success = entry['success'] === true
    if (success) {
      return {
        events: [
          {
            type: 'session.status',
            sessionId: context.sessionId,
            status: { state: 'working' }
          }
        ]
      }
    }
    return {
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'error',
            issue: {
              kind: 'provider_unavailable',
              message:
                stringValue(entry['finalError']) ??
                stringValue(entry['errorMessage']) ??
                'Pi retries failed',
              harnessId: 'pi',
              retryable: false,
              ...(numberValue(entry['attempt']) ? { attempt: numberValue(entry['attempt']) } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'agent_settled') {
    const session = context.session
    const lastAssistant = [...session.messages].reverse().find((message) => {
      return message.role === 'assistant'
    })
    if (lastAssistant?.error) {
      const kind = classifyProviderIssue(lastAssistant.error)
      const message = extractProviderErrorEnvelope(lastAssistant.error).message
      const retryAt =
        kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
      return {
        events: [
          {
            type: 'session.status',
            sessionId: context.sessionId,
            status: {
              state: 'error',
              issue: {
                kind,
                message,
                rawError: lastAssistant.error,
                harnessId: 'pi',
                retryable: retryAt !== undefined,
                ...(retryAt === undefined ? {} : { retryAt })
              }
            }
          }
        ]
      }
    }
    return { events: [] }
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
    // Never finalize here: a transient failure is followed by `auto_retry_start`.
    // Only `agent_settled` signals that no retry or queued continuation remains.
    return { events: [] }
  }

  return { events: [] }
}

/** Build the full assistant message and its part events from a Pi message object. */
function buildAssistantMessage(
  message: Record<string, unknown>,
  sessionId: string,
  turnState: PiTurnState
): CliLineParseResult | null {
  const content = Array.isArray(message['content']) ? message['content'] : []
  const messageId = `pi-${sessionId}-${turnState.turnIndex}`
  const now = messageTimestamp(message)
  const parts: AgentPart[] = []
  const events: SessionAgentEvent[] = []
  content.forEach((blockValue, index) => {
    const callId = toolCallId(blockValue) || `call-${index}`
    const part = mapPiContentBlock(blockValue, messageId, index, callId)
    if (!part) return
    parts.push(part)
    events.push({ type: 'message.part.updated', sessionId, part })
  })
  const usage = mapPiUsage(message['usage'])
  const cost = mapPiCost(message['usage'])
  const rawError = errorText(message)
  const continuableError =
    message['stopReason'] === 'error' && isContinuableFinishReasonError(rawError) ? rawError : null
  const failed =
    (message['stopReason'] === 'error' && continuableError === null) ||
    message['stopReason'] === 'aborted'
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
    // A continuable finish-reason flake must not mark the mirrored message as
    // failed: the driver silently re-prompts and the turn keeps going.
    ...(failed ? { error: rawError } : {})
  }
  return { events, messages: [completed] }
}

function piAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return join(homedir(), envDir.slice(2))
    return envDir
  }
  return join(homedir(), '.pi', 'agent')
}

/** Mirror pi's own session-dir encoding (`--<cwd>--` under the agent dir). */
function nativePiSessionDir(projectPath: string): string {
  const safePath = `--${projectPath.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
  return join(piAgentDir(), 'sessions', safePath)
}

/**
 * Find a native pi session transcript by session id. Pi names files
 * `<timestamp>_<sessionId>.jsonl`; the newest match wins.
 */
async function findNativePiSessionFile(
  projectPath: string,
  sessionId: string
): Promise<string | null> {
  const dir = nativePiSessionDir(projectPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const matches = entries.filter((name) => name.endsWith(`_${sessionId}.jsonl`)).sort()
  const latest = matches.at(-1)
  return latest ? join(dir, latest) : null
}

function nativeUserMessageText(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .map((block) =>
      record(block)?.['type'] === 'text' ? stringValue(record(block)?.['text']) : undefined
    )
    .filter((text): text is string => Boolean(text))
  return parts.join('\n')
}

/**
 * Serialize CodeInOven mirror messages into native pi session JSONL entries —
 * the inverse of `parseNativePiSession` at conversation granularity. Only text
 * content is carried over: tool calls and reasoning blocks are execution
 * detail the resumed model does not need, and fabricating toolResult entries
 * would desynchronize pi's own accounting. Returns an empty array when the
 * mirror carries no conversational text.
 */
function prefillTranscriptEntries(
  projectPath: string,
  messages: readonly AgentMessage[]
): string[] {
  const lines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: projectPath
    })
  ]
  let parentId: string | null = null
  let wroteMessage = false
  for (const message of messages) {
    const text = message.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (!text) continue
    const id = randomUUID()
    lines.push(
      JSON.stringify({
        type: 'message',
        id,
        parentId,
        timestamp: new Date(message.createdAt ?? Date.now()).toISOString(),
        message: { role: message.role, content: [{ type: 'text', text }] }
      })
    )
    parentId = id
    wroteMessage = true
  }
  return wroteMessage ? lines : []
}

/**
 * Parse a native pi session JSONL transcript into CodeInOven messages.
 * Used for sub-agent worker threads, which run as in-process pi sessions
 * persisted by pi's own SessionManager rather than mirrored through RPC.
 */
async function parseNativePiSession(file: string, sessionId: string): Promise<AgentMessage[]> {
  const content = await readFile(file, 'utf8')
  const messages: AgentMessage[] = []
  let turnIndex = 0
  let userIndex = 0
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown> | undefined
    try {
      entry = record(JSON.parse(line)) ?? undefined
    } catch {
      continue
    }
    if (!entry || entry['type'] !== 'message') continue
    const message = record(entry['message'])
    if (!message) continue
    const role = stringValue(message['role'])
    if (role === 'assistant') {
      turnIndex += 1
      const built = buildAssistantMessage(message, sessionId, {
        assistantMessageId: null,
        turnIndex
      })
      if (built?.messages?.length) messages.push(...built.messages)
      continue
    }
    if (role === 'user') {
      const text = nativeUserMessageText(message)
      if (!text) continue
      userIndex += 1
      const messageId = `pi-${sessionId}-user-${userIndex}`
      messages.push({
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', id: `${messageId}:text`, messageID: messageId, text }],
        createdAt: messageTimestamp(message)
      })
      continue
    }
    if (role === 'toolResult') {
      const callId = stringValue(message['toolCallId'])
      if (!callId) continue
      const output = serializeContent(message['content'])
      const failed = message['isError'] === true
      // Complete the most recent tool part carrying this call id.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index]
        if (!candidate) continue
        const partIndex = candidate.parts.findIndex(
          (part) => part.type === 'tool' && part.callID === callId
        )
        const part = partIndex === -1 ? undefined : candidate.parts[partIndex]
        if (!part || part.type !== 'tool') continue
        candidate.parts[partIndex] = {
          ...part,
          state: {
            ...part.state,
            status: failed ? 'error' : 'completed',
            ...(output ? { output } : {}),
            ...(failed && output ? { error: output } : {})
          }
        }
        break
      }
    }
  }
  return messages
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

/** Materialized provider-only extension overlay used for model discovery. */
interface ProviderOverlay {
  args: string[]
  env: Record<string, string>
  cleanup(): Promise<void>
}

/**
 * Driver for Pi's headless agent. Unlike the former in-process SDK path, this
 * shells out to the `pi` CLI the user installs on PATH (like Claude Code), so
 * the heavy Pi runtime is never bundled. It drives `pi --mode rpc` over stdio
 * and keeps one persistent Pi process per active CodeInOven session.
 */
export class PiDriver extends PersistentCliDriver {
  readonly id = 'pi'
  readonly name = 'Pi'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'shared_daemon', scope: 'application', sessionWorkers: true },
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: true,
    scheduledRetry: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, PiTurnState>()
  private rpcClients = new Map<string, PiRpcClient>()
  /**
   * Model/thinking-level last applied to each session's live pi RPC process.
   * Pi's own interactive mode only sends `set_model`/`set_thinking_level`
   * when the user actually changes them (see interactive-mode.js), never
   * before every prompt — re-sending them unconditionally on every turn adds
   * two blocking RPC round-trips with no progress signal, which is what left
   * follow-up turns stuck on the bare spinner. Cleared whenever the RPC
   * client is disposed so a freshly spawned process still gets an explicit
   * set_model on its first turn.
   */
  private appliedPiSettings = new Map<
    string,
    { provider: string; modelId: string; thinkingLevel: string }
  >()
  /** Session-keyed turn handoff files carrying { url, token } for the gateway extension, storage-relative. */
  private gatewayHandoffPaths = new Map<string, string>()
  /** Session-keyed absolute path to the materialized gateway extension module, passed to `--extension`. */
  private gatewayExtensionPaths = new Map<string, string>()
  /**
   * Session-keyed endpoints published before the gateway extension was materialized.
   * On the first turn of a fresh session, publishUtilityGatewayEndpoint runs before
   * sendPrompt spawns Pi and materializes the handoff file, so the endpoint must be
   * held here and flushed by materializeGatewayExtension — otherwise every first
   * cio_util_* call fails with `new URL(route, '')` → "Invalid URL".
   */
  private pendingGatewayEndpoints = new Map<string, { url: string; token: string }>()
  private sessionProjects = new Map<string, string>()
  private activeTurns = new Set<string>()
  /**
   * Sessions whose live RPC process was started by loading the previously
   * persisted native pi transcript (`switch_session`). The chat engine's
   * resume decision reads `loadMessages` before this process exists; this set
   * records the outcome for observability and cleanup.
   */
  private readonly resumedNativeSessions = new Set<string>()
  private pendingUiRequests = new Map<string, PiUiRequest>()
  /**
   * Bounded silent-continue bookkeeping per session. When a turn settles with a
   * finish-reason flake (`Provider finish_reason: other` and friends), the
   * driver silently re-prompts the model instead of surfacing the error. The
   * mirror is claimed only while a continuation is actually owed, so every
   * other path keeps its plain `message.completed`/finalization behavior.
   */
  private silentContinues = new Map<string, PiSilentContinueState>()
  private nativeMcpConfigSupport: Promise<boolean> | null = null
  /** Materialized app-owned status extension path, cached across sessions. */
  private statusExtensionPath: string | null = null
  private statusExtensionDirectory: string | null = null
  private statusExtensionFailed = false
  /** Materialized app-owned usage extension path, cached across sessions. */
  private usageExtensionPath: string | null = null
  private usageExtensionDirectory: string | null = null
  private usageExtensionFailed = false
  /** Latest provider rate-limit windows reported by the usage extension,
   *  per session, with the pi provider id the response came from. */
  private latestRateLimits = new Map<
    string,
    { providerId?: string; windows: AgentRateLimitWindow[] }
  >()
  /** Latest windows per pi provider id, persisted to storage so hovers after
   *  an app restart (no live RPC session, no in-memory cache) still show bars
   *  — and so the same provider used across multiple projects shares them. */
  private persistedRateLimits: Map<string, AgentRateLimitWindow[]> | null = null
  private persistedRateLimitsWrite: Promise<void> | null = null
  private static readonly USAGE_WINDOWS_PATH = 'runtime/pi-usage/windows.json'
  private static readonly USAGE_WINDOWS_MAX_PROVIDERS = 50
  /** Session-keyed absolute path to the materialized core-tools extension module, passed to `--extension`. */
  private coreToolsExtensionPaths = new Map<string, string>()
  /**
   * Session-keyed handoff file carrying the CodeInOven-composed system prompt
   * (work ethic, persistent preferences, working scope, skills), storage-relative.
   * The extension's `before_agent_start` hook reads this fresh on every agent
   * loop start and appends it to Pi's own system prompt as a real system-role
   * field. This exists so that content is sent once per request via the
   * system prompt, not re-concatenated into every user turn's text — doing
   * the latter made every fresh turn replay the same multi-kilobyte block
   * inside "user" content, which models can (and did) mistake for injected
   * or duplicated content.
   */
  private cioSystemPromptPaths = new Map<string, string>()
  private coreToolsExtensionFailed = false
  /** WSL-aware read view of Pi's own credential store (`~/.pi/agent/auth.json`). */
  private readonly authConfig = new PiAuthConfigService(undefined, piAuthFileIo)

  constructor(
    storage: StorageEngine,
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {
    super(storage)
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      await this.cheapCandidateModels(projectPath)
    )
  }

  protected async ensureCliReady(projectPath: string): Promise<void> {
    try {
      await runHarnessCommand('pi', ['--version'], {
        cwd: projectPath,
        env: buildProcessEnvironment(),
        timeoutMs: 5_000
      })
    } catch {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const connected = await this.connectedProviderIds()
    if (connected !== null && connected.size === 0) return []
    if (!(await resolveHarnessRuntime('pi', projectPath))) {
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
    try {
      const overlay = await this.buildProviderOverlay(projectPath)
      const models = await this.discoverModels(projectPath, overlay)
      await overlay.cleanup()
      if (models.length === 0) {
        return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
      }
      const byProvider = new Map<string, ProviderModel[]>()
      for (const model of models) {
        const providerId = stringValue(model['provider'])
        const modelId = stringValue(model['id'])
        if (!providerId || !modelId) continue
        const reasoning = model['reasoning'] === true
        const list = byProvider.get(providerId) ?? []
        list.push({
          id: modelId,
          providerId,
          name: stringValue(model['name']) ?? modelId,
          reasoning,
          ...(reasoning ? { thinkingPresets: THINKING_PRESETS } : {}),
          attachment: Array.isArray(model['input']) ? model['input'].includes('image') : true,
          toolcall: true,
          ...(numberValue(model['contextWindow'])
            ? { contextWindow: numberValue(model['contextWindow']) }
            : {})
        })
        byProvider.set(providerId, list)
      }
      const catalogs = [...byProvider.entries()].map(([id, models]) => ({
        id,
        name: id,
        harnessId: 'pi',
        models
      }))
      return this.filterConnectedCatalogs(
        catalogs.length > 0 ? catalogs : structuredClone(PI_FALLBACK_CATALOG),
        connected
      )
    } catch (error) {
      Logger.dev('Pi provider discovery failed, using fallback catalog', error)
      return this.filterConnectedCatalogs(structuredClone(PI_FALLBACK_CATALOG), connected)
    }
  }

  /** Every connected Pi model whose display name or id identifies it as free. */
  protected override async cheapCandidateModels(
    projectPath: string
  ): Promise<TitleModelCandidate[]> {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const catalogs = await Promise.race([
      this.listProviders(projectPath).catch(() => []),
      new Promise<ProviderCatalog[]>((resolve) => {
        timeout = setTimeout(() => resolve([]), PI_CHEAP_MODEL_DISCOVERY_TIMEOUT_MS)
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    const candidates = new Map<string, TitleModelCandidate>()
    for (const catalog of catalogs) {
      for (const model of catalog.models) {
        if (!/free/iu.test(model.id) && !/free/iu.test(model.name)) continue
        candidates.set(`${model.providerId}/${model.id}`, {
          providerId: model.providerId,
          modelId: model.id
        })
      }
    }
    return [...candidates.values()]
  }

  /**
   * The providers the user is actually connected to, keyed by the same provider
   * ids pi's catalog reports: credentials in `~/.pi/agent/auth.json` (written by
   * pi's TUI or CodeInOven's connect flow), providers configured in
   * `~/.pi/agent/models.json` (keyed catalog providers and keyless local
   * servers alike), and CodeInOven-managed base-URL providers injected through
   * the discovery overlay. Returns `null` when the connected set cannot be
   * determined reliably — callers then keep the catalog unfiltered rather than
   * wrongly hiding every provider behind a transient read failure.
   */
  private async connectedProviderIds(): Promise<Set<string> | null> {
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => null)
      : []
    const nativeIds = await piNativeProviderIds().catch(() => null)
    if (overlay === null || nativeIds === null) return null
    const connected = new Set<string>([...(await this.authConfig.credentialIds()), ...nativeIds])
    for (const provider of overlay) connected.add(provider.id)
    return connected
  }

  private filterConnectedCatalogs(
    catalogs: ProviderCatalog[],
    connected: Set<string> | null
  ): ProviderCatalog[] {
    if (connected === null) return catalogs
    return catalogs.filter((catalog) => connected.has(catalog.id))
  }

  /** Cheap staleness signature of the connected-provider set; see the interface contract. */
  async providerCatalogFingerprint(): Promise<string | null> {
    const connected = await this.connectedProviderIds()
    if (connected === null) return null
    const overlay = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => [])
      : []
    const overlayModels = overlay
      .map((provider) => `${provider.id}=${provider.models.map((model) => model.id).join(',')}`)
      .sort()
      .join('|')
    return JSON.stringify([[...connected].sort(), overlayModels])
  }

  private async discoverModels(
    projectPath: string,
    overlay: ProviderOverlay
  ): Promise<Array<Record<string, unknown>>> {
    let models: unknown
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc', ...overlay.args], {
      cwd: projectPath,
      env: { ...buildProcessEnvironment(), ...overlay.env }
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      models = await client.getAvailableModels()
    } finally {
      client.dispose()
    }
    const payload = record(models)
    const list = Array.isArray(payload?.['models']) ? (payload['models'] as unknown[]) : []
    return list.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    )
  }

  /** Whether the user's pi runtime exposes the `--mcp-config` adapter flag. */
  private supportsNativeMcpConfig(): Promise<boolean> {
    this.nativeMcpConfigSupport ??= this.probeNativeMcpConfig()
    return this.nativeMcpConfigSupport
  }

  private async probeNativeMcpConfig(): Promise<boolean> {
    let help: string
    try {
      help = (
        await runHarnessCommand('pi', ['--help'], {
          env: buildProcessEnvironment(),
          timeoutMs: 10_000
        })
      ).stdout
    } catch {
      return false
    }
    // The flag is registered by the pi-mcp-adapter extension; absent the
    // adapter, pi rejects `--mcp-config` as an unknown flag.
    return /\bmcp-config\b/u.test(help) || /--mcp-config/u.test(help)
  }

  override async listCommands(projectPath?: string): Promise<HarnessCommand[]> {
    // Commands are project-scoped in pi; probe them in a disposable session so
    // the running turn is untouched. Fall back to the last seen project when the
    // caller omits the path (the base class declares a no-arg signature).
    const cwd = projectPath ?? [...this.sessionProjects.values()][0] ?? process.cwd()
    if (!(await resolveHarnessRuntime('pi', cwd))) return []
    const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc'], {
      cwd,
      env: buildProcessEnvironment()
    })
    const client = new PiRpcClient({
      invocation
    })
    try {
      await client.newSession()
      const payload = record(await client.getCommands())
      const commands = Array.isArray(payload?.['commands']) ? payload['commands'] : []
      const result: HarnessCommand[] = []
      for (const raw of commands) {
        const command = record(raw)
        const name = stringValue(command?.['name'])
        if (!name) continue
        const source = stringValue(command?.['source'])
        const description = stringValue(command?.['description'])
        result.push({
          name,
          ...(description ? { description } : {}),
          ...(source === 'skill' ? { source: 'skill' as const } : {})
        })
      }
      return result
    } catch (error) {
      Logger.dev('Pi command discovery failed:', error)
      return []
    } finally {
      client.dispose()
    }
  }

  override async runCommand(
    projectPath: string,
    sessionId: string,
    command: HarnessCommand,
    args: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    if (this.activeTurns.has(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
    }
    const client = await this.ensureRpcClient(projectPath, session.id)
    const commandText = (args.trim() ? `${command.name} ${args}` : command.name).trim()
    this.silentContinues.delete(session.id)
    this.activeTurns.add(session.id)
    try {
      await client.prompt(commandText)
    } catch (error) {
      this.activeTurns.delete(session.id)
      const message = error instanceof Error ? error.message : 'Pi command failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      throw error
    }
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: ThreadSettings
  ): Promise<void> {
    void _settings
    await this.requireSession(projectPath, sessionId)
    const client = this.rpcClients.get(sessionId)
    if (!client) {
      throw new Error(`No active Pi session is available to compact for ${sessionId}`)
    }
    // pi's `compact` RPC aborts any active run and then compacts, so it works
    // both mid-turn and on an idle session. Awaiting here keeps the handoff
    // deterministic from the caller's view; compaction_start/compaction_end
    // events stream out as it summarizes.
    await client.compact()
  }

  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    const client = await this.ensureRpcClient(projectPath, session.id)
    // A live turn owns this session (silent continue, auto-retry, an idle race
    // between the harness and the chat-engine status). Throwing here surfaced a
    // second user-facing error on top of a turn that is still producing output
    // — the user clicks retry and is told the session already has an active
    // turn. Instead, re-anchor provenance with the incoming settings and
    // deliver the prompt through pi's steer channel so the live working trace
    // simply continues.
    if (this.activeTurns.has(session.id)) {
      const activeModel = this.resolveModel(options.settings.providerId, options.settings.modelId)
      if (activeModel) {
        try {
          await this.applyPiSettingsIfChanged(
            session.id,
            client,
            activeModel,
            options.settings.thinkingLevel
          )
        } catch {
          // The active turn keeps its current model/thinking level; steering
          // must not fail just because a mid-turn model switch was rejected.
        }
      }
      this.setTurnProvenance(
        session.id,
        options.settings.providerId,
        options.settings.modelId,
        options.settings.thinkingLevel
      )
      this.appendUserMessage(session, options)
      this.silentContinues.delete(session.id)
      await this.steerIntoActiveTurn(session.id, options.text, options.attachments)
      return
    }
    const model = this.resolveModel(options.settings.providerId, options.settings.modelId)
    if (!model) {
      throw new Error(
        `Pi model is unavailable: ${options.settings.providerId}/${options.settings.modelId}`
      )
    }
    await this.applyPiSettingsIfChanged(session.id, client, model, options.settings.thinkingLevel)

    this.setTurnProvenance(
      session.id,
      options.settings.providerId,
      options.settings.modelId,
      options.settings.thinkingLevel
    )
    this.appendUserMessage(session, options)
    this.silentContinues.delete(session.id)
    this.activeTurns.add(session.id)

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
    if (options.systemPrompt) {
      await this.publishCioSystemPrompt(session.id, options.systemPrompt)
    }
    const prompt = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')

    try {
      await client.prompt(prompt, images)
    } catch (error) {
      this.activeTurns.delete(session.id)
      const message = error instanceof Error ? error.message : 'Pi turn failed to start'
      this.emit({ type: 'session.error', sessionId: session.id, error: message })
      await this.finishTurn(session)
      throw error
    }
  }

  private resolveModel(
    providerId: string,
    modelId: string
  ): { provider: string; modelId: string } | null {
    if (!providerId || !modelId) return null
    return { provider: providerId, modelId }
  }

  /**
   * Only send `set_model`/`set_thinking_level` when the session's live pi
   * process doesn't already have them applied. Each is a full RPC round-trip
   * with no progress event, so paying for both on every turn — as opposed to
   * only when the user actually changes a setting, which is what pi's own
   * interactive mode does — left follow-up turns stuck on a bare spinner for
   * however long those round-trips took.
   */
  private async applyPiSettingsIfChanged(
    sessionId: string,
    client: PiRpcClient,
    model: { provider: string; modelId: string },
    thinkingLevel: string
  ): Promise<void> {
    const level = piThinkingLevel(thinkingLevel)
    const applied = this.appliedPiSettings.get(sessionId)
    if (
      applied &&
      applied.provider === model.provider &&
      applied.modelId === model.modelId &&
      applied.thinkingLevel === level
    ) {
      return
    }
    if (!applied || applied.provider !== model.provider || applied.modelId !== model.modelId) {
      await client.setModel(model.provider, model.modelId)
    }
    if (!applied || applied.thinkingLevel !== level) {
      await client.setThinkingLevel(level)
    }
    this.appliedPiSettings.set(sessionId, {
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: level
    })
  }

  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    await this.requireSession(projectPath, options.sessionId)
    const client = this.rpcClients.get(options.sessionId)
    if (!client || !this.activeTurns.has(options.sessionId)) {
      throw new Error(`No active Pi turn is available to steer for session ${options.sessionId}`)
    }
    await this.steerIntoActiveTurn(options.sessionId, options.text, options.attachments)
  }

  /** Compose attachments + text and deliver them into the session's live turn
   *  through pi's steer channel. The caller must have verified an active turn. */
  private async steerIntoActiveTurn(
    sessionId: string,
    text: string,
    attachments: SendPromptOptions['attachments']
  ): Promise<void> {
    const client = this.rpcClients.get(sessionId)
    if (!client) {
      throw new Error(`No active Pi turn is available to steer for session ${sessionId}`)
    }
    const inlineSvg = await inlineSvgAttachments(attachments)
    const images: PiImageContent[] = []
    const references: string[] = []
    for (const attachment of attachments) {
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
    const message = [inlineSvg, ...references, text].filter(Boolean).join('\n\n')
    await client.steer(message, images)
  }

  override async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    const client = this.rpcClients.get(sessionId)
    if (!client) return
    try {
      await client.abort()
    } catch {
      // The abort RPC failed — the pi process is wedged or already gone, so a
      // graceful abort can never land. Kill the process so the run actually
      // stops instead of silently continuing; the exit event finalizes the
      // session state and a fresh run spawns a new process on demand.
      client.dispose()
    } finally {
      this.activeTurns.delete(sessionId)
    }
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.disposeRpcClient(sessionId)
    this.activeTurns.delete(sessionId)
    this.turnStates.delete(sessionId)
    this.silentContinues.delete(sessionId)
    await this.removeGatewayHandoff(sessionId)
    await super.deleteSession(projectPath, sessionId)
  }

  override releaseProjectResources(projectPath: string): void {
    for (const [sessionId, clientProject] of this.sessionProjects) {
      if (clientProject !== projectPath) continue
      if (this.activeTurns.has(sessionId)) continue
      this.disposeRpcClient(sessionId)
    }
    super.releaseProjectResources(projectPath)
  }

  /**
   * Quota telemetry for the battery popover: the latest provider rate-limit
   * windows (keyed by pi provider id, shared across projects) plus prepaid
   * credits for known gateways, and live context stats when a session for
   * the project is running. Provider-scoped data answers even without a live
   * session, mirroring the cached-bars contract of the other drivers.
   */
  async readAccountUsage(
    projectPath: string,
    providerId?: string
  ): Promise<{
    rateLimits: AgentRateLimitWindow[]
    credits?: AgentUsageCredits
    contextWindow?: number
    contextUsed?: number
  } | null> {
    const sessionId = [...this.sessionProjects.entries()].find(
      ([, clientProject]) => clientProject === projectPath
    )?.[0]
    const client = sessionId ? this.rpcClients.get(sessionId) : undefined
    const persisted = await this.loadPersistedRateLimits()
    const sessionCache = sessionId !== undefined ? this.latestRateLimits.get(sessionId) : undefined
    // Provider-keyed windows win; the live session's latest capture answers
    // only when it matches the requested provider (or no provider was given).
    const providerWindows = providerId
      ? (persisted.get(providerId) ??
         (sessionCache && (sessionCache.providerId === providerId || !sessionCache.providerId)
           ? sessionCache.windows
           : undefined))
      : (sessionCache?.windows ?? [...persisted.values()].at(-1))
    const windows = providerWindows ?? []
    const credits = (providerId ? await fetchPiProviderCredits(providerId) : null) ?? undefined
    if (!client) {
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
    try {
      const stats = record(await client.getSessionStats())
      const contextUsage = record(stats?.['contextUsage'])
      const contextWindow = numberValue(contextUsage?.['contextWindow'])
      const contextUsed = numberValue(contextUsage?.['tokens'])
      if (
        contextWindow === undefined &&
        contextUsed === undefined &&
        windows.length === 0 &&
        !credits
      )
        return null
      return {
        ...(windows.length > 0 ? { rateLimits: windows } : { rateLimits: [] }),
        ...(credits ? { credits } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {})
      }
    } catch (error) {
      Logger.dev('Pi account usage read failed:', error)
      return windows.length > 0 || credits ? { rateLimits: windows, credits } : null
    }
  }

  /**
   * Publish the turn-scoped gateway endpoint for the app-owned utility gateway
   * extension. Pi sessions are persistent RPC processes whose extensions load
   * at spawn, so the per-turn URL+token reach the extension through a
   * session-keyed handoff file the driver rewrites per turn; clearing it on
   * turn end makes stale tokens unusable. A failed write is logged and swallowed
   * — the prose curl fallback stays fully functional without the extension.
   */
  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: { url: string; token: string } | null
  ): Promise<void> {
    void _projectPath
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      if (endpoint !== null) {
        // First turn of a fresh session: the extension materializes only inside
        // ensureRpcClient (during sendPrompt), which runs after this publish.
        // Defer the endpoint instead of dropping it so the spawned session starts
        // with a working gateway rather than the empty { url: '', token: '' } seed.
        this.pendingGatewayEndpoints.set(sessionId, endpoint)
        Logger.dev('Pi utility gateway endpoint deferred: extension not yet materialized')
      } else {
        this.pendingGatewayEndpoints.delete(sessionId)
      }
      return
    }
    try {
      if (endpoint === null) await this.storage.removeRaw(handoffPath)
      else {
        await this.storage.writeRaw(handoffPath, JSON.stringify(endpoint))
      }
    } catch (error) {
      Logger.dev('Pi utility gateway handoff update failed:', error)
    }
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcpServers: Record<
      string,
      { command?: string; args?: string[]; env?: Record<string, string>; url?: string }
    > = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      const config = utility.config
      if (config.transport === 'http' || config.transport === 'sse') {
        if (!config.url) {
          throw new TypeError(`Pi MCP utility "${utility.name}" requires a URL`)
        }
        mcpServers[key] = { url: config.url }
        continue
      }
      if (!config.command) {
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
      const native = await this.supportsNativeMcpConfig()
      if (native) {
        // pi-mcp-adapter (an extension the user may install) registers the
        // `--mcp-config` flag and reads a standard `{ mcpServers }` file. Using
        // it avoids maintaining a bespoke in-extension MCP client.
        args.push('--mcp-config', '{{config:pi-mcp}}')
        configFiles.push({
          id: 'pi-mcp',
          relativePath: 'pi/mcp-config.json',
          content: JSON.stringify({ mcpServers }, null, 2)
        })
      } else {
        // The app-owned bridge extension can only host stdio servers, so remote
        // http/sse utilities require the pi-mcp-adapter native path.
        const remoteNames = Object.entries(mcpServers).filter(
          ([, server]) => typeof server['url'] === 'string'
        )
        if (remoteNames.length > 0) {
          throw new TypeError(
            `Pi MCP utility "${remoteNames[0]?.[0]}" requires the pi-mcp-adapter extension. Install it with: pi install npm:pi-mcp-adapter`
          )
        }
        const stdioServers = mcpServers as Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >
        args.push('--extension', '{{config:pi-mcp-extension}}')
        configFiles.push({
          id: 'pi-mcp-extension',
          relativePath: 'pi/codeinoven-mcp-extension.ts',
          content: piMcpExtension(stdioServers)
        })
      }
    }

    if (configFiles.length === 0) return {}
    return { args, configFiles, env }
  }

  protected async buildTurnCommand(): Promise<CliTurnCommand> {
    throw new Error('PiDriver drives pi over RPC; buildTurnCommand is not used')
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
    for (const client of this.rpcClients.values()) client.dispose()
    this.rpcClients.clear()
    this.activeTurns.clear()
    this.turnStates.clear()
    this.silentContinues.clear()
    this.pendingUiRequests.clear()
    for (const sessionId of this.gatewayHandoffPaths.keys()) {
      void this.removeGatewayHandoff(sessionId)
    }
    this.gatewayHandoffPaths.clear()
    this.gatewayExtensionPaths.clear()
    this.pendingGatewayEndpoints.clear()
    const statusDirectory = this.statusExtensionDirectory
    this.statusExtensionPath = null
    this.statusExtensionDirectory = null
    if (statusDirectory) {
      void rm(statusDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
    this.coreToolsExtensionPaths.clear()
    this.cioSystemPromptPaths.clear()
    super.dispose()
  }

  /**
   * Live probe of the pi session's streaming state (`get_state` →
   * `isStreaming`), used by restart recovery to avoid resuming a turn the
   * surviving pi process is still executing — the same role OpenCode's
   * session-status probe plays for its shared server.
   */
  async isSessionBusy(projectPath: string, sessionId: string): Promise<boolean> {
    const client = this.rpcClients.get(sessionId)
    if (!client || this.sessionProjects.get(sessionId) !== projectPath) return false
    try {
      const state = record(await client.getState())
      return state?.['isStreaming'] === true || state?.['isCompacting'] === true
    } catch (error) {
      Logger.dev('Pi session busy probe failed:', error)
      return false
    }
  }

  private async ensureRpcClient(projectPath: string, sessionId: string): Promise<PiRpcClient> {
    const existing = this.rpcClients.get(sessionId)
    if (existing) return existing
    const session = await this.requireSession(projectPath, sessionId)
    const currentTurnState = this.turnStates.get(sessionId)
    this.turnStates.set(sessionId, {
      assistantMessageId: currentTurnState?.assistantMessageId ?? null,
      turnIndex: Math.max(
        currentTurnState?.turnIndex ?? 0,
        latestPiTurnIndex(session.messages, sessionId)
      )
    })
    const runtime = this.utilityRuntime(sessionId)
    const args = runtime
      ? runtime.args.map((arg) => this.resolveRuntimePlaceholders(arg, runtime))
      : []
    const runtimeEnv = runtime
      ? Object.fromEntries(
          Object.entries(runtime.env).map(([key, value]) => [
            key,
            this.resolveRuntimePlaceholders(value, runtime)
          ])
        )
      : {}
    if (!(await resolveHarnessRuntime('pi', projectPath))) {
      throw new Error(
        'Pi is not installed. Install the Pi CLI globally, then retry. (npm i -g @earendil-works/pi-coding-agent)'
      )
    }
    // The app-owned status extension reports working/idle over the RPC stream
    // so session status matches the other harness drivers. A materialization
    // failure must never block the turn — pi then simply runs unmonitored.
    const statusExtension = await this.materializeStatusExtension()
    const extensionArgs = statusExtension ? ['--extension', statusExtension] : []
    // The app-owned usage extension forwards provider rate-limit headers so
    // usage bars match the other harness drivers. Same failure contract.
    const usageExtension = await this.materializeUsageExtension()
    if (usageExtension) extensionArgs.push('--extension', usageExtension)
    // The app-owned gateway extension registers the interactive gateway tools
    // from GATEWAY_TOOLS as first-class tools so the model gets structured affordances for the
    // turn-scoped utility gateway (Pi has no native MCP host to transport it).
    // The per-turn endpoint arrives later via publishUtilityGatewayEndpoint.
    const gatewayExtension = await this.materializeGatewayExtension(sessionId)
    if (gatewayExtension) extensionArgs.push('--extension', gatewayExtension)
    // The app-owned core-tools extension registers the question, todo, and
    // file-request tools plus the destructive-action permission gate (marker
    // confirm dialogs upgraded to permission.asked in handleUiRequest).
    const coreToolsExtension = await this.materializeCoreToolsExtension(sessionId)
    if (coreToolsExtension) extensionArgs.push('--extension', coreToolsExtension)
    const invocation = await prepareHarnessInvocation(
      'pi',
      ['--mode', 'rpc', ...extensionArgs, ...args],
      {
        cwd: projectPath,
        env: {
          ...buildProcessEnvironment(),
          ...runtimeEnv
        }
      }
    )
    const client = new PiRpcClient({
      invocation,
      onEvent: (record) => {
        void this.handleRpcEvent(record, sessionId, projectPath)
      },
      onUiRequest: (record) => {
        this.handleUiRequest(record, sessionId)
      },
      onExtensionStatus: (record) => {
        this.handleExtensionStatus(record, sessionId)
      },
      onExit: (code) => {
        this.handleRpcExit(code, sessionId)
      }
    })
    this.rpcClients.set(sessionId, client)
    this.sessionProjects.set(sessionId, projectPath)
    try {
      await client.newSession()
      // Resume the persisted native transcript BEFORE syncing the native
      // session id: `switch_session` makes the resumed session current, so the
      // sync below then records the same id the thread was already bound to.
      // A transient failure here must never block the turn.
      await this.resumeNativePiSession(projectPath, sessionId, client)
      await Promise.allSettled([
        client.setAutoRetry(true),
        client.setAutoCompaction(true),
        this.syncNativeSessionId(projectPath, sessionId)
      ])
    } catch (error) {
      client.dispose()
      this.rpcClients.delete(sessionId)
      this.sessionProjects.delete(sessionId)
      throw new Error(
        `Failed to start a Pi session: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
    return client
  }

  /**
   * Continue a previously persisted native pi session in the freshly spawned
   * RPC process by loading pi's own transcript file. Without this, every
   * driver-side process replacement (app restart, idle dispose, crash) made
   * the next turn a cold session — the engine's history recap was the only
   * context carrier, and models that see their prior work restated without
   * tool evidence treat it as fabricated and refuse to continue.
   *
   * Best-effort: any failure leaves the fresh session in place and the
   * engine's recap replay covers the gap.
   */
  private async resumeNativePiSession(
    projectPath: string,
    sessionId: string,
    client: PiRpcClient
  ): Promise<void> {
    try {
      const session = await this.requireSession(projectPath, sessionId)
      const nativeId = session.nativeSessionId
      if (!nativeId) return
      if (!existsSync(nativePiSessionDir(projectPath))) return
      const file = await findNativePiSessionFile(projectPath, nativeId)
      if (!file) return
      await client.switchSession(file)
      this.resumedNativeSessions.add(sessionId)
      Logger.info('Resumed native Pi session transcript', { sessionId, nativeSessionId: nativeId })
    } catch (error) {
      Logger.dev('Native Pi session resume unavailable; continuing fresh:', error)
    }
  }

  /** Mirror the native pi session id so driver records stay addressable. */
  /**
   * Load messages for an app-managed session, or — for sub-agent worker
   * threads — the native pi session transcript persisted on disk by the
   * in-process sub-agent session.
   *
   * The native transcript is authoritative whenever it exists and the live RPC
   * process is not already holding the conversation in memory: the engine's
   * resume decision treats a non-empty `loadMessages` result as "this harness
   * session natively holds the conversation" and skips the history-recap
   * replay. Returning the mirror there would make a fresh (unresumable) pi
   * session look resumable and silently drop all context.
   */
  override async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    if (!this.rpcClients.has(sessionId)) {
      const record = await this.readSessionRecord(projectPath, sessionId)
      if (record) {
        const native = await this.loadResumableNativeMessages(projectPath, sessionId, record)
        if (native) return native
        if (record.nativeSessionId) {
          // The session was bound to a native pi session whose transcript is
          // gone — the next turn starts a fresh session, so report no native
          // history and let the engine replay the durable mirror instead.
          return []
        }
      }
    }
    try {
      return await super.loadMessages(projectPath, sessionId)
    } catch (error) {
      const native = await this.loadNativeSubagentMessages(projectPath, sessionId)
      if (native) return native
      throw error
    }
  }

  /** The persisted session record, or null when the session is unknown. */
  private async readSessionRecord(
    projectPath: string,
    sessionId: string
  ): Promise<PersistentCliSession | null> {
    try {
      return await this.requireSession(projectPath, sessionId)
    } catch {
      return null
    }
  }

  /**
   * Restore this session's native pi transcript binding from the most recent
   * resumable session record for the thread. Called when a thread returns to
   * pi after a harness switch: the thread's session slot now belongs to the
   * other harness, but pi still holds the real transcript on disk — without
   * this the returning turn cold-starts on the engine's history recap, which
   * weaker models read as injected fiction and freeze on.
   */
  async restoreNativeBinding(
    projectPath: string,
    sessionId: string,
    threadId: string
  ): Promise<boolean> {
    try {
      const replacement = await this.requireSession(projectPath, sessionId)
      if (replacement.nativeSessionId) return true
      const previous = await this.findLatestThreadSession(projectPath, threadId)
      if (!previous || previous.id === sessionId) return false
      const nativeId = previous.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId))) return false
      replacement.nativeSessionId = nativeId
      Logger.info('Restored native Pi transcript binding after harness switch', {
        sessionId,
        threadId,
        fromSessionId: previous.id,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi binding restore skipped:', error)
      return false
    }
  }

  /**
   * Seed a fresh session with the thread's edited history as a native pi
   * transcript. Used after the user edits a session (delete/truncate/collapse):
   * instead of replaying the remaining mirror as a history recap — which weak
   * models read as injected fiction and stall on — the next RPC spawn resumes
   * this synthetic transcript natively, exactly as if the conversation had
   * happened in pi itself.
   */
  async prefillNativeSession(
    projectPath: string,
    sessionId: string,
    messages: readonly AgentMessage[]
  ): Promise<boolean> {
    try {
      const session = await this.requireSession(projectPath, sessionId)
      if (session.nativeSessionId) return true
      const entries = prefillTranscriptEntries(projectPath, messages)
      if (entries.length === 0) return false
      const dir = nativePiSessionDir(projectPath)
      await mkdir(dir, { recursive: true })
      const nativeId = randomUUID()
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/gu, '-')}_${nativeId}.jsonl`)
      await writeFile(file, `${entries.join('\n')}\n`, 'utf8')
      session.nativeSessionId = nativeId
      await this.persistSession(session)
      Logger.info('Seeded a native Pi transcript from the edited mirror', {
        sessionId,
        nativeSessionId: nativeId,
        entries: entries.length
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi transcript prefill skipped:', error)
      return false
    }
  }

  /**
   * Carry a replaced session's native pi transcript binding over to the
   * replacement record. When the engine mints a replacement app session (the
   * stored session became unreachable), the fresh record starts without a
   * nativeSessionId — without this transfer the thread's real native
   * transcript is orphaned and every later turn degrades to the engine's
   * history recap, which models can misread as fabricated context.
   */
  async inheritNativeSession(
    projectPath: string,
    fromSessionId: string,
    toSessionId: string
  ): Promise<boolean> {
    try {
      const previous = await this.readSessionRecord(projectPath, fromSessionId)
      const nativeId = previous?.nativeSessionId
      if (!nativeId) return false
      if (!existsSync(nativePiSessionDir(projectPath))) return false
      if (!(await findNativePiSessionFile(projectPath, nativeId))) return false
      const replacement = await this.requireSession(projectPath, toSessionId)
      if (replacement.nativeSessionId) return true
      replacement.nativeSessionId = nativeId
      Logger.info('Inherited native Pi session transcript onto a replacement session', {
        fromSessionId,
        toSessionId,
        nativeSessionId: nativeId
      })
      return true
    } catch (error) {
      Logger.dev('Native Pi session inheritance skipped:', error)
      return false
    }
  }

  /**
   * Parse pi's own transcript for a cold (no live RPC process) session whose
   * native session file still exists on disk. Returns null when the session is
   * not natively resumable so the caller falls back to the mirror.
   */
  private async loadResumableNativeMessages(
    projectPath: string,
    sessionId: string,
    sessionRecord: PersistentCliSession
  ): Promise<AgentMessage[] | null> {
    const nativeId = sessionRecord.nativeSessionId
    if (!nativeId) return null
    if (!existsSync(nativePiSessionDir(projectPath))) return null
    const file = await findNativePiSessionFile(projectPath, nativeId)
    if (!file) return null
    try {
      const messages = await parseNativePiSession(file, sessionId)
      return messages.length > 0 ? messages : null
    } catch (error) {
      Logger.dev('Pi native transcript parse failed during resume check:', error)
      return null
    }
  }

  /** Returns null when no native transcript exists so the caller rethrows. */
  private async loadNativeSubagentMessages(
    projectPath: string,
    sessionId: string
  ): Promise<AgentMessage[] | null> {
    if (existsSync(nativePiSessionDir(projectPath))) {
      const file = await findNativePiSessionFile(projectPath, sessionId)
      if (file) {
        try {
          return await parseNativePiSession(file, sessionId)
        } catch (error) {
          Logger.dev('Pi native sub-agent transcript parse failed:', error)
          return null
        }
      }
    }
    return null
  }

  private async syncNativeSessionId(projectPath: string, sessionId: string): Promise<void> {
    const client = this.rpcClients.get(sessionId)
    if (!client) return
    const state = record(await client.getState())
    const nativeId = stringValue(state?.['sessionId'])
    if (!nativeId) return
    const session = await this.requireSession(projectPath, sessionId)
    session.nativeSessionId = nativeId
  }

  private handleRpcEvent(
    record: Record<string, unknown>,
    sessionId: string,
    projectPath: string
  ): void {
    this.requireSession(projectPath, sessionId)
      .then((session) => {
        const result = this.parseJsonLine(record, { session, sessionId, projectPath })
        if (!result) return
        if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId
        if (result.messages) this.mergeMessages(session, result.messages)
        for (const event of this.normalizeInteractionEvents(session.id, result.events ?? [])) {
          // A successful assistant completion proves the provider recovered, so
          // the flake budget resets: a long agentic turn that survives many
          // scattered hiccups must not be capped by their cumulative count.
          if (
            event.type === 'message.completed' &&
            !event.error &&
            !event.silentContinue &&
            !event.compaction
          ) {
            const state = this.silentContinues.get(session.id)
            if (state && state.attempts > 0) {
              state.attempts = 0
              this.silentContinues.set(session.id, state)
            }
          }
          // A continuable finish-reason flake is claimed by the driver: strip
          // the marker and never let the errored completion reach the engine,
          // or the chat would show a failure the silent continue is about to
          // recover from. The empty assistant message is dropped from the
          // mirror so the user never sees a blank failed turn.
          if (event.type === 'message.completed' && event.silentContinue) {
            const state = this.silentContinues.get(session.id) ?? {
              attempts: 0,
              owed: false,
              lastError: ''
            }
            state.lastError = event.silentContinue.error
            const { silentContinue, ...clean } = event
            void silentContinue
            if (state.attempts < SILENT_CONTINUE_MAX_ATTEMPTS) {
              state.owed = true
              state.attempts += 1
              this.silentContinues.set(session.id, state)
              // Mark the flaked message complete (without the error) so the
              // mirror stays consistent; content-bearing messages are kept.
              this.applyEventToSession(session, clean)
              this.dropMirroredEmptyAssistant(session)
              continue
            }
            // Cap reached: surface the original error through the normal path.
            state.owed = false
            this.silentContinues.set(session.id, state)
            const failure: SessionAgentEvent = { ...clean, error: state.lastError }
            this.applyEventToSession(session, failure)
            this.emit(failure)
            continue
          }
          this.applyEventToSession(session, event)
          this.emit({ ...event, sessionId: session.id })
        }
        session.updatedAt = Date.now()
        // pi auto-retries transient failures, emitting `agent_end` for every
        // attempt, before `auto_retry_end` and finally `agent_settled`. Only
        // `agent_settled` is a stable signal that no retry or queued
        // continuation remains, so never finalize a turn on `agent_end`.
        if (record['type'] === 'agent_settled') {
          if (this.beginSilentContinue(session)) return
          this.activeTurns.delete(session.id)
          void this.refreshSessionUsage(session).finally(() => {
            void this.finishTurn(session)
          })
        }
      })
      .catch((error) => {
        Logger.dev('Pi event handler dropped', error)
      })
  }

  /**
   * Drop the trailing assistant message the mirror captured for a flaked turn
   * when it produced no user-visible content, so the silent continue does not
   * leave a blank stub behind.
   */
  private dropMirroredEmptyAssistant(session: PersistentCliSession): void {
    const last = [...session.messages].reverse().find((message) => message.role === 'assistant')
    if (!last || last.error) return
    const hasContent = last.parts.some((part) => {
      if (part.type === 'text' || part.type === 'reasoning') return part.text.trim().length > 0
      return part.type === 'tool'
    })
    if (hasContent) return
    const index = session.messages.indexOf(last)
    if (index !== -1) session.messages.splice(index, 1)
  }

  /**
   * Claim a owed silent continue when the turn settles. Returns true when a
   * continuation was started (the turn stays active); false when there is
   * nothing owed and the turn should finalize normally.
   */
  private beginSilentContinue(session: PersistentCliSession): boolean {
    const state = this.silentContinues.get(session.id)
    if (!state?.owed) return false
    state.owed = false
    this.dropMirroredEmptyAssistant(session)
    const client = this.rpcClients.get(session.id)
    if (!client) {
      this.failSilentContinue(session, state.lastError)
      return true
    }
    void client.prompt('Continue.').catch((error: unknown) => {
      this.failSilentContinue(session, error instanceof Error ? error.message : state.lastError)
    })
    return true
  }

  /** Remove a session's gateway handoff file and forget its path. */
  private async removeGatewayHandoff(sessionId: string): Promise<void> {
    const handoffPath = this.gatewayHandoffPaths.get(sessionId)
    if (!handoffPath) {
      this.pendingGatewayEndpoints.delete(sessionId)
      return
    }
    this.gatewayHandoffPaths.delete(sessionId)
    this.pendingGatewayEndpoints.delete(sessionId)
    try {
      await this.storage.removeRaw(handoffPath)
    } catch (error) {
      Logger.dev('Pi utility gateway handoff removal failed:', error)
    }
  }

  /** Surface a silent continue that could not be started as a real error. */
  private failSilentContinue(session: PersistentCliSession, error: string): void {
    this.silentContinues.delete(session.id)
    this.activeTurns.delete(session.id)
    this.emit({
      type: 'session.error',
      sessionId: session.id,
      error: error || 'Pi turn failed'
    })
    void this.finishTurn(session)
  }

  private handleRpcExit(code: number | null, sessionId: string): void {
    void code
    // Drop the dead client so the next turn spawns a fresh RPC process and
    // resumes the persisted native transcript instead of failing on a dead
    // pipe (or worse, silently continuing a context-less session).
    this.disposeRpcClient(sessionId)
    if (this.activeTurns.has(sessionId)) {
      this.activeTurns.delete(sessionId)
      // The pi process died mid-turn; persist whatever was mirrored and
      // surface the idle state so the thread does not stay "working".
      const projectPath = this.sessionProjects.get(sessionId)
      if (projectPath) {
        this.requireSession(projectPath, sessionId)
          .then((session) => void this.finishTurn(session))
          .catch((error) => Logger.dev('Pi exit finalization failed:', error))
      }
    }
  }

  /**
   * Map the app-owned status extension's `setStatus` records into
   * authoritative `session.status` events. The extension reports
   * `cio:working` on `agent_start` (and after compaction), `cio:idle` on
   * `agent_settled`, and `cio:compacting` during auto-compaction — the same
   * lifecycle visibility codex/claude-code/opencode drivers provide.
   */
  private handleExtensionStatus(record: Record<string, unknown>, sessionId: string): void {
    if (stringValue(record['statusKey']) === PI_USAGE_EXTENSION_KEY) {
      void this.handleUsageStatus(record, sessionId)
      return
    }
    if (stringValue(record['statusKey']) !== PI_STATUS_EXTENSION_KEY) return
    const text = stringValue(record['statusText'])
    if (!text) return
    if (!this.activeTurns.has(sessionId)) return
    const state =
      text === PI_STATUS_WORKING || text === PI_STATUS_COMPACTING
        ? ({ state: 'working' } as const)
        : text === PI_STATUS_IDLE
          ? ({ state: 'idle' } as const)
          : null
    if (!state) return
    // `agent_settled` remains the sole finalization trigger (usage stats +
    // session persistence); the idle status here only clears the busy flag.
    this.emit({ type: 'session.status', sessionId, status: state })
  }

  /**
   * Consume the usage extension's `setStatus` records: a JSON payload of the
   * provider response's rate-limit headers. Mapped into display windows and
   * cached per session until the next provider response refreshes them.
   */
  private async handleUsageStatus(record: Record<string, unknown>, sessionId: string): Promise<void> {
    const text = stringValue(record['statusText'])
    if (!text) return
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      return
    }
    const windows = mapPiRateLimitHeaders(payload)
    if (windows.length === 0) return
    const providerId = piUsageProviderId(payload)
    this.latestRateLimits.set(sessionId, { providerId, windows })
    if (providerId) await this.rememberPersistedRateLimits(providerId, windows)
  }

  /** Load the persisted per-project windows map once per driver lifetime. */
  private async loadPersistedRateLimits(): Promise<Map<string, AgentRateLimitWindow[]>> {
    if (this.persistedRateLimits) return this.persistedRateLimits
    const map = new Map<string, AgentRateLimitWindow[]>()
    try {
      const raw = await this.storage.readRaw(PiDriver.USAGE_WINDOWS_PATH)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (Array.isArray(value)) {
              map.set(
                key,
                value.filter(
                  (entry): entry is AgentRateLimitWindow =>
                    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
                )
              )
            }
          }
        }
      }
    } catch (error) {
      Logger.dev('Pi usage windows read failed:', error)
    }
    this.persistedRateLimits = map
    return map
  }

  /** Store the latest windows for a pi provider; writes are serialized and
   *  bounded so a long-lived driver never grows the file without bound. */
  private async rememberPersistedRateLimits(
    providerId: string,
    windows: AgentRateLimitWindow[]
  ): Promise<void> {
    const map = await this.loadPersistedRateLimits()
    map.delete(providerId)
    map.set(providerId, windows)
    while (map.size > PiDriver.USAGE_WINDOWS_MAX_PROVIDERS) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
    if (this.persistedRateLimitsWrite) return
    const snapshot = JSON.stringify(Object.fromEntries(map))
    this.persistedRateLimitsWrite = this.storage
      .writeRaw(PiDriver.USAGE_WINDOWS_PATH, snapshot)
      .catch((error: unknown) => Logger.dev('Pi usage windows write failed:', error))
      .finally(() => {
        this.persistedRateLimitsWrite = null
      })
    await this.persistedRateLimitsWrite
  }

  private handleUiRequest(record: Record<string, unknown>, sessionId: string): void {
    const rawId = record['id']
    const method = stringValue(record['method'])
    const client = this.rpcClients.get(sessionId)
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !method || !client) return
    const requestId = `pi-ui-${sessionId}-${String(rawId)}`.replace(/[^a-zA-Z0-9._-]/gu, '-')
    // The core-tools extension's permission gate marks its confirm dialogs
    // with a structured payload so they surface as real permission cards
    // (policy enrichment, allow/reject) instead of plain question cards.
    const permissionPayload = this.permissionMarkerPayload(record)
    if (permissionPayload) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-permission',
        client,
        request: record
      })
      this.emit({
        type: 'permission.asked',
        sessionId,
        permission: {
          id: requestId,
          sessionId,
          permission: permissionPayload.permission,
          patterns: permissionPayload.patterns,
          metadata: {
            ...(permissionPayload.tool ? { tool: permissionPayload.tool } : {}),
            ...(permissionPayload.command ? { command: permissionPayload.command } : {}),
            reason: stringValue(record['title']) ?? 'Destructive action requires approval'
          }
        }
      })
      return
    }
    // Pi has no structured question RPC method. The core-tools extension sends
    // one tagged envelope through the dialog channel and the driver unwraps it
    // directly into the shared question contract.
    const markedQuestions = this.questionMarkerPayload(record)
    if (markedQuestions) {
      this.pendingUiRequests.set(requestId, {
        sessionId,
        method: 'cio-question',
        client,
        request: record
      })
      this.emit({ type: 'question.asked', sessionId, requestId, questions: markedQuestions })
      return
    }
    const questions = normalizeAgentQuestions({
      questions: [
        {
          prompt:
            stringValue(record['title']) ??
            stringValue(record['message']) ??
            'Pi needs your input.',
          header: stringValue(record['title']),
          description: stringValue(record['message']),
          options: Array.isArray(record['options']) ? record['options'] : undefined,
          custom: method !== 'confirm'
        }
      ]
    })
    this.pendingUiRequests.set(requestId, { sessionId, method, client, request: record })
    this.emit({ type: 'question.asked', sessionId, requestId, questions })
  }

  /** Parse the core-tools extension's canonical question envelope. */
  private questionMarkerPayload(record: Record<string, unknown>): AgentQuestion[] | null {
    const title = stringValue(record['title'])
    if (!title?.startsWith(CIO_QUESTION_MARKER)) return null
    try {
      const payload = JSON.parse(title.slice(CIO_QUESTION_MARKER.length)) as {
        questions?: unknown
      }
      if (!Array.isArray(payload.questions)) return null
      return normalizeAgentQuestions({ questions: payload.questions })
    } catch {
      return null
    }
  }

  /** Parse the core-tools permission gate's marker payload from a confirm
   *  dialog, or null when the dialog is an ordinary confirmation. */
  private permissionMarkerPayload(
    record: Record<string, unknown>
  ): { permission: string; patterns: string[]; tool?: string; command?: string } | null {
    if (stringValue(record['method']) !== 'confirm') return null
    const message = stringValue(record['message'])
    if (!message?.startsWith(CIO_PERMISSION_MARKER)) return null
    try {
      const payload = JSON.parse(message.slice(CIO_PERMISSION_MARKER.length)) as {
        permission?: unknown
        patterns?: unknown
        tool?: unknown
        command?: unknown
      }
      const permission = typeof payload.permission === 'string' ? payload.permission : ''
      if (!permission) return null
      const patterns = Array.isArray(payload.patterns)
        ? payload.patterns.filter((pattern): pattern is string => typeof pattern === 'string')
        : []
      return {
        permission,
        patterns,
        ...(typeof payload.tool === 'string' ? { tool: payload.tool } : {}),
        ...(typeof payload.command === 'string' ? { command: payload.command } : {})
      }
    } catch {
      return null
    }
  }

  /** Resolve the core-tools permission gate's confirm dialog. `reject` also
   *  covers alternative-instruction rejects: the gate blocks the tool call and
   *  the engine delivers the corrective feedback to the model separately. */
  override async replyPermission(
    _projectPath: string,
    requestId: string,
    reply: PermissionReply,
    _message?: string,
    _sessionId?: string
  ): Promise<void> {
    void _projectPath
    void _message
    void _sessionId
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.method !== 'cio-permission') {
      throw new Error(`Pi permission request is no longer pending: ${requestId}`)
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi permission request has an invalid id: ${requestId}`)
    }
    request.client.respondToExtensionUiRequest(
      rawId,
      reply === 'reject' ? { cancelled: true } : { confirmed: true }
    )
    this.pendingUiRequests.delete(requestId)
  }

  override async replyToQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    const answer = answers[0]?.[0] ?? ''
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    if (request.method === 'confirm') {
      request.client.respondToExtensionUiRequest(rawId, {
        confirmed: /^(true|yes|y|allow|ok)$/iu.test(answer)
      })
    } else if (request.method === 'cio-question') {
      request.client.respondToExtensionUiRequest(rawId, { value: JSON.stringify(answers) })
    } else {
      request.client.respondToExtensionUiRequest(rawId, { value: answer })
    }
    this.pendingUiRequests.delete(requestId)
  }

  override async rejectQuestion(
    _projectPath: string,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const request = this.pendingUiRequests.get(requestId)
    if (!request || request.sessionId !== sessionId) {
      throw new QuestionRequestGoneError(sessionId, requestId, this.name)
    }
    const rawId = request.request['id']
    if (typeof rawId !== 'string' && typeof rawId !== 'number') {
      throw new Error(`Pi question request has an invalid id: ${requestId}`)
    }
    request.client.respondToExtensionUiRequest(rawId, { cancelled: true })
    this.pendingUiRequests.delete(requestId)
  }

  /** Attach the final session-stats context usage to the last assistant message. */
  private async refreshSessionUsage(session: PersistentCliSession): Promise<void> {
    const client = this.rpcClients.get(session.id)
    if (!client) return
    const lastAssistant = [...session.messages].reverse().find((message) => {
      return message.role === 'assistant'
    })
    if (!lastAssistant) return
    try {
      const stats = record(await client.getSessionStats())
      const contextUsage = record(stats?.['contextUsage'])
      const tokens = mapPiUsage(stats?.['tokens'])
      const cost =
        typeof stats?.['cost'] === 'number' ? (stats['cost'] as number) : mapPiCost(stats)
      const contextWindow = numberValue(contextUsage?.['contextWindow'])
      const contextUsed = numberValue(contextUsage?.['tokens'])
      const rateLimits = this.latestRateLimits.get(session.id)?.windows ?? []
      if (
        tokens === undefined &&
        cost === undefined &&
        contextWindow === undefined &&
        contextUsed === undefined &&
        rateLimits.length === 0
      ) {
        return
      }
      const event: SessionAgentEvent = {
        type: 'usage.updated',
        sessionId: session.id,
        messageId: lastAssistant.id,
        ...(tokens ? { tokens } : {}),
        ...(cost !== undefined ? { cost } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {}),
        ...(rateLimits.length > 0 ? { rateLimits } : {})
      }
      this.applyEventToSession(session, event)
      this.emit(event)
    } catch (error) {
      // A disposed client means the session was torn down mid-refresh — an
      // expected race at turn end, not a failure worth surfacing.
      if (error instanceof Error && error.message === 'Pi process disposed') return
      Logger.dev('Pi session stats refresh failed:', error)
    }
  }

  private async finishTurn(session: PersistentCliSession): Promise<void> {
    try {
      await this.persistSession(session)
    } catch (error) {
      Logger.error('Pi session persistence failed:', error)
    }
    this.emit({ type: 'session.idle', sessionId: session.id })
  }

  /**
   * Write the app-owned status extension to a shared temp file (once per
   * driver). The cached path is reused across sessions; a failed write
   * returns null and the session launches without status monitoring instead
   * of failing the turn.
   */
  /**
   * Materialize one app-owned gateway extension module plus its session-keyed
   * handoff file. The extension registers the gateway tools at pi spawn, while
   * the handoff is rewritten per turn by `publishUtilityGatewayEndpoint`;
   * this method only guarantees both files exist. The extension embeds the
   * absolute handoff path, so both files are session-keyed — concurrent
   * sessions never overwrite each other's turn credentials.
   */
  private async materializeGatewayExtension(sessionId: string): Promise<string | null> {
    const existing = this.gatewayExtensionPaths.get(sessionId)
    if (existing) return existing
    try {
      const directory = join('runtime', 'pi-utility-gateway', sessionId)
      const handoffRelative = join(directory, 'handoff.json')
      const extensionRelative = join(directory, 'codeinoven-utility-gateway.ts')
      // Empty endpoint values: the tools surface a clear gateway-inactive error
      // until the first direct-gateway turn publishes the real { url, token }.
      await this.storage.writeRaw(handoffRelative, JSON.stringify({ url: '', token: '' }))
      const handoffAbsolute = this.storage.resolve(handoffRelative)
      await this.storage.writeRaw(
        extensionRelative,
        piUtilityGatewayExtension().replace(
          '__HANDOFF_PATH__',
          JSON.stringify(handoffAbsolute).slice(1, -1)
        )
      )
      // Storage-relative: publishUtilityGatewayEndpoint and removeGatewayHandoff
      // route through storage.writeRaw/removeRaw, which resolve paths themselves
      // and reject an already-absolute one.
      this.gatewayHandoffPaths.set(sessionId, handoffRelative)
      const extensionAbsolute = this.storage.resolve(extensionRelative)
      this.gatewayExtensionPaths.set(sessionId, extensionAbsolute)
      // Flush an endpoint that arrived before this materialization (first turn of
      // a fresh session); the handoff file still holds the empty seed otherwise.
      const pendingEndpoint = this.pendingGatewayEndpoints.get(sessionId)
      if (pendingEndpoint) {
        this.pendingGatewayEndpoints.delete(sessionId)
        await this.storage.writeRaw(handoffRelative, JSON.stringify(pendingEndpoint))
      }
      return extensionAbsolute
    } catch (error) {
      // A failed materialization must never block the turn; the prose curl
      // fallback stays fully functional without the extension.
      Logger.dev('Pi utility gateway extension materialization failed:', error)
      return null
    }
  }

  private async materializeCoreToolsExtension(sessionId: string): Promise<string | null> {
    const existing = this.coreToolsExtensionPaths.get(sessionId)
    if (existing) return existing
    if (this.coreToolsExtensionFailed) return null
    try {
      const directory = join('runtime', 'pi-core-tools', sessionId)
      const systemPromptRelative = join(directory, 'system-prompt.txt')
      const extensionRelative = join(directory, 'codeinoven-core-tools.ts')
      await this.storage.writeRaw(systemPromptRelative, '')
      const systemPromptAbsolute = this.storage.resolve(systemPromptRelative)
      await this.storage.writeRaw(
        extensionRelative,
        piCoreToolsExtension().replace(
          '__CIO_SYSTEM_PROMPT_PATH__',
          JSON.stringify(systemPromptAbsolute).slice(1, -1)
        )
      )
      this.cioSystemPromptPaths.set(sessionId, systemPromptRelative)
      const extensionAbsolute = this.storage.resolve(extensionRelative)
      this.coreToolsExtensionPaths.set(sessionId, extensionAbsolute)
      return extensionAbsolute
    } catch (error) {
      this.coreToolsExtensionFailed = true
      Logger.dev('Pi core-tools extension materialization failed:', error)
      return null
    }
  }

  /** Rewrite the session's CIO system-prompt handoff file so the extension's
   *  `before_agent_start` hook picks it up on the next agent loop start. A
   *  missing materialized path (extension failed to load) means the turn
   *  falls back to Pi's own system prompt only — never blocks the turn. */
  private async publishCioSystemPrompt(sessionId: string, systemPrompt: string): Promise<void> {
    const path = this.cioSystemPromptPaths.get(sessionId)
    if (!path) return
    try {
      await this.storage.writeRaw(path, systemPrompt)
    } catch (error) {
      Logger.dev('Pi core-tools system-prompt handoff update failed:', error)
    }
  }

  private async materializeStatusExtension(): Promise<string | null> {
    if (this.statusExtensionPath) return this.statusExtensionPath
    if (this.statusExtensionFailed) return null
    try {
      if (!this.statusExtensionDirectory) {
        this.statusExtensionDirectory = await mkdtemp(join(tmpdir(), 'codeinoven-pi-status-'))
      }
      const path = join(this.statusExtensionDirectory, 'codeinoven-status.ts')
      await writeFile(path, piStatusExtension(), 'utf8')
      this.statusExtensionPath = path
      return path
    } catch (error) {
      this.statusExtensionFailed = true
      Logger.dev('Pi status extension materialization failed:', error)
      return null
    }
  }

  /**
   * Write the app-owned usage extension to a shared temp file (once per
   * driver). The cached path is reused across sessions; a failed write
   * returns null and the session launches without usage bars instead of
   * failing the turn.
   */
  private async materializeUsageExtension(): Promise<string | null> {
    if (this.usageExtensionPath) return this.usageExtensionPath
    if (this.usageExtensionFailed) return null
    try {
      if (!this.usageExtensionDirectory) {
        this.usageExtensionDirectory = await mkdtemp(join(tmpdir(), 'codeinoven-pi-usage-'))
      }
      const path = join(this.usageExtensionDirectory, 'codeinoven-usage.ts')
      await writeFile(path, piUsageExtension(), 'utf8')
      this.usageExtensionPath = path
      return path
    } catch (error) {
      this.usageExtensionFailed = true
      Logger.dev('Pi usage extension materialization failed:', error)
      return null
    }
  }

  private disposeRpcClient(sessionId: string): void {
    const client = this.rpcClients.get(sessionId)
    if (client) {
      client.dispose()
      this.rpcClients.delete(sessionId)
    }
    this.resumedNativeSessions.delete(sessionId)
    this.appliedPiSettings.delete(sessionId)
    this.latestRateLimits.delete(sessionId)
  }

  private async buildProviderOverlay(projectPath: string): Promise<ProviderOverlay> {
    const args: string[] = []
    const env: Record<string, string> = {}
    let directory: string | null = null
    const providers = this.baseUrlProviders
      ? await this.baseUrlProviders.listEnabled(this.id).catch(() => [])
      : []
    if (providers.length > 0 && this.secretVault) {
      for (const provider of providers) {
        if (!provider.apiKeyRef || !provider.apiKeyEnvVar) continue
        env[provider.apiKeyEnvVar] = await this.secretVault.resolve(provider.apiKeyRef)
      }
      directory = await mkdtemp(join(tmpdir(), 'codeinoven-pi-providers-'))
      const extensionPath = join(directory, 'codeinoven-providers.ts')
      await writeFile(extensionPath, piCustomProvidersExtension(providers), 'utf8')
      args.push('--extension', extensionPath)
    }
    void projectPath
    return {
      args,
      env,
      cleanup: async () => {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }
}
