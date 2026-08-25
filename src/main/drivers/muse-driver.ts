import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  PermissionReply,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent,
  ThinkingLevel,
  ThinkingPreset
} from '../../lib/types'
import { THINKING_LEVEL_ORDER } from '../../lib/thinking-presets'
import {
  isQuestionToolName,
  isTodoToolName,
  normalizeAgentQuestions,
  normalizeInteractionName,
  permissionPatterns
} from '../../lib/agent-interactions'
import { attachmentReference, attachmentTarget } from './attachment-reference'
import { buildProcessEnvironment } from './cli-environment'
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
  SendPromptOptions
} from './driver.interface'
import type { StorageEngine } from '../storage/storage-engine'
import { runHarnessCommand } from './harness-runtime'

/**
 * Muse Code (Meta) headless integration notes.
 *
 * Muse is a terminal-only coding agent whose programmatic surface is
 * `muse exec --json` — a one-shot, headless run that streams newline-delimited
 * JSON on stdout and exits when the turn is done. CodeInOven deliberately runs
 * every turn without Muse-native session history, workspace rules, or skills;
 * the app supplies its own bounded history recap, behavior, memory, and utility
 * context in the explicit prompt.
 *
 * Wire schema: every line is an envelope `{ record_type, payload_type, payload }`.
 * Meaningful payloads:
 *   - `run.output.delta`  → `payload.text` (incremental assistant text)
 *   - `run.terminal.completed` → `payload.terminal` (`completed`|`error`),
 *     `payload.text` (final), `payload.reason`
 *   - `run.model.configured` → `payload.provider_id` / `payload.model_id`
 *   - `task.lifecycle.proposed` → tool call announced (`event.task_kind` `tool.*`)
 *   - `task.lifecycle.side_effect_intent` → tool running + provider call id
 *   - `task.lifecycle.output` → tool chunk (bash `{command,description,output}`)
 *   - `tool.result` → authoritative tool completion (`call_id`, `text`)
 * The provider session UUID is intentionally not reused. The live stream is
 * the sole source of provider events because native session logs are disabled.
 * There is no per-record token/usage telemetry.
 *
 * Meta's Muse Code launch documentation also demonstrates a local video file
 * being supplied directly in the terminal and interpreted by Muse Code:
 * https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2
 */

const MUSE_PROBE_TIMEOUT_MS = 15_000
/** Provider id under which every Muse-cloud model is catalogued. */
const MUSE_PROVIDER_ID = 'meta'

interface MuseCliCapabilities {
  reasoningEfforts: ThinkingLevel[]
  thinkingPresets: ThinkingPreset[]
  attachments: boolean
  toolCalls: boolean
}

let museCliCapabilitiesProbe: Promise<MuseCliCapabilities> | undefined

