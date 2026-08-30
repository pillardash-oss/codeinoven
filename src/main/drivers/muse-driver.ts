import { open, readFile, readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'os'
import { join } from 'path'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentSubagentActivity,
  PermissionReply,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent,
  ThinkingLevel,
  ThinkingPreset
} from '../../lib/types'
import {
  classifyProviderIssue,
  extractProviderErrorEnvelope,
  parseUsageResetAt
} from '../../lib/provider-issue'
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
  PersistentCliSession,
  TitleModelCandidate
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import type {
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions
} from './driver.interface'
import type { StorageEngine } from '../storage/storage-engine'
import { runHarnessCommand } from './harness-runtime'
import { Logger } from '../system/logger'

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
 *   - `run.output.reasoning.delta` / `run.reasoning.delta` / `run.thinking.delta`
 *     → incremental reasoning trace (`payload.text` / `payload.delta` / `payload.reasoning`)
 *   - `run.terminal.completed` → `payload.terminal` (`completed`|`error`),
 *     `payload.text` (final), `payload.reason`
 *   - `run.model.configured` → `payload.provider_id` / `payload.model_id`
 *   - `task.lifecycle.proposed` → tool call announced (`event.task_kind` `tool.*`)
 *   - `task.lifecycle.side_effect_intent` → tool running + provider call id
 *   - `task.lifecycle.output` → tool chunk (bash `{command,description,output}`)
 *   - `*.compaction*` / `runtime.session` `compaction` → harness-native context
 *     compaction checkpoint (auto when soft/hard threshold hit). Mirrored as a
 *     `compaction` part so `formatHistoryRecap` slices from that cut on the
 *     next turn — seamless continuation.
 *   - `tool.result` → authoritative tool completion (`call_id`, `text`)
 * The provider session UUID is intentionally not reused: every turn runs with
 * a fresh `--session-id`, so Muse-native memory/history stays isolated. The
 * live stdout stream carries no reasoning and (in Muse 1.x) no committed tool
 * arguments, so the driver also tails the durable session log
 * (`~/.local/share/muse/sessions/<date>/<run-uuid>/session.jsonl`) during the
 * turn for the reasoning summary trace and tool-detail backfill.
 * There is no per-record token/usage telemetry.
 *
 * Meta's Muse Code launch documentation also demonstrates a local video file
 * being supplied directly in the terminal and interpreted by Muse Code:
 * https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2
 */

const MUSE_PROBE_TIMEOUT_MS = 15_000
/** Provider id under which every Muse-cloud model is catalogued. */
const MUSE_PROVIDER_ID = 'meta'

/** Session-log tail cadence for the current turn's reasoning/tool backfill. */
const MUSE_SESSION_LOG_POLL_MS = 800
/** How long the tailer keeps looking for the log file before giving up. */
const MUSE_SESSION_LOG_FIND_TIMEOUT_MS = 60_000
/** How long after process exit the tailer keeps catching final flushes. */
const MUSE_SESSION_LOG_TAIL_GRACE_MS = 4_000

/** Incremental tail state for one turn's Muse session log. */
interface MuseSessionLogWatcher {
  turnState: MuseTurnState
  session: PersistentCliSession
  projectPath: string
  museSessionId: string
  logPath: string | null
  offset: number
  pending: string
  giveUpAfter: number
  timer: ReturnType<typeof setInterval> | null
  stopTimer: ReturnType<typeof setTimeout> | null
  stopping: boolean
}

/**
 * Locate the durable session log Muse writes for a run:
 * `~/.local/share/muse/sessions/<YYYY>/<MM>/<DD>/<run-uuid>/session.jsonl`.
 * Date directories use the local clock; probe today/yesterday in local and UTC
 * so a run crossing midnight still resolves. Returns null while the log has
 * not appeared yet.
 */
async function findMuseSessionLog(museSessionId: string): Promise<string | null> {
  const root = join(homedir(), '.local', 'share', 'muse', 'sessions')
  const stamps: string[] = []
  for (const base of [new Date(), new Date(Date.now() - 26 * 60 * 60 * 1000)]) {
    stamps.push(
      `${base.getFullYear()}/${String(base.getMonth() + 1).padStart(2, '0')}/${String(
        base.getDate()
      ).padStart(2, '0')}`
    )
    stamps.push(
      `${base.getUTCFullYear()}/${String(base.getUTCMonth() + 1).padStart(2, '0')}/${String(
        base.getUTCDate()
      ).padStart(2, '0')}`
    )
  }
  for (const stamp of [...new Set(stamps)]) {
    const candidate = join(root, stamp, museSessionId, 'session.jsonl')
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      // Not written yet — keep probing until the finder timeout.
    }
  }
  return null
}

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
  const envelope = extractProviderErrorEnvelope(error)
  const kind = classifyProviderIssue(error)
  const retryAt =
    kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(envelope.message) : undefined
  return {
    kind,
    message: envelope.message,
    rawError: error,
    harnessId: 'muse',
    retryable: retryAt !== undefined || kind === 'quota' || kind === 'rate_limit',
    ...(retryAt === undefined ? {} : { retryAt })
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
  error?: string
  title?: string
  /** Muse policy outcome retained until exported arguments make a card useful. */
  policyDecision?: string
  /** CodeInOven stopped this call before execution to request user approval. */
  requiresPermission?: boolean
  start: number
  end?: number
}

