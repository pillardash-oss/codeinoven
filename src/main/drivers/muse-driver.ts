import { spawn } from 'child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent
} from '../../lib/types'
import { attachmentReference, attachmentTarget } from './attachment-reference'
import { buildHarnessEnvironment } from './cli-environment'
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

/**
 * Muse Code (Meta) headless integration notes.
 *
 * Muse is a terminal-only coding agent whose programmatic surface is
 * `muse exec --json` — a one-shot, headless run that streams newline-delimited
 * JSON on stdout and exits when the turn is done. A prior session is resumed
 * with `--session-id <uuid>`.
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
 * The run/session id shared by every record is `payload.run_stream.id`
 * (== `payload.command_id`). Despite the `--session-id` flag, separate `exec`
 * invocations do NOT resume prior context (each run is a fresh session whose id
 * is never surfaced in the JSONL), so multi-turn context is replayed into the
 * prompt instead of relying on native resume.
 * There is no per-record token/usage telemetry.
 *
 * Meta's Muse Code launch documentation also demonstrates a local video file
 * being supplied directly in the terminal and interpreted by Muse Code:
 * https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2
 */

const MUSE_PROBE_TIMEOUT_MS = 15_000

/** Provider id under which every Muse-cloud model is catalogued. */
const MUSE_PROVIDER_ID = 'meta'

/**
 * Static fallback catalog for the Meta provider. Muse exposes no documented
 * model-list subcommand, so use the CLI's documented default selection rather
 * than fabricating an account-tier model id. A successful run can replace this
 * placeholder with the account's local model catalog.
 */
const MUSE_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: MUSE_PROVIDER_ID,
    name: 'Meta',
    harnessId: 'muse',
    models: [
      {
        id: 'default',
        providerId: MUSE_PROVIDER_ID,
        name: 'Muse Spark 1.2',
        reasoning: false,
        attachment: true,
        toolcall: true
      }
    ]
  }
]

/**
 * Muse caches the provider's model catalog locally at
 * `~/.local/share/muse/model-catalog/*.json`, keyed by provider/profile. Read it
 * so the picker reflects the account's real models (id, display label, context
 * limit) instead of the static fallback. Returns the static fallback when the
 * cache is missing or unreadable (e.g. before the first logged-in run).
 */
async function readMuseModelCatalog(): Promise<ProviderCatalog[]> {
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
        model: {
          id: modelId,
          providerId,
          name: stringValue(row['display_label']) ?? modelId,
          reasoning: false,
          attachment: true,
          toolcall: true,
          ...(contextLimit === undefined ? {} : { contextWindow: contextLimit })
        },
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
function runMuse(
  args: string[],
  timeoutMs: number
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('muse', args, {
      env: buildHarnessEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ succeeded: false, stdout, stderr })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ succeeded: false, stdout, stderr: error.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ succeeded: code === 0, stdout, stderr })
    })
  })
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
 * (turn end), and `run.model.configured` (provenance). The run id carried by
 * every record (`payload.run_stream.id` / `payload.command_id`) is surfaced as
 * the native session id so the next turn can resume via `--session-id`.
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

  const runStream = record(payload['run_stream'])
  const nativeSessionId = stringValue(runStream?.['id']) ?? stringValue(payload['command_id'])
  const base: CliLineParseResult = nativeSessionId ? { nativeSessionId } : {}

  const payloadType = stringValue(entry['payload_type'])
  const taskId = stringValue(payload['task_id'])

  // Tool call proposed — announce a pending tool card in the working trace.
  if (payloadType === 'task.lifecycle.proposed') {
    const event = record(payload['event'])
    const taskKind = museToolName(event?.['task_kind'], 'task_kind')
    if (taskId && taskKind) {
      const tool: MuseToolState = {
        taskId,
        tool: taskKind,
        status: 'pending',
        input: {},
        start: Date.now()
      }
      state.tools.set(taskId, tool)
      return { ...base, events: [museToolEvent(context, state, tool)] }
    }
    return base
  }

  // Tool call accepted for execution — flip to running and record the provider
  // call id (also the key used later by `tool.result`).
  if (payloadType === 'task.lifecycle.side_effect_intent') {
    const tool = taskId ? state.tools.get(taskId) : undefined
    if (!tool) return base
    const event = record(payload['event'])
    const idempotencyKey = stringValue(event?.['idempotency_key'])
    const foundCallId = idempotencyKey?.split(':').find((segment) => segment.startsWith('call_'))
    if (foundCallId && taskId) {
      tool.callId = foundCallId
      state.toolByCall.set(foundCallId, taskId)
    }
    tool.status = 'running'
    return { ...base, events: [museToolEvent(context, state, tool)] }
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
    return { ...base, events: [museToolEvent(context, state, tool)] }
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
    steering: false,
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

  private turnStates = new Map<string, MuseTurnState>()

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
    const discovered = await readMuseModelCatalog()
    return discovered.length > 0 ? discovered : MUSE_FALLBACK_CATALOG
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const model = MUSE_FALLBACK_CATALOG[0]?.models[0]
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
    const args: string[] = ['exec', '--json']
    if (session.nativeSessionId) args.push('--session-id', session.nativeSessionId)
    if (options.settings.providerId && options.settings.providerId !== 'default') {
      args.push('--provider', options.settings.providerId)
    }
    if (options.settings.modelId && options.settings.modelId !== 'default') {
      args.push('--model', options.settings.modelId)
    }

    if (options.readOnly) {
      // Inspection chats must not mutate the workspace.
      args.push('--disable-write')
    } else if (options.settings.permissionLevel === 'full_access') {
      // Full Access trusts the workspace and bypasses approval and the sandbox.
      args.push('--yolo')
    } else {
      // Auto Review runs the turn autonomously inside Muse's OS sandbox,
      // disabling approval prompts so headless exec is not left waiting on a
      // card nobody can see. Full Access (above) additionally drops the sandbox.
      args.push('--disable-approval')
    }

    const attachmentReferences: string[] = []
    for (const attachment of options.attachments) {
      if (attachment.mime.toLocaleLowerCase().startsWith('image/')) {
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
      this.buildHistoryBlock(session),
      attachmentReferences.join('\n\n'),
      escapeMuseMentions(options.text)
    ]
      .filter(Boolean)
      .join('\n\n')
    args.push(prompt)

    const turnIndex = session.messages.filter((message) => message.role === 'assistant').length + 1
    this.turnStates.set(session.id, {
      turnIndex,
      messageId: `muse:${session.id}:${turnIndex}`,
      createdAt: Date.now(),
      text: '',
      parts: [],
      started: false,
      tools: new Map(),
      toolByCall: new Map()
    })
    return { command: 'muse', args, env: buildHarnessEnvironment() }
  }

  /**
   * Muse's `exec` does not resume prior context across invocations, so prior
   * turns are replayed into the prompt as a clearly delimited transcript.
   * `session.messages` at this point holds only completed prior turns (the
   * current user message is appended by the base class after this runs).
   */
  private buildHistoryBlock(session: PersistentCliSession): string {
    if (session.messages.length === 0) return ''
    const transcript = session.messages
      .map((message) => {
        const text = message.parts
          .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        return `[${message.role}]\n${escapeMuseMentions(text)}`
      })
      .join('\n\n')
    return `Previous conversation:\n${transcript}`
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId)
    if (!state) return null
    return mapMuseRecord(value, context, state)
  }

  dispose(): void {
    this.turnStates.clear()
    super.dispose()
  }
}
