import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'url'
import type {
  AgentMessage,
  AgentPart,
  AgentRateLimitWindow,
  AgentTokenUsage,
  PromptAttachment,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent
} from '../../lib/types'
import { PI_THINKING_PRESETS } from '../../lib/pi-thinking-presets'
import { normalizeAgentQuestions } from '../../lib/agent-interactions'
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
import type { HarnessCommand, ThreadSettings } from '../../lib/types'
import { classifyProviderIssue } from '../../lib/provider-issue'
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
import {
  PI_STATUS_COMPACTING,
  PI_STATUS_EXTENSION_KEY,
  PI_STATUS_IDLE,
  PI_STATUS_WORKING,
  piStatusExtension
} from './pi-status-extension'
import { PiRpcClient } from './pi-rpc-client'
import {
  prepareHarnessInvocation,
  resolveHarnessRuntime,
  runHarnessCommand
} from './harness-runtime'

const THINKING_PRESETS = PI_THINKING_PRESETS

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

function messageTimestamp(value: Record<string, unknown>): number {
  return numberValue(value['timestamp']) ?? Date.now()
}

/**
 * Pi's rate-limit/quota error text embeds an ISO-8601 reset time (e.g.
 * `Your limit resets at 2026-08-28T22:52:23.222Z.`). Extract it so the retry
 * scheduler gets a concrete `retryAt` instead of waiting on a manual retry.
 */
function piUsageLimitResetAt(message: string, now = Date.now()): number | undefined {
  const match = message.match(/resets? at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu)
  if (!match) return undefined
  const resetMs = Date.parse(match[1])
  if (!Number.isFinite(resetMs) || resetMs <= now) return undefined
  return resetMs
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
const SILENT_CONTINUE_MAX_ATTEMPTS = 3

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
      const retryAt =
        kind === 'quota' || kind === 'rate_limit'
          ? piUsageLimitResetAt(lastAssistant.error)
          : undefined
      return {
        events: [
          {
            type: 'session.status',
            sessionId: context.sessionId,
            status: {
              state: 'error',
              issue: {
                kind,
                message: lastAssistant.error,
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
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: false,
    scheduledRetry: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, PiTurnState>()
  private rpcClients = new Map<string, PiRpcClient>()
  private sessionProjects = new Map<string, string>()
  private activeTurns = new Set<string>()
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
  /** WSL-aware read view of Pi's own credential store (`~/.pi/agent/auth.json`). */
  private readonly authConfig = new PiAuthConfigService(undefined, piAuthFileIo)

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
    if (!client || !this.activeTurns.has(sessionId)) {
      throw new Error(`No active Pi turn is available to compact for session ${sessionId}`)
    }
    // pi emits compaction_start/compaction_end events as it summarizes; awaiting
    // here keeps the compaction handoff deterministic from the caller's view.
    await client.compact()
  }

  override async sendPrompt(projectPath: string, options: SendPromptOptions): Promise<void> {
    const session = await this.requireSession(projectPath, options.sessionId)
    if (this.activeTurns.has(session.id)) {
      throw new Error(`A turn is already active for session ${session.id}`)
    }
    const client = await this.ensureRpcClient(projectPath, session.id)
    const model = this.resolveModel(options.settings.providerId, options.settings.modelId)
    if (!model) {
      throw new Error(
        `Pi model is unavailable: ${options.settings.providerId}/${options.settings.modelId}`
      )
    }
    await client.setModel(model.provider, model.modelId)
    await client.setThinkingLevel(piThinkingLevel(options.settings.thinkingLevel))

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
    const prompt = [
      options.systemPrompt ? options.systemPrompt : '',
      inlineSvg,
      ...references,
      options.text
    ]
      .filter(Boolean)
      .join('\n\n')

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

  async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    await this.requireSession(projectPath, options.sessionId)
    const client = this.rpcClients.get(options.sessionId)
    if (!client || !this.activeTurns.has(options.sessionId)) {
      throw new Error(`No active Pi turn is available to steer for session ${options.sessionId}`)
    }
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
    const message = [inlineSvg, ...references, options.text].filter(Boolean).join('\n\n')
    await client.steer(message, images)
  }

  override async abort(projectPath: string, sessionId: string): Promise<void> {
    await this.requireSession(projectPath, sessionId)
    const client = this.rpcClients.get(sessionId)
    if (!client) return
    try {
      await client.abort()
    } catch {
      // The turn may have already ended.
    } finally {
      this.activeTurns.delete(sessionId)
    }
  }

  override async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    this.disposeRpcClient(sessionId)
    this.activeTurns.delete(sessionId)
    this.turnStates.delete(sessionId)
    this.silentContinues.delete(sessionId)
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
   * Pi only reports token/context usage over its RPC session (no local usage
   * file like Claude Code or Codex), so this can only answer while a session
   * for the project is already running — battery hover triggers this after a
   * turn has started one. Returns null (never a turn) otherwise, matching the
   * documented "no turn yet" contract other drivers rely on.
   */
  async readAccountUsage(projectPath: string): Promise<{
    rateLimits: AgentRateLimitWindow[]
    contextWindow?: number
    contextUsed?: number
  } | null> {
    const sessionId = [...this.sessionProjects.entries()].find(
      ([, clientProject]) => clientProject === projectPath
    )?.[0]
    const client = sessionId ? this.rpcClients.get(sessionId) : undefined
    if (!client) return null
    try {
      const stats = record(await client.getSessionStats())
      const contextUsage = record(stats?.['contextUsage'])
      const contextWindow = numberValue(contextUsage?.['contextWindow'])
      const contextUsed = numberValue(contextUsage?.['tokens'])
      if (contextWindow === undefined && contextUsed === undefined) return null
      return {
        rateLimits: [],
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(contextUsed !== undefined ? { contextUsed } : {})
      }
    } catch (error) {
      Logger.dev('Pi account usage read failed:', error)
      return null
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
    const statusDirectory = this.statusExtensionDirectory
    this.statusExtensionPath = null
    this.statusExtensionDirectory = null
    if (statusDirectory) {
      void rm(statusDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
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
      // Best-effort tuning: a transient failure here must never block the turn.
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

  /** Mirror the native pi session id so driver records stay addressable. */
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

  private handleUiRequest(record: Record<string, unknown>, sessionId: string): void {
    const rawId = record['id']
    const method = stringValue(record['method'])
    const client = this.rpcClients.get(sessionId)
    if ((typeof rawId !== 'string' && typeof rawId !== 'number') || !method || !client) return
    const requestId = `pi-ui-${sessionId}-${String(rawId)}`.replace(/[^a-zA-Z0-9._-]/gu, '-')
    const prompt =
      stringValue(record['title']) ?? stringValue(record['message']) ?? 'Pi needs your input.'
    const questions = normalizeAgentQuestions({
      questions: [
        {
          prompt,
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
      if (
        tokens === undefined &&
        cost === undefined &&
        contextWindow === undefined &&
        contextUsed === undefined
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
        ...(contextUsed !== undefined ? { contextUsed } : {})
      }
      this.applyEventToSession(session, event)
      this.emit(event)
    } catch (error) {
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

  private disposeRpcClient(sessionId: string): void {
    const client = this.rpcClients.get(sessionId)
    if (client) {
      client.dispose()
      this.rpcClients.delete(sessionId)
    }
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