/** Turn-scoped state correlating the streamed records of one assistant message. */
export interface MuseTurnState {
  turnIndex: number
  messageId: string
  createdAt: number
  text: string
  reasoning: string
  reasoningSummary?: string
  reasoningTime?: { start?: number; end?: number }
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
  /** Summary text of the most recent compaction, used to dedupe the mirrored
   *  session-log compaction record against the live stdout one. */
  lastCompactionSummary?: string
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

function reasoningPart(state: MuseTurnState): Extract<AgentPart, { type: 'reasoning' }> {
  return {
    type: 'reasoning',
    id: `${state.messageId}:reasoning`,
    messageID: state.messageId,
    text: state.reasoning,
    ...(state.reasoningSummary ? { summary: state.reasoningSummary } : {}),
    ...(state.reasoningTime ? { time: state.reasoningTime } : {})
  }
}

/**
 * Apply one streamed tool-output chunk to the in-flight tool record. For bash
 * the chunk is the JSON `{command, description, output, …}` blob; for
 * write/read tools it is the human-readable result. Fills input/title early so
 * the card is meaningful while still running.
 */
function museApplyChunkFields(tool: MuseToolState, chunk: string): void {
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
}

/**
 * Apply one authoritative tool-result text to the tool record. For shell tools
 * the text is the same JSON `{command, description, output, …}` chunk the
 * output stream carried; prefer its parsed fields so the card shows a real
 * command and the plain tool output instead of one opaque JSON blob.
 */
function museApplyResultText(tool: MuseToolState, text: string): void {
  let resultText = text
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = record(JSON.parse(text) as unknown)
      if (parsed) {
        const command = stringValue(parsed['command'])
        const output = stringValue(parsed['output'])
        const exitCode = numberValue(parsed['exit_code'])
        if (command) tool.input = { command, ...tool.input }
        if (!tool.title && stringValue(parsed['description']))
          tool.title = stringValue(parsed['description'])
        if (output !== undefined && exitCode !== undefined) resultText = output
        else resultText = text
      }
    } catch {
      // Keep the raw text when the payload is not the expected JSON shape.
    }
  }
  tool.output = resultText
}

/** Mark a tool settled and emit its final card event. `null` for tools that
 *  must stay out of the conversation (harness-native questions). */
function museCompleteTool(
  context: CliLineParseContext,
  state: MuseTurnState,
  tool: MuseToolState,
  text: string | undefined,
  failed: boolean
): SessionAgentEvent | null {
  tool.status = failed ? 'error' : 'completed'
  if (text) museApplyResultText(tool, text)
  tool.end = Date.now()
  if (isQuestionToolName(tool.tool)) return null
  if (isMuseSubagentSpawn(tool.tool)) return museSubagentEvent(context, state, tool)
  return museToolEvent(context, state, tool)
}

/**
 * Finalize every in-flight tool card that outlived its run — e.g. the run was
 * stopped for a permission gate or steering while a sibling call was mid-flight,
 * or the turn ended without the call reporting a result. Without this the
 * affected cards spin forever and never show their details.
 */
function museFinalizeInterruptedTools(
  context: CliLineParseContext,
  state: MuseTurnState
): SessionAgentEvent[] {
  const events: SessionAgentEvent[] = []
  for (const tool of state.tools.values()) {
    if (tool.status !== 'pending' && tool.status !== 'running') continue
    if (state.gatedTaskIds.has(tool.taskId) || tool.requiresPermission) continue
    tool.error = 'Interrupted — the Muse run stopped before this call reported a result.'
    const event = museCompleteTool(context, state, tool, undefined, true)
    if (event) events.push(event)
  }
  return events
}