function thinkingPresetLabel(effort: ThinkingLevel): string {
  if (effort === 'xhigh') return 'Extra high'
  return `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
}

/** Parse the installed Muse CLI's advertised headless capability surface. */
function parseMuseCliCapabilities(help: string): MuseCliCapabilities {
  const effortLine = help.match(/Meta reasoning effort:\s*([^\n]+)/iu)?.[1] ?? ''
  const supportedThinkingLevels = new Set<ThinkingLevel>(THINKING_LEVEL_ORDER)
  const reasoningEfforts = effortLine
    .split('|')
    .map((value) => value.trim())
    .filter((value): value is ThinkingLevel => supportedThinkingLevels.has(value as ThinkingLevel))
  return {
    reasoningEfforts,
    thinkingPresets: reasoningEfforts.map((effort) => ({
      id: effort,
      label: thinkingPresetLabel(effort)
    })),
    attachments: /^\s*--image\s+<PATH>/mu.test(help),
    toolCalls: /^\s*--disable-(?:shell|write)\b/mu.test(help)
  }
}

/** Probe once per app process; a failed probe is retryable instead of becoming stale state. */
async function readMuseCliCapabilities(): Promise<MuseCliCapabilities> {
  if (!museCliCapabilitiesProbe) {
    museCliCapabilitiesProbe = runMuse(['exec', '--help'], MUSE_PROBE_TIMEOUT_MS)
      .then((result) => {
        if (!result.succeeded) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'Muse help probe failed')
        }
        return parseMuseCliCapabilities(`${result.stdout}\n${result.stderr}`)
      })
      .catch((error: unknown) => {
        museCliCapabilitiesProbe = undefined
        throw error
      })
  }
  return museCliCapabilitiesProbe
}

function museModel(
  id: string,
  providerId: string,
  name: string,
  capabilities: MuseCliCapabilities,
  contextWindow?: number
): ProviderModel {
  return {
    id,
    providerId,
    name,
    reasoning: capabilities.reasoningEfforts.length > 0,
    ...(capabilities.thinkingPresets.length > 0
      ? { thinkingPresets: capabilities.thinkingPresets }
      : {}),
    attachment: capabilities.attachments,
    toolcall: capabilities.toolCalls,
    ...(contextWindow === undefined ? {} : { contextWindow })
  }
}

/**
 * Fallback catalog for the Meta provider. Muse exposes no model-list
 * subcommand, so use its default selection without fabricating an account-tier
 * model id. Capabilities still come from the installed CLI probe.
 */
function museFallbackCatalog(capabilities: MuseCliCapabilities): ProviderCatalog[] {
  return [
    {
      id: MUSE_PROVIDER_ID,
      name: 'Meta',
      harnessId: 'muse',
      models: [museModel('default', MUSE_PROVIDER_ID, 'Muse default', capabilities)]
    }
  ]
}

/**
 * Muse caches the provider's model catalog locally at
 * `~/.local/share/muse/model-catalog/*.json`, keyed by provider/profile. Read it
 * so the picker reflects the account's real models (id, display label, context
 * limit) instead of the default placeholder. Returns no discovered providers
 * when the cache is missing or unreadable (e.g. before the first logged-in run).
 */
async function readMuseModelCatalog(capabilities: MuseCliCapabilities): Promise<ProviderCatalog[]> {
  const directory = join(homedir(), '.local', 'share', 'muse', 'model-catalog')
  let files: string[]
  try {
    files = (await readdir(directory)).filter((file) => file.endsWith('.json'))
  } catch {
    return []
  }
  const catalogs = new Map<string, ProviderCatalog>()
  for (const file of files) {
    let raw: string
    try {
      raw = await readFile(join(directory, file), 'utf8')
    } catch {
      continue
    }
    let catalog: unknown
    try {
      catalog = JSON.parse(raw) as unknown
    } catch {
      continue
    }
    const root = record(catalog)
    if (!root) continue
    const providerId = stringValue(root['provider_id']) ?? MUSE_PROVIDER_ID
    const rows = Array.isArray(root['rows']) ? root['rows'] : []
    interface CatalogRow {
      model: ProviderModel
      current: boolean
      default: boolean
      order: number
    }
    const catalogRows: CatalogRow[] = []
    for (const rawRow of rows) {
      const row = record(rawRow)
      if (!row) continue
      const modelId = stringValue(row['model_id'])
      if (!modelId) continue
      const contextLimit = numberValue(row['context_limit'])
      catalogRows.push({
        model: museModel(
          modelId,
          providerId,
          stringValue(row['display_label']) ?? modelId,
          capabilities,
          contextLimit
        ),
        current: row['is_current'] === true,
        default: row['is_default'] === true,
        order: numberValue(row['display_order']) ?? 0
      })
    }
    if (catalogRows.length === 0) continue
    // Advertise the account's default model first so a fresh thread picks the
    // discounted default rather than the standard tier. `is_default` is stable;
    // `is_current` reflects the last-used model and is only a secondary hint.
    const models = catalogRows
      .sort(
        (left, right) =>
          Number(right.default) - Number(left.default) ||
          Number(right.current) - Number(left.current) ||
          left.order - right.order
      )
      .map((catalogRow) => catalogRow.model)
    const existing = catalogs.get(providerId)
    if (existing) {
      existing.models.push(...models)
    } else {
      catalogs.set(providerId, {
        id: providerId,
        name: providerId === MUSE_PROVIDER_ID ? 'Meta' : providerId,
        harnessId: 'muse',
        models
      })
    }
  }
  return catalogs.size > 0 ? [...catalogs.values()] : []
}

/**
 * Muse CLI reads its stdin and hangs when that pipe stays open without EOF or a
 * terminal. Every short-lived probe (version) must spawn with stdin ignored so
 * it exits promptly in a desktop context.
 */
async function runMuse(
  args: string[],
  timeoutMs: number
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  try {
    const result = await runHarnessCommand('muse', args, {
      env: buildProcessEnvironment(),
      timeoutMs
    })
    return { succeeded: true, ...result }
  } catch (error) {
    return {
      succeeded: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  try {
    return record(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function normalizeMuseQuestions(value: unknown) {
  const source = record(value)
  const rawQuestions = Array.isArray(source?.['questions']) ? source['questions'] : []
  const questions = rawQuestions.map((rawQuestion) => {
    const question = record(rawQuestion)
    const selection = record(question?.['selection'])
    if (!question || selection?.['mode'] !== 'multiple') return rawQuestion
    return { ...question, multiple: true }
  })
  return normalizeAgentQuestions({ questions })
}

function museToolNeedsPermission(toolName: string): boolean {
  if (isQuestionToolName(toolName) || isTodoToolName(toolName)) return false
  const name = normalizeInteractionName(toolName)
  return [
    'bash',
    'shell',
    'terminal',
    'exec',
    'command',
    'write',
    'edit',
    'patch',
    'delete',
    'remove',
    'move',
    'rename',
    'create',
    'mkdir',
    'save',
    'copy',
    'chmod',
    'chown',
    'install',
    'upload',
    'deploy',
    'commit',
    'push',
    'merge',
    'reset',
    'checkout'
  ].some((operation) => name.includes(operation))
}

function museIssue(error: string): AgentProviderIssue {
  const normalized = error.toLowerCase()
  const quota =
    normalized.includes('quota') || normalized.includes('limit') || normalized.includes('402')
  const authentication =
    normalized.includes('auth') || normalized.includes('sign in') || normalized.includes('api key')
  return {
    kind: quota ? 'quota' : authentication ? 'authentication' : 'unknown',
    message: error,
    rawError: error,
    harnessId: 'muse',
    retryable: quota
  }
}

/** In-flight tool-call record correlated across Muse's task lifecycle events. */
interface MuseToolState {
  /** Muse task id shared by `proposed` / `side_effect_intent` / `output`. */
  taskId: string
  /** Provider tool call id, learned from `side_effect_intent` / `tool.result`. */
  callId?: string
  /** Tool name, e.g. `bash`, `write_file`, `read_file`. */
  tool: string
  status: 'pending' | 'running' | 'completed' | 'error'
  input: Record<string, unknown>
  output?: string
  title?: string
  /** Muse policy outcome retained until exported arguments make a card useful. */
  policyDecision?: string
  /** CodeInOven stopped this call before execution to request user approval. */
  requiresPermission?: boolean
  start: number
  end?: number
}

/** Turn-scoped state correlating the streamed records of one assistant message. */
interface MuseTurnState {
  turnIndex: number
  messageId: string
  createdAt: number
  text: string
  parts: AgentPart[]
  /** True once any assistant part has been emitted (message exists on disk). */
  started: boolean
  /** In-flight tool calls keyed by Muse `task_id`. */
  tools: Map<string, MuseToolState>
  /** Reverse map: provider `call_id` → `task_id`, for `tool.result` correlation. */
  toolByCall: Map<string, string>
  /** Question/approval ids already promoted into the shared event stream. */
  promotedInteractions: Set<string>
  /** Gated tool tasks whose permission card has already been surfaced. */
  emittedPermissionTasks: Set<string>
  /** Tool tasks synchronously stopped before Muse could execute them. */
  gatedTaskIds: Set<string>
  /** Muse converts CodeInOven's deliberate SIGTERM into numeric exit code 143. */
  expectsProcessStop: boolean
}

function museMessage(state: MuseTurnState): AgentMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    parts: [...state.parts],
    createdAt: state.createdAt,
    harnessId: 'muse'
  }
}

function upsertPart(state: MuseTurnState, part: AgentPart): void {
  const index = state.parts.findIndex((candidate) => candidate.id === part.id)
  if (index === -1) state.parts.push(part)
  else state.parts[index] = part
  if (!state.started) state.createdAt = Date.now()
  state.started = true
}

function textPart(state: MuseTurnState): Extract<AgentPart, { type: 'text' }> {
  return {
    type: 'text',
    id: `${state.messageId}:text`,
    messageID: state.messageId,
    text: state.text
  }
}

/** Build a `tool` part from an in-flight Muse tool-call record. */
function museToolPart(state: MuseTurnState, tool: MuseToolState): AgentPart {
  return {
    type: 'tool',
    id: `muse-tool-${tool.taskId}`,
    messageID: state.messageId,
    callID: tool.callId ?? `muse-task-${tool.taskId}`,
    tool: tool.tool,
    state: {
      status: tool.status,
      input: tool.input,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.output ? { output: tool.output } : {}),
      time: { start: tool.start, ...(tool.end ? { end: tool.end } : {}) }
    }
  }
}

/** Emit a `message.part.updated` event for the given tool's current state. */
function museToolEvent(context: CliLineParseContext, state: MuseTurnState, tool: MuseToolState) {
  const part = museToolPart(state, tool)
  upsertPart(state, part)
  return { type: 'message.part.updated' as const, sessionId: context.sessionId, part }
}

function museToolForCall(
  state: MuseTurnState,
  toolName: string,
  callId?: string
): MuseToolState | undefined {
  const taskId = callId ? state.toolByCall.get(callId) : undefined
  if (taskId) return state.tools.get(taskId)
  return [...state.tools.values()].find(
    (tool) => tool.tool === toolName && Object.keys(tool.input).length === 0
  )
}

function musePermissionEvent(
  context: CliLineParseContext,
  state: MuseTurnState,
  event: Record<string, unknown>
): SessionAgentEvent | null {
  const details = record(event['request']) ?? record(event['approval']) ?? event
  const requestId = firstString(
    details['approval_id'],
    details['request_id'],
    details['prompt_id'],
    details['tool_call_id'],
    event['approval_id'],
    event['request_id']
  )
  if (!requestId || state.promotedInteractions.has(`permission:${requestId}`)) return null
  const toolName =
    firstString(details['tool_name'], details['operation'], details['name']) ?? 'permission'
  const input =
    parseRecord(details['input']) ??
    parseRecord(details['arguments']) ??
    parseRecord(details['args']) ??
    {}
  for (const key of ['command', 'path', 'cwd', 'description']) {
    const value = details[key]
    if (value !== undefined && input[key] === undefined) input[key] = value
  }
  state.promotedInteractions.add(`permission:${requestId}`)
  return {
    type: 'permission.asked',
    sessionId: context.sessionId,
    permission: {
      id: requestId,
      sessionId: context.sessionId,
      permission: toolName,
      patterns: permissionPatterns(input),
      metadata: { tool: toolName, input }
    }
  }
}

/** Normalize a Muse `tool.<name>` task kind / `tool:<name>` operation into a name. */
function museToolName(value: unknown, strip: 'task_kind' | 'operation'): string | undefined {
  const raw = stringValue(value)
  if (!raw) return undefined
  const prefix = strip === 'task_kind' ? 'tool.' : 'tool:'
  if (!raw.startsWith(prefix)) return undefined
  const name = raw.slice(prefix.length)
  return name.length > 0 ? name : undefined
}

/**
 * Muse treats `@path` in the prompt as a native file mention and strictly
 * resolves it; a glued or unresolvable mention aborts the whole run (exit 1,
 * "file mention @src/app.htmland rejected: file does not exist"). CodeInOven
 * already conveys attached paths to the model through a separate JSON context
 * block, so the literal `@path` token the composer leaves in the message is
 * redundant for Muse. Escape path-like `@` mentions so Muse reads them as plain
 * text instead of attempting (and failing) native attachment resolution.
 * Emails (`user@example.com`) and non-path tokens (`@task:…`, plain words) are
 * left untouched.
 */
function escapeMuseMentions(text: string): string {
  return text.replace(/(^|[\s([{>`])@([^\s()\]}\],;:!?]+)/gu, (match, prefix, token) => {
    const isPath = token.includes('/') || /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8}$/u.test(token)
    if (!isPath) return match
    return `${prefix}\\@${token}`
  })
}

/**
 * Map one `muse exec --json` envelope into CodeInOven's stable shapes.
 *
 * Every line is `{ record_type, payload_type, payload }`; the meaningful
 * payloads are `run.output.delta` (streaming text), `run.terminal.completed`
 * (turn end), and `run.model.configured` (provenance). The top-level session
 * stream ids are observed only as event metadata and are never reused for
 * native conversation history.
 *
 * Unknown record types are ignored so schema drift degrades to a silent turn
 * rather than a broken session. Keeping this boundary pure makes it testable.
 */
export function mapMuseRecord(
  value: unknown,
  context: CliLineParseContext,
  state: MuseTurnState
): CliLineParseResult | null {
  const entry = record(value)
  const payload = record(entry?.['payload'])
  if (!entry || !payload) return null

  const base: CliLineParseResult = {}

  const payloadType = stringValue(entry['payload_type'])
  const taskId = stringValue(payload['task_id'])
  if (payloadType?.includes('approval')) {
    if (
      payloadType.includes('request') ||
      payloadType.includes('proposed') ||
      payloadType.includes('pending')
    ) {
      const approvalEvent = musePermissionEvent(context, state, record(payload['event']) ?? payload)
      if (approvalEvent) return { ...base, events: [approvalEvent] }
    }
  }

  if (payloadType === 'runtime.session') {
    const exportedEvent = record(payload['event'])
    if (!exportedEvent) return base
    const kind = stringValue(exportedEvent['kind'])

    if (kind === 'assistant_tool_calls_committed') {
      const calls = Array.isArray(exportedEvent['tool_calls']) ? exportedEvent['tool_calls'] : []
      const events: SessionAgentEvent[] = []
      for (const rawCall of calls) {
        const call = record(rawCall)
        const callId = stringValue(call?.['call_id'])
        const toolName = stringValue(call?.['name'])
        if (!callId || !toolName) continue
        const tool = museToolForCall(state, toolName, callId)
        if (!tool) continue
        const input = parseRecord(call?.['args'])
        if (input) tool.input = input
        tool.callId = callId
        state.toolByCall.set(callId, tool.taskId)
        events.push(museToolEvent(context, state, tool))
        if (
          tool.requiresPermission ||
          (tool.policyDecision &&
            !tool.policyDecision.startsWith('allow') &&
            tool.policyDecision !== 'not_applicable')
        ) {
          // Surface the card only once — and only after the committed args are
          // available so the permission carries the actual command.
          if (!tool.requiresPermission || !state.emittedPermissionTasks.has(tool.taskId)) {
            const permissionEvent = musePermissionEvent(context, state, {
              approval_id: callId,
              tool_name: toolName,
              input: tool.input
            })
            if (permissionEvent) {
              if (tool.requiresPermission) state.emittedPermissionTasks.add(tool.taskId)
              events.push(permissionEvent)
            }
          }
        }
      }
      return events.length > 0 ? { ...base, events } : base
    }

    if (kind === 'todo_snapshot_updated') {
      const items = Array.isArray(exportedEvent['items']) ? exportedEvent['items'] : []
      const tool = [...state.tools.values()].findLast((candidate) => isTodoToolName(candidate.tool))
      if (!tool || items.length === 0) return base
      tool.input = { todos: items }
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }

    if (kind === 'user_input_prompt_requested') {
      const requestId =
        firstString(exportedEvent['tool_call_id'], exportedEvent['prompt_id']) ?? taskId
      if (!requestId || state.promotedInteractions.has(`question:${requestId}`)) return base
      const tool = museToolForCall(state, 'request_user_input', requestId)
      if (tool && Object.keys(tool.input).length === 0) {
        tool.input = { questions: exportedEvent['questions'] }
      }
      const questions = normalizeMuseQuestions(
        tool?.input ?? { questions: exportedEvent['questions'] }
      )
      state.promotedInteractions.add(`question:${requestId}`)
      return {
        ...base,
        events: [
          ...(tool ? [museToolEvent(context, state, tool)] : []),
          {
            type: 'question.asked',
            sessionId: context.sessionId,
            requestId,
            questions,
            ...(tool
              ? { tool: { messageID: state.messageId, callID: tool.callId ?? requestId } }
              : {})
          }
        ]
      }
    }

    if (
      kind?.includes('approval') &&
      (kind.includes('request') || kind.includes('proposed') || kind.includes('pending'))
    ) {
      const event = musePermissionEvent(context, state, exportedEvent)
      return event ? { ...base, events: [event] } : base
    }
    return base
  }

  // Tool call proposed — announce a pending tool card in the working trace.
  if (payloadType === 'task.lifecycle.proposed') {
    const event = record(payload['event'])
    const taskKind = museToolName(event?.['task_kind'], 'task_kind')
    if (taskId && taskKind) {
      const tool: MuseToolState = {
        taskId,
        tool: taskKind,
        status: 'pending',
        input: record(event?.['input']) ?? record(event?.['arguments']) ?? {},
        ...(state.gatedTaskIds.has(taskId) ? { requiresPermission: true } : {}),
        start: Date.now()
      }
      state.tools.set(taskId, tool)
      if (tool.requiresPermission) {
        // Deliberately do NOT emit the permission card here: Muse streams the
        // command after `proposed` (`assistant_tool_calls_committed` /
        // `task.lifecycle.output`), so a card emitted on this record would
        // surface empty details. Keep the pending tool card and surface the
        // permission once the command is known.
        return { ...base, events: [museToolEvent(context, state, tool)] }
      }
      // The live stream does not expose the rich question arguments. Keep the
      // generic tool out of the conversation rather than duplicating the
      // provider's own headless auto-resolution.
      if (isQuestionToolName(taskKind)) return base
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }
    return base
  }

  if (payloadType === 'task.lifecycle.scheduled') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const idempotencyKey = stringValue(record(payload['event'])?.['idempotency_key'])
    const callId = idempotencyKey?.split(':').find((segment) => segment.startsWith('call_'))
    if (callId) {
      tool.callId = callId
      state.toolByCall.set(callId, tool.taskId)
    }
    return base
  }

  // Tool call accepted for execution — flip to running and record the provider
  // call id (also the key used later by `tool.result`).
  if (payloadType === 'task.lifecycle.side_effect_intent') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const event = record(payload['event'])
    const policyDecision = stringValue(event?.['policy_decision'])
    if (policyDecision) {
      tool.policyDecision = policyDecision
    }
    const idempotencyKey = stringValue(event?.['idempotency_key'])
    const foundCallId = idempotencyKey?.split(':').find((segment) => segment.startsWith('call_'))
    if (foundCallId && taskId) {
      tool.callId = foundCallId
      state.toolByCall.set(foundCallId, taskId)
    }
    tool.status = 'running'
    let sideEffectEvents: SessionAgentEvent[] = []
    if (tool.requiresPermission && !state.emittedPermissionTasks.has(tool.taskId)) {
      const permissionEvent = musePermissionEvent(context, state, {
        approval_id: tool.callId ?? taskId,
        tool_name: tool.tool,
        input: tool.input
      })
      if (permissionEvent) {
        state.emittedPermissionTasks.add(tool.taskId)
        sideEffectEvents = [permissionEvent]
      }
    }
    if (isQuestionToolName(tool.tool)) return base
    return {
      ...base,
      events: [museToolEvent(context, state, tool), ...sideEffectEvents]
    }
  }

  // Tool output chunk — for bash it is a JSON `{command, description, output}`;
  // for write/read it is the human-readable result. Prefer `tool.result` for the
  // authoritative completion; this fills the input/title early so the card is
  // meaningful while still running.
  if (payloadType === 'task.lifecycle.output') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const chunk = stringValue(record(payload['event'])?.['chunk'])
    if (!chunk) return base
    let parsed: Record<string, unknown> | null = null
    if (chunk.startsWith('{')) {
      try {
        parsed = record(JSON.parse(chunk) as unknown)
      } catch {
        parsed = null
      }
    }
    if (parsed) {
      const command = stringValue(parsed['command'])
      const description = stringValue(parsed['description'])
      const output = stringValue(parsed['output'])
      if (command) tool.input = { command }
      if (description) tool.title = description
      if (output) tool.output = output
    } else {
      tool.output = chunk
      if (!tool.title) tool.title = tool.tool
    }
    let outputEvents: SessionAgentEvent[] = []
    if (
      tool.requiresPermission &&
      !state.emittedPermissionTasks.has(tool.taskId) &&
      typeof tool.input['command'] === 'string' &&
      tool.input['command'].trim().length > 0
    ) {
      const permissionEvent = musePermissionEvent(context, state, {
        approval_id: tool.callId ?? taskId,
        tool_name: tool.tool,
        input: tool.input
      })
      if (permissionEvent) {
        state.emittedPermissionTasks.add(tool.taskId)
        outputEvents = [permissionEvent]
      }
    }
    if (isQuestionToolName(tool.tool)) return base
    return {
      ...base,
      events: [museToolEvent(context, state, tool), ...outputEvents]
    }
  }

  // Tool result — authoritative completion; correlate by provider call id.
  if (payloadType === 'tool.result') {
    const callId = stringValue(payload['call_id'])
    const taskIdFromCall = callId ? state.toolByCall.get(callId) : undefined
    const tool = taskIdFromCall ? state.tools.get(taskIdFromCall) : undefined
    if (!tool) return base
    const facts = record(payload['correlation_facts'])
    const outcome = stringValue(facts?.['outcome'])
    const text = stringValue(payload['text'])
    const failed = outcome === 'failure' || outcome === 'error'
    tool.status = failed ? 'error' : 'completed'
    if (text) tool.output = text
    // `edit_facts.path` is the project-relative file that the tool changed.
    // Surfacing it as the tool input lets the checkpoint change tracker map the
    // edit to a concrete path, so the working-trace diff and rollback capture
    // the model's edits (not just the user's own changes).
    const editFacts = record(payload['edit_facts'])
    const editedPath = stringValue(editFacts?.['path'])
    if (editedPath) {
      tool.input = { path: editedPath, ...tool.input }
      if (!tool.title) tool.title = editedPath
    }
    tool.end = Date.now()
    if (isQuestionToolName(tool.tool)) return base
    return { ...base, events: [museToolEvent(context, state, tool)] }
  }

  // Streaming assistant text — `payload.text` is an incremental delta.
  if (payloadType === 'run.output.delta') {
    const delta = stringValue(payload['text'])
    if (delta) {
      state.text += delta
      upsertPart(state, textPart(state))
      return {
        ...base,
        messages: [museMessage(state)],
        events: [
          { type: 'message.part.updated', sessionId: context.sessionId, part: textPart(state) }
        ]
      }
    }
    return base
  }

  // Turn end — `payload.terminal` is `completed` on success, anything else is an
  // error. `payload.text` is the authoritative final text.
  if (payloadType === 'run.terminal.completed') {
    const terminal = stringValue(payload['terminal'])
    const finalText = stringValue(payload['text'])
    const reason = stringValue(payload['reason'])
    if (finalText) {
      state.text = finalText
      upsertPart(state, textPart(state))
    }
    const failed = terminal !== 'completed'
    const error = failed ? (reason ?? finalText ?? 'Muse run failed') : undefined

    if (state.started) {
      const events: SessionAgentEvent[] = []
      if (finalText) {
        events.push({
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: textPart(state)
        })
      }
      // A gated tool can still be stopped before the stream carries its
      // command (the `proposed` record gates immediately). Surface the pending
      // permission at turn end with whatever arguments were captured so the
      // user can still approve or reject instead of the request vanishing.
      for (const tool of state.tools.values()) {
        if (!tool.requiresPermission || state.emittedPermissionTasks.has(tool.taskId)) continue
        const permissionEvent = musePermissionEvent(context, state, {
          approval_id: tool.callId ?? tool.taskId,
          tool_name: tool.tool,
          input: tool.input
        })
        if (permissionEvent) {
          state.emittedPermissionTasks.add(tool.taskId)
          events.push(permissionEvent)
        }
      }
      events.push({
        type: 'message.completed',
        sessionId: context.sessionId,
        messageId: state.messageId,
        ...(error ? { error, issue: museIssue(error) } : {})
      })
      return { ...base, messages: [museMessage(state)], events }
    }
    if (error) {
      return {
        ...base,
        events: [
          { type: 'session.error', sessionId: context.sessionId, error, issue: museIssue(error) }
        ]
      }
    }
    return base
  }

  return base
}

/** Process-per-turn bridge for Muse Code's `muse exec --json`. */
export class MuseDriver extends PersistentCliDriver {
  readonly id = 'muse'
  readonly name = 'Muse Code'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'turn_process', scope: 'session' },
    streaming: true,
    steering: true,
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: false,
    compaction: false,
    subagents: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, MuseTurnState>()
  private continuationOptions = new Map<string, SendPromptOptions>()
  private approvedToolAllowances = new Map<string, number>()
  private hiddenContinuationSessions = new Set<string>()

  constructor(storage: StorageEngine) {
    super(storage)
  }

  protected async ensureCliReady(): Promise<void> {
    const result = await runMuse(['--version'], MUSE_PROBE_TIMEOUT_MS)
    if (!result.succeeded) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error'
      throw new Error(`Muse Code CLI is unavailable: ${detail}`)
    }
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const capabilities = await readMuseCliCapabilities()
    const discovered = await readMuseModelCatalog(capabilities)
    return discovered.length > 0 ? discovered : museFallbackCatalog(capabilities)
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const providers = await this.listProviders()
    const model = providers[0]?.models[0]
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      model ? [{ providerId: model.providerId, modelId: model.id }] : []
    )
  }

  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    const args: string[] = [
      'exec',
      '--json',
      '--no-foreign-personal-context',
      '--no-session-log',
      '--user-input-auto-resolve'
    ]
    if (options.settings.providerId && options.settings.providerId !== 'default') {
      args.push('--provider', options.settings.providerId)
    }
    if (options.settings.modelId && options.settings.modelId !== 'default') {
      args.push('--model', options.settings.modelId)
    }
    const cliCapabilities = await readMuseCliCapabilities()
    const requestedThinkingIndex = THINKING_LEVEL_ORDER.indexOf(options.settings.thinkingLevel)
    const reasoningEffort = cliCapabilities.reasoningEfforts.reduce<ThinkingLevel | undefined>(
      (closest, candidate) => {
        if (!closest) return candidate
        const candidateDistance = Math.abs(
          THINKING_LEVEL_ORDER.indexOf(candidate) - requestedThinkingIndex
        )
        const closestDistance = Math.abs(
          THINKING_LEVEL_ORDER.indexOf(closest) - requestedThinkingIndex
        )
        return candidateDistance <= closestDistance ? candidate : closest
      },
      undefined
    )
    if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort)

    if (options.readOnly) {
      // Inspection chats must not mutate the workspace.
      args.push('--disable-write')
    } else if (options.settings.permissionLevel === 'full_access') {
      // Full Access trusts the workspace and bypasses approval and the sandbox.
      args.push('--yolo')
    } else {
      args.push('--disable-approval')
    }

    const attachmentReferences: string[] = []
    for (const attachment of options.attachments) {
      if (attachment.mime.toLocaleLowerCase().startsWith('image/')) {
        if (!cliCapabilities.attachments) {
          throw new Error('The installed Muse Code CLI does not advertise image attachments')
        }
        const target = await attachmentTarget(attachment)
        if (/^(?:data:|https?:\/\/)/u.test(target)) {
          throw new Error(
            `Muse Code requires a local image file for prompt attachments: ${attachment.filename ?? 'image'}`
          )
        }
        // `muse exec` exposes a repeatable --image input for local image files.
        args.push('--image', target)
      } else {
        attachmentReferences.push(await attachmentReference(attachment))
      }
    }

    const prompt = [
      options.systemPrompt,
      attachmentReferences.join('\n\n'),
      escapeMuseMentions(options.text)
    ]
      .filter(Boolean)
      .join('\n\n')
    args.push(prompt)

    const turnIndex = session.messages.filter((message) => message.role === 'assistant').length + 1
    const turnState: MuseTurnState = {
      turnIndex,
      messageId: `muse:${session.id}:${turnIndex}`,
      createdAt: Date.now(),
      text: '',
      parts: [],
      started: false,
      tools: new Map(),
      toolByCall: new Map(),
      promotedInteractions: new Set(),
      emittedPermissionTasks: new Set(),
      gatedTaskIds: new Set(),
      expectsProcessStop: false
    }
    this.turnStates.set(session.id, turnState)
    this.continuationOptions.set(session.id, {
      ...options,
      settings: { ...options.settings },
      attachments: [...options.attachments]
    })
    return {
      command: 'muse',
      args,
      env: buildProcessEnvironment(),
      onJsonRecord: (value) => {
        if (options.settings.permissionLevel === 'full_access') return
        const envelope = record(value)
        if (envelope?.['payload_type'] !== 'task.lifecycle.proposed') return
        const payload = record(envelope['payload'])
        const event = record(payload?.['event'])
        const taskId = stringValue(payload?.['task_id'])
        const taskKind = museToolName(event?.['task_kind'], 'task_kind')
        if (!taskId || !taskKind || !museToolNeedsPermission(taskKind)) return
        const allowance = this.approvedToolAllowances.get(session.id) ?? 0
        if (allowance > 0) {
          if (allowance === 1) this.approvedToolAllowances.delete(session.id)
          else this.approvedToolAllowances.set(session.id, allowance - 1)
          return
        }
        turnState.gatedTaskIds.add(taskId)
        turnState.expectsProcessStop = true
        this.stopActiveProcess(session.id)
      },
      suppressIdle: () => turnState.promotedInteractions.size > 0,
      isExpectedExit: () => turnState.expectsProcessStop,
      onProcessExit: () => this.approvedToolAllowances.delete(session.id)
    }
  }

  override async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    if (!sessionId) throw new Error(`Muse permission request is no longer pending: ${requestId}`)
    const action =
      reply === 'reject'
        ? message
          ? `The user rejected the requested action and supplied this alternative:\n${message}`
          : 'The user rejected the requested action. Do not execute it. Continue safely without that action, or explain why the task cannot continue.'
        : `The user approved the requested action through CodeInOven (${reply}). Execute only that approved action, then continue. Ask again before any different action that requires approval.`
    if (reply === 'reject') {
      await this.continueInteraction(projectPath, sessionId, action)
      return
    }
    this.approvedToolAllowances.set(sessionId, 1)
    try {
      await this.continueInteraction(projectPath, sessionId, action)
    } catch (error) {
      this.approvedToolAllowances.delete(sessionId)
      throw error
    }
  }

  override async replyToQuestion(
    projectPath: string,
    sessionId: string,
    _requestId: string,
    answers: string[][]
  ): Promise<void> {
    const formatted = answers
      .map((values, index) => `${index + 1}. ${values.join(', ')}`)
      .join('\n')
    await this.continueInteraction(
      projectPath,
      sessionId,
      `The user answered Muse's earlier request_user_input prompt through CodeInOven:\n${formatted}\nContinue from these answers without asking the same question again.`
    )
  }

  override async rejectQuestion(
    projectPath: string,
    sessionId: string,
    _requestId: string
  ): Promise<void> {
    await this.continueInteraction(
      projectPath,
      sessionId,
      "The user dismissed Muse's earlier request_user_input prompt. Continue without that answer, or explain why the task cannot continue."
    )
  }

  private async continueInteraction(
    projectPath: string,
    sessionId: string,
    text: string
  ): Promise<void> {
    const options = this.continuationOptions.get(sessionId)
    if (!options) throw new Error(`Muse interaction session is unavailable: ${sessionId}`)
    const continuationText = [
      'Continue this CodeInOven-managed task without relying on Muse session memory.',
      `Active task context:\n${options.text}`,
      `New interaction result:\n${text}`
    ].join('\n\n')
    this.hiddenContinuationSessions.add(sessionId)
    try {
      // The gated run was stopped (or is paused waiting on an interaction
      // prompt). Await the process settlement so resuming never collides with
      // the still-active turn ("A turn is already active") — same teardown
      // contract steerPrompt relies on.
      await this.settleActiveProcess(sessionId)
      await this.sendPrompt(projectPath, {
        ...options,
        sessionId,
        text: continuationText,
        attachments: [...options.attachments]
      })
    } finally {
      this.hiddenContinuationSessions.delete(sessionId)
    }
  }

  protected override appendUserMessage(
    session: PersistentCliSession,
    options: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
  ): void {
    super.appendUserMessage(session, options)
    if (!this.hiddenContinuationSessions.has(session.id)) return
    const message = session.messages.findLast((candidate) => candidate.role === 'user')
    if (message) message.visibility = 'hidden'
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId)
    if (!state) return null
    return mapMuseRecord(value, context, state)
  }

  dispose(): void {
    this.turnStates.clear()
    this.continuationOptions.clear()
    this.approvedToolAllowances.clear()
    this.hiddenContinuationSessions.clear()
    super.dispose()
  }
}