/** Build a `tool` part from an in-flight Muse tool-call record. */
function museToolPart(state: MuseTurnState, tool: MuseToolState): AgentPart {
  return {
    type: 'tool',
    // The Muse CLI restarts its task-id counter on every `muse exec` run, so
    // `task_id` alone collides across turns and every tool card in the thread
    // folds into one. Anchor the part id to the per-turn message id instead.
    id: `${state.messageId}:tool-${tool.taskId}`,
    messageID: state.messageId,
    callID: tool.callId ?? `muse-task-${tool.taskId}`,
    tool: tool.tool,
    state: {
      status: tool.status,
      input: tool.input,
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.output ? { output: tool.output } : {}),
      ...(tool.error ? { error: tool.error } : {}),
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

function museCompactionResult(
  context: CliLineParseContext,
  state: MuseTurnState,
  summary: string | undefined,
  auto: boolean,
  overflow?: boolean
): CliLineParseResult {
  const fallbackSummary =
    summary ??
    'Automatic context compaction by Muse — older history summarized per summary-preserved-suffix/v1; next turn continues seamlessly from this checkpoint with preserved suffix.'
  // Muse mirrors the same compaction checkpoint into both the headless stdout
  // and its durable session log with unrelated record ids. One CodeInOven
  // checkpoint per actual compaction — skip an identical repeat.
  if (state.lastCompactionSummary === fallbackSummary) {
    return {}
  }
  state.lastCompactionSummary = fallbackSummary
  const messageId = `muse-compaction-${context.sessionId}-${Date.now()}`
  const part: Extract<AgentPart, { type: 'compaction' }> = {
    type: 'compaction',
    id: `${messageId}:compaction`,
    messageID: messageId,
    auto,
    summary: fallbackSummary,
    ...(overflow ? { overflow: true } : {})
  }
  return {
    messages: [
      {
        id: messageId,
        role: 'assistant',
        origin: 'compaction',
        visibility: 'working_trace',
        parts: [part],
        createdAt: Date.now(),
        completedAt: Date.now(),
        harnessId: 'muse'
      }
    ],
    events: [
      { type: 'message.part.updated', sessionId: context.sessionId, part },
      { type: 'message.completed', sessionId: context.sessionId, messageId, compaction: true }
    ]
  }
}

function isMuseSubagentSpawn(name: string): boolean {
  return normalizeInteractionName(name) === 'subagent_spawn' || name === 'subagent_spawn'
}

function normalizeMuseWorktreeIsolation(input: unknown): void {
  if (
    input &&
    typeof input === 'object' &&
    'worktree_isolation' in (input as Record<string, unknown>)
  ) {
    ;(input as Record<string, unknown>).worktree_isolation = false
  }
}
function museSubagentPart /* worktree_isolation normalized to false */(
  state: MuseTurnState,
  tool: MuseToolState
): AgentPart {
  // Force shared worktree — CodeInOven owns worktree lifecycle, never isolated
  normalizeMuseWorktreeIsolation((tool as unknown as { input?: unknown }).input)
  const input = tool.input ?? {}
  const agent =
    stringValue(input['role']) ??
    stringValue(input['subagent_type']) ??
    stringValue(input['agent']) ??
    tool.tool
  const description =
    stringValue(input['objective']) ??
    stringValue(input['description']) ??
    stringValue(input['task_name']) ??
    stringValue(input['prompt']) ??
    agent
  const prompt =
    stringValue(input['objective']) ??
    stringValue(input['prompt']) ??
    stringValue(input['description'])
  const childSessionId =
    stringValue(input['subagent_id']) ??
    stringValue(input['childSessionId']) ??
    tool.callId ??
    tool.taskId
  const providerTaskId = tool.callId ?? tool.taskId
  const background = input['background'] === true
  const status = tool.status as AgentSubagentActivity['status']
  const output = tool.output
  const error = status === 'error' ? (output ?? 'Sub-agent task failed') : undefined
  return {
    type: 'subagent',
    id: `muse-subagent-${tool.taskId}`,
    messageID: state.messageId,
    callID: tool.callId ?? tool.taskId,
    activity: {
      status,
      agent,
      description,
      ...(prompt ? { prompt } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      ...(providerTaskId ? { providerTaskId } : {}),
      background,
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
      time: { start: tool.start, ...(tool.end ? { end: tool.end } : {}) }
    }
  }
}

function museSubagentEvent(
  context: CliLineParseContext,
  state: MuseTurnState,
  tool: MuseToolState
) {
  const part = museSubagentPart(state, tool)
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
 * payloads are `run.output.delta` (streaming text), reasoning deltas
 * (`run.output.reasoning.delta` / `run.reasoning.delta` / `run.thinking.delta`),
 * `run.terminal.completed` (turn end), and `run.model.configured` (provenance).
 * The top-level session stream ids are observed only as event metadata and are
 * never reused for native conversation history.
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

    // Reasoning trace — Muse 1.x does not stream reasoning on the headless
    // stdout at all; the plaintext reasoning summary (and, for providers that
    // expose it, the raw reasoning delta) is only persisted to the durable
    // session log. The driver tails that log during the turn and replays these
    // records through this branch so the ThinkingBlock renders live content.
    if (
      kind === 'reasoning_summary_delta' ||
      kind === 'reasoning_summary_committed' ||
      kind === 'reasoning_delta' ||
      kind === 'reasoning_committed'
    ) {
      const delta = stringValue(exportedEvent['text']) ?? stringValue(exportedEvent['delta'])
      if (!delta) return base
      if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
      if (kind === 'reasoning_summary_delta') {
        state.reasoningSummary = (state.reasoningSummary ?? '') + delta
      } else if (kind === 'reasoning_summary_committed') {
        // Committed text is authoritative for its block; later deltas belong
        // to the next summary block, so replace rather than append.
        state.reasoningSummary = delta
      } else if (kind === 'reasoning_delta') {
        state.reasoning += delta
      } else if (delta.length > state.reasoning.length) {
        state.reasoning = delta
        state.reasoningTime = { ...state.reasoningTime, end: Date.now() }
      }
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }

    // Session-log mirror of `task.lifecycle.output` — same chunk shape, so
    // backfill the tool card when the live stream missed the chunk (e.g. the
    // run was stopped for a permission gate right after the call started).
    if (kind === 'output') {
      const outTaskId = stringValue(exportedEvent['task_id'])
      const chunk = stringValue(exportedEvent['chunk'])
      const tool = outTaskId ? state.tools.get(outTaskId) : undefined
      if (!tool || !chunk) return base
      museApplyChunkFields(tool, chunk)
      if (isQuestionToolName(tool.tool)) return base
      if (isMuseSubagentSpawn(tool.tool)) {
        return { ...base, events: [museSubagentEvent(context, state, tool)] }
      }
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }

    // Session-log mirror of `tool.result` batches — authoritative completion
    // backfill for tool cards whose stdout result never arrived.
    if (kind === 'tool_result_batch_committed') {
      const results = Array.isArray(exportedEvent['results']) ? exportedEvent['results'] : []
      const events: SessionAgentEvent[] = []
      for (const rawResult of results) {
        const resultRow = record(rawResult)
        const callId = stringValue(resultRow?.['tool_call_id'])
        const text = stringValue(resultRow?.['text'])
        if (!callId) continue
        const settledTaskId = state.toolByCall.get(callId)
        const tool = settledTaskId ? state.tools.get(settledTaskId) : undefined
        if (!tool || tool.status === 'completed' || tool.status === 'error') continue
        const settled = museCompleteTool(context, state, tool, text, false)
        if (settled) events.push(settled)
      }
      return events.length > 0 ? { ...base, events } : base
    }

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
        if (input) {
          normalizeMuseWorktreeIsolation(input)
          tool.input = input
        }
        tool.callId = callId
        state.toolByCall.set(callId, tool.taskId)
        if (isMuseSubagentSpawn(tool.tool)) {
          events.push(museSubagentEvent(context, state, tool))
        } else {
          events.push(museToolEvent(context, state, tool))
        }
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
    if (kind && kind.toLowerCase().includes('compaction')) {
      const summary = firstString(
        stringValue(exportedEvent['summary']),
        stringValue(exportedEvent['text']),
        stringValue(exportedEvent['compact_summary']),
        stringValue(exportedEvent['summary_text']),
        stringValue(payload['summary']),
        stringValue(payload['text'])
      )
      const trigger = stringValue(exportedEvent['trigger']) ?? stringValue(exportedEvent['kind'])
      const auto = trigger ? trigger !== 'manual' : true
      const overflow = trigger === 'auto'
      return {
        ...base,
        ...museCompactionResult(context, state, summary, auto, overflow || undefined)
      }
    }
    return base
  }

  // Harness-native context compaction — emitted by Muse when the soft/hard
  // threshold fires (summary-preserved-suffix/v1). Mirror it as a CodeInOven
  // compaction checkpoint so the next turn's history recap slices from that cut
  // and continues seamlessly instead of replaying the full pre-compaction
  // transcript.
  if (payloadType && payloadType.toLowerCase().includes('compaction')) {
    const eventRec = record(payload['event'])
    const summary = firstString(
      stringValue(payload['summary']),
      stringValue(payload['text']),
      stringValue(payload['compact_summary']),
      stringValue(payload['summary_text']),
      stringValue(eventRec?.['summary']),
      stringValue(eventRec?.['text']),
      stringValue(eventRec?.['compact_summary']),
      stringValue(eventRec?.['summary_text'])
    )
    const trigger =
      stringValue(payload['trigger']) ??
      stringValue(eventRec?.['trigger']) ??
      stringValue(eventRec?.['kind'])
    const auto = trigger ? trigger !== 'manual' : true
    const overflow = trigger === 'auto' || payloadType.toLowerCase().includes('overflow')
    return {
      ...base,
      ...museCompactionResult(context, state, summary, auto, overflow || undefined)
    }
  }

  // Tool call proposed — announce a pending tool card in the working trace.
  // Muse sub-agents (`subagent_spawn`) are rendered as `type:'subagent'` so CodeInOven shows proper cards.
  // Normalize worktree_isolation to false (shared) — CodeInOven owns worktree lifecycle.
  // (normalization also done in museSubagentPart)
  // WorkingTrace shows SubagentCard + the header chip/sheet instead of a flat
  // generic tool card.
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
      // CodeInOven owns worktree lifecycle — force shared worktree for any subagent spawn.
      normalizeMuseWorktreeIsolation(tool.input)
      if (isMuseSubagentSpawn(taskKind)) {
        return { ...base, events: [museSubagentEvent(context, state, tool)] }
      }
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
    if (isMuseSubagentSpawn(tool.tool)) {
      return {
        ...base,
        events: [museSubagentEvent(context, state, tool), ...sideEffectEvents]
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
    museApplyChunkFields(tool, chunk)
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
    if (isMuseSubagentSpawn(tool.tool)) {
      return {
        ...base,
        events: [museSubagentEvent(context, state, tool), ...outputEvents]
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
    if (text) museApplyResultText(tool, text)
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
    if (isMuseSubagentSpawn(tool.tool)) {
      return { ...base, events: [museSubagentEvent(context, state, tool)] }
    }
    return { ...base, events: [museToolEvent(context, state, tool)] }
  }

  // Tool lifecycle completion — Muse 1.x never re-emits the committed tool
  // call and `tool.result` is absent for non-shell tools, so without this
  // handler completed tool cards would stay `running` forever with an empty
  // input. Flip the matching task to `completed` when its lifecycle closes.
  if (payloadType === 'task.lifecycle.completed') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool || tool.status === 'completed' || tool.status === 'error') return base
    tool.status = 'completed'
    tool.end = Date.now()
    if (isQuestionToolName(tool.tool)) return base
    if (isMuseSubagentSpawn(tool.tool))
      return { ...base, events: [museSubagentEvent(context, state, tool)] }
    return { ...base, events: [museToolEvent(context, state, tool)] }
  }

  // Tool task closed without executing — Muse policy rejected the call (or the
  // run cancelled/timed it out). Without this the card stays pending forever.
  if (
    payloadType === 'task.lifecycle.rejected' ||
    payloadType === 'task.lifecycle.cancelled' ||
    payloadType === 'task.lifecycle.failed'
  ) {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool || tool.status === 'completed' || tool.status === 'error') return base
    const event = record(payload['event'])
    const detail =
      stringValue(event?.['reason']) ??
      stringValue(event?.['detail']) ??
      stringValue(event?.['message'])
    const label = payloadType.endsWith('rejected')
      ? 'Rejected by Muse policy'
      : payloadType.endsWith('cancelled')
        ? 'Cancelled by Muse'
        : 'Failed in Muse'
    tool.error = detail ? `${label}: ${detail}` : label
    const settled = museCompleteTool(context, state, tool, undefined, true)
    return settled ? { ...base, events: [settled] } : base
  }

  // Muse Spark always reasons; ensure the working trace shows a ThinkingBlock
  // immediately when the run starts so the user sees "Thinking …" even though
  // the CLI inlines reasoning into `run.output.delta` text rather than a
  // separate reasoning delta channel. The block stays active until the terminal
  // record closes it.
  if (payloadType === 'run.lifecycle.started') {
    if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
    // Emit an initial empty reasoning part so WorkingTrace renders ThinkingBlock
    // during the busy phase. Subsequent reasoning deltas (if any) append to it.
    if (!state.parts.some((p) => p.type === 'reasoning')) {
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
  }

  // Streaming reasoning trace — Muse Spark reasoning effort produces
  // provider-side thinking that the CLI surfaces as a separate delta channel.
  // The current CLI (0.2.1) inlines reasoning into `run.output.delta` text for
  // most turns, but any future `*reasoning*` / `*thinking*` payload is captured
  // here so the working trace renders a distinct `ThinkingBlock` instead of
  // silently dropping the trace. Also handles generic payloads that carry
  // `reasoning`/`thinking` keys regardless of payload_type.
  if (
    payloadType === 'run.output.reasoning.delta' ||
    payloadType === 'run.reasoning.delta' ||
    payloadType === 'run.thinking.delta' ||
    payloadType === 'run.output.thinking.delta' ||
    (payloadType !== undefined &&
      (payloadType.includes('reasoning') || payloadType.includes('thinking')))
  ) {
    const delta =
      stringValue(payload['text']) ??
      stringValue(payload['delta']) ??
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['content']) ??
      stringValue(record(payload['event'])?.['delta']) ??
      stringValue(record(payload['event'])?.['thinking'])
    const summary =
      stringValue(payload['summary']) ?? stringValue(record(payload['event'])?.['summary'])
    if (summary) state.reasoningSummary = summary
    if (delta) {
      if (!state.reasoningTime?.start) {
        state.reasoningTime = { start: Date.now(), ...state.reasoningTime }
      }
      state.reasoning += delta
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
    if (summary) {
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
    return base
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

  // Generic reasoning payload — captures any envelope that carries reasoning/
  // thinking content even when payload_type does not contain those words.
  {
    const genericDelta =
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['reasoning_text']) ??
      stringValue(payload['reasoning_content']) ??
      stringValue(record(payload['event'])?.['reasoning']) ??
      stringValue(record(payload['event'])?.['thinking'])
    const genericSummary =
      stringValue(payload['reasoning_summary']) ?? stringValue(payload['summary'])
    if (
      genericDelta &&
      payloadType !== 'run.output.delta' &&
      payloadType !== 'run.terminal.completed' &&
      payloadType !== 'run.lifecycle.started'
    ) {
      if (!state.reasoningTime?.start) state.reasoningTime = { start: Date.now() }
      state.reasoning += genericDelta
      if (genericSummary) state.reasoningSummary = genericSummary
      const part = reasoningPart(state)
      upsertPart(state, part)
      return {
        ...base,
        messages: [museMessage(state)],
        events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
      }
    }
  }

  // Turn end — `payload.terminal` is `completed` on success, anything else is an
  // error. `payload.text` is the authoritative final text.
  if (payloadType === 'run.terminal.completed') {
    const terminal = stringValue(payload['terminal'])
    const finalText = stringValue(payload['text'])
    const reason = stringValue(payload['reason'])
    const finalReasoning =
      stringValue(payload['reasoning']) ??
      stringValue(payload['thinking']) ??
      stringValue(payload['reasoning_text'])
    const finalReasoningSummary =
      stringValue(payload['reasoning_summary']) ?? stringValue(payload['summary'])
    if (finalReasoningSummary) state.reasoningSummary = finalReasoningSummary
    if (finalReasoning && finalReasoning.length > state.reasoning.length) {
      state.reasoning = finalReasoning
      state.reasoningTime = { ...(state.reasoningTime ?? {}), end: Date.now() }
      upsertPart(state, reasoningPart(state))
    } else if ((state.reasoning || state.reasoningTime?.start) && !state.reasoningTime?.end) {
      state.reasoningTime = { ...(state.reasoningTime ?? {}), end: Date.now() }
      upsertPart(state, reasoningPart(state))
    }
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
      // Close out tool cards that outlived the run (no result reported) so
      // they never spin forever with empty details.
      events.push(...museFinalizeInterruptedTools(context, state))
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
    compaction: true,
    subagents: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, MuseTurnState>()
  private continuationOptions = new Map<string, SendPromptOptions>()
  private approvedToolAllowances = new Map<string, number>()
  private hiddenContinuationSessions = new Set<string>()
  private sessionLogWatchers = new Map<string, MuseSessionLogWatcher>()
  /**
   * Steers received while a tool call is mid-flight (e.g. a running shell
   * command). Muse's `exec` process cannot accept live input, so a steer
   * always restarts the turn — but restarting immediately would kill the
   * tool call itself. Queue it here and deliver once `onJsonRecord` observes
   * the tool call settle (`tool.result`), or the process exits for any other
   * reason. The user's message is already visible in the transcript via
   * chat-engine's optimistic persist, so this only delays transport, not
   * display.
   */
  private pendingSteers = new Map<string, { projectPath: string; options: SteerPromptOptions }[]>()

  constructor(storage: StorageEngine) {
    super(storage)
  }

  /**
   * Incrementally tail the Muse session log for the active turn. Muse 1.x
   * headless stdout never carries the reasoning summary or committed tool-call
   * arguments; they are only written to the durable session log
   * (`~/.local/share/muse/sessions/<date>/<run-uuid>/session.jsonl`) while the
   * run is in flight. The tailer replays new records through the standard
   * record mapper so the working trace renders live thinking and complete tool
   * details, and backfills tool cards when the live stream missed a record.
   */
  private startSessionLogWatcher(
    sessionId: string,
    turnState: MuseTurnState,
    session: PersistentCliSession,
    projectPath: string,
    museSessionId: string
  ): void {
    this.stopSessionLogWatcher(sessionId)
    const watcher: MuseSessionLogWatcher = {
      turnState,
      session,
      projectPath,
      museSessionId,
      logPath: null,
      offset: 0,
      pending: '',
      giveUpAfter: Date.now() + MUSE_SESSION_LOG_FIND_TIMEOUT_MS,
      timer: null,
      stopTimer: null,
      stopping: false
    }
    watcher.timer = setInterval(() => {
      void this.pollSessionLog(sessionId, watcher)
    }, MUSE_SESSION_LOG_POLL_MS)
    this.sessionLogWatchers.set(sessionId, watcher)
  }

  private stopSessionLogWatcher(sessionId: string): void {
    const watcher = this.sessionLogWatchers.get(sessionId)
    if (!watcher) return
    if (watcher.timer) clearInterval(watcher.timer)
    if (watcher.stopTimer) clearTimeout(watcher.stopTimer)
    this.sessionLogWatchers.delete(sessionId)
  }

  /** Keep tailing briefly after process exit to catch Muse's final flushes. */
  private scheduleSessionLogWatcherStop(sessionId: string): void {
    const watcher = this.sessionLogWatchers.get(sessionId)
    if (!watcher || watcher.stopTimer) return
    watcher.stopping = true
    watcher.stopTimer = setTimeout(() => {
      this.stopSessionLogWatcher(sessionId)
    }, MUSE_SESSION_LOG_TAIL_GRACE_MS)
  }

  private async pollSessionLog(sessionId: string, watcher: MuseSessionLogWatcher): Promise<void> {
    if (this.turnStates.get(sessionId) !== watcher.turnState) {
      this.stopSessionLogWatcher(sessionId)
      return
    }
    try {
      if (!watcher.logPath) {
        if (Date.now() > watcher.giveUpAfter) {
          this.stopSessionLogWatcher(sessionId)
          return
        }
        watcher.logPath = await findMuseSessionLog(watcher.museSessionId)
        if (!watcher.logPath) return
      }
      const handle = await open(watcher.logPath, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size <= watcher.offset) return
        const buffer = Buffer.alloc(stat.size - watcher.offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, watcher.offset)
        watcher.offset += bytesRead
        watcher.pending += buffer.toString('utf8')
      } finally {
        await handle.close()
      }
      const lines = watcher.pending.split(/\r?\n/u)
      watcher.pending = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let value: unknown
        try {
          value = JSON.parse(trimmed) as unknown
        } catch {
          continue
        }
        // The session log replays records through the same mapper; the
        // runtime.session handlers backfill reasoning and tool details while
        // everything else is ignored, so replay is safe.
        const result = this.parseJsonLine(value, {
          session: watcher.session,
          sessionId,
          projectPath: watcher.projectPath
        })
        if (result) this.applyParseResult(result, watcher.session)
      }
    } catch {
      // The log appears after the run starts and may rotate; retry silently
      // until the watcher gives up. Failures here must never break the turn.
    }
  }

  dispose(): void {
    for (const sessionId of [...this.sessionLogWatchers.keys()]) {
      this.stopSessionLogWatcher(sessionId)
    }
    this.turnStates.clear()
    this.continuationOptions.clear()
    this.approvedToolAllowances.clear()
    this.hiddenContinuationSessions.clear()
    super.dispose()
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

  /** First available catalog model, shared by title and grading runs. */
  private async cheapestCandidate(): Promise<TitleModelCandidate[]> {
    const providers = await this.listProviders()
    const model = providers[0]?.models[0]
    return model ? [{ providerId: model.providerId, modelId: model.id }] : []
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(projectPath, options, await this.cheapestCandidate())
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.gradeTurnWithCandidates(projectPath, options, await this.cheapestCandidate())
  }

  /** Cheapest candidates for any auxiliary one-shot run. */
  protected override async cheapCandidateModels(): Promise<TitleModelCandidate[]> {
    return this.cheapestCandidate()
  }

  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    // A fresh Muse session UUID per turn keeps Muse-native memory and history
    // isolated (CodeInOven supplies its own recap) while still enabling the
    // durable session log — the only place Muse 1.x persists the reasoning
    // summary trace and committed tool-call details for headless runs.
    const museSessionId = randomUUID()
    const args: string[] = [
      'exec',
      '--json',
      '--no-foreign-personal-context',
      '--session-id',
      museSessionId,
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

    // Native automatic compaction keeps the provider context window bounded
    // even for this stateless harness (mirrored history + recap).
    args.push(
      '--context-compaction-strategy',
      'summary-preserved-suffix/v1',
      '--context-compaction-soft-threshold',
      '0.8',
      '--context-compaction-hard-threshold',
      '0.95'
    )

    // Subagents share the CodeInOven-managed worktree/scope. Do not
    // pass `--subagent-worktree-isolation` — CodeInOven owns the Git
    // worktree lifecycle (`ScopeWorktreeService`); harness-owned worktrees
    // are intentionally disabled. `subagent_spawn` without `worktree_isolation:true` stays shared;
    // any affirmative `worktree_isolation:true` is normalized to `false` (shared) before execution.
    // `worktree_isolation:false` stays shared by default.

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
      reasoning: '',
      reasoningTime: { start: Date.now() },
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
    // Muse 1.x never streams the reasoning summary or committed tool-call
    // arguments on headless stdout — they are only persisted to the durable
    // session log. Tail that log for the duration of the turn so the working
    // trace shows live thinking and complete tool details.
    this.startSessionLogWatcher(session.id, turnState, session, _projectPath, museSessionId)
    return {
      command: 'muse',
      args,
      env: buildProcessEnvironment(),
      onJsonRecord: (value) => {
        const envelope = record(value)
        const payloadType = envelope?.['payload_type']
        const payload = record(envelope?.['payload'])

        if (
          options.settings.permissionLevel !== 'full_access' &&
          payloadType === 'task.lifecycle.proposed'
        ) {
          const event = record(payload?.['event'])
          const taskId = stringValue(payload?.['task_id'])
          const taskKind = museToolName(event?.['task_kind'], 'task_kind')
          if (
            taskId &&
            taskKind &&
            !isMuseSubagentSpawn(taskKind) &&
            museToolNeedsPermission(taskKind)
          ) {
            const allowance = this.approvedToolAllowances.get(session.id) ?? 0
            if (allowance > 0) {
              if (allowance === 1) this.approvedToolAllowances.delete(session.id)
              else this.approvedToolAllowances.set(session.id, allowance - 1)
            } else {
              turnState.gatedTaskIds.add(taskId)
              turnState.expectsProcessStop = true
              this.stopActiveProcess(session.id)
              return
            }
          }
        }

        // A tool call just settled (its authoritative completion signal) — if a
        // steer is queued and no other tool call is still in flight, this is
        // the safe boundary to deliver it at.
        if (payloadType === 'tool.result') {
          const callId = stringValue(payload?.['call_id'])
          const settlingTaskId = callId ? turnState.toolByCall.get(callId) : undefined
          const stillActive = [...turnState.tools.entries()].some(
            ([taskId, tool]) =>
              taskId !== settlingTaskId &&
              !turnState.gatedTaskIds.has(taskId) &&
              (tool.status === 'pending' || tool.status === 'running')
          )
          if (!stillActive) this.deliverPendingSteers(session.id)
        }
      },
      suppressIdle: () => turnState.promotedInteractions.size > 0,
      isExpectedExit: () => turnState.expectsProcessStop,
      onProcessExit: () => {
        this.approvedToolAllowances.delete(session.id)
        // Finalize tool cards that outlived the process (killed for a
        // permission gate or steering while a sibling call was mid-flight) so
        // they never spin forever with empty details.
        const finalizeEvents = museFinalizeInterruptedTools(
          { session, sessionId: session.id, projectPath: _projectPath },
          turnState
        )
        if (finalizeEvents.length > 0) {
          this.applyParseResult({ events: finalizeEvents }, session)
        }
        // Stop the session-log tailer after a short grace so the final records
        // Muse flushes at exit (reasoning summary commit, result batch) are
        // still captured.
        this.scheduleSessionLogWatcherStop(session.id)
        // Fallback for turns that never produced a tool-call boundary (a
        // plain-text reply, or the process exiting before one settled) — a
        // steer queued against this turn would otherwise never be delivered.
        this.deliverPendingSteers(session.id)
      }
    }
  }

  override async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const turnState = this.turnStates.get(options.sessionId)
    const hasActiveTool = turnState
      ? [...turnState.tools.values()].some(
          (tool) =>
            !turnState.gatedTaskIds.has(tool.taskId) &&
            (tool.status === 'pending' || tool.status === 'running')
        )
      : false
    if (turnState) turnState.expectsProcessStop = true
    if (!hasActiveTool) {
      await super.steerPrompt(projectPath, options)
      return
    }
    const queue = this.pendingSteers.get(options.sessionId) ?? []
    queue.push({ projectPath, options })
    this.pendingSteers.set(options.sessionId, queue)
  }

  /** Deliver every steer queued for a session as one merged, deferred steer. */
  private deliverPendingSteers(sessionId: string): void {
    const queue = this.pendingSteers.get(sessionId)
    if (!queue || queue.length === 0) return
    this.pendingSteers.delete(sessionId)
    // Delivering the queued steer requires SIGTERM-ing the still-running turn
    // process (exit code 143 + Muse's shutdown banner on stderr). Mark the stop
    // as deliberate so `isExpectedExit` suppresses the bogus crash error and
    // steering stays seamless like native-streaming harnesses.
    const turnState = this.turnStates.get(sessionId)
    if (turnState) turnState.expectsProcessStop = true
    const last = queue[queue.length - 1]
    const merged: SteerPromptOptions = {
      ...last.options,
      text: queue.map((entry) => entry.options.text).join('\n\n'),
      attachments: queue.flatMap((entry) => entry.options.attachments)
    }
    super.steerPrompt(last.projectPath, merged).catch((error: unknown) => {
      Logger.error(`Muse deferred steer failed for session ${sessionId}:`, error)
    })
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

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: import('../../lib/types').ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    if (session.messages.length === 0) {
      throw new Error('No messages to compact for this thread')
    }
    const messageId = `${sessionId}:compaction:${Date.now()}`
    const partId = `${messageId}:compaction`
    const summary = this.buildLocalCompactionSummary(session.messages)
    const compactionPart: Extract<AgentPart, { type: 'compaction' }> = {
      type: 'compaction',
      id: partId,
      messageID: messageId,
      auto: false,
      summary
    }
    session.messages.push({
      id: messageId,
      role: 'assistant',
      parts: [compactionPart],
      createdAt: Date.now(),
      harnessId: this.id
    })

    this.emit({ type: 'session.status', sessionId, status: { state: 'working' } })
    this.applyEventToSession(session, {
      type: 'message.part.updated',
      sessionId,
      part: compactionPart
    })
    this.emit({ type: 'message.part.updated', sessionId, part: compactionPart })
    await this.persistSession(session)

    this.applyEventToSession(session, {
      type: 'message.completed',
      sessionId,
      messageId,
      compaction: true
    })
    this.emit({ type: 'message.completed', sessionId, messageId, compaction: true })
    this.emit({ type: 'session.idle', sessionId })
    await this.persistSession(session)
  }

  private buildLocalCompactionSummary(messages: AgentMessage[]): string {
    const transcript = messages
      .map((message) => {
        const text = message.parts
          .flatMap((part) => {
            if (part.type === 'text') return [part.text]
            if (
              part.type === 'compaction' &&
              typeof part.summary === 'string' &&
              part.summary.trim()
            )
              return [`[Prior compaction] ${part.summary.trim()}`]
            if (part.type === 'compaction-summary' && typeof part.text === 'string')
              return [`[Prior compaction] ${part.text.trim()}`]
            return []
          })
          .join('\n')
          .trim()
        if (!text) return ''
        const role = message.role === 'user' ? 'USER' : 'ASSISTANT'
        return `${role}: ${text}`
      })
      .filter(Boolean)
      .join('\n\n')
    const maxChars = 12_000
    const truncated = transcript.length > maxChars ? transcript.slice(-maxChars) : transcript
    const header = `Manual compaction of ${messages.length} messages. Older context summarized below; the next turn replays only this summary plus suffix per summary-preserved-suffix/v1.`
    return truncated ? `${header}\n\n${truncated}` : header
  }
}
