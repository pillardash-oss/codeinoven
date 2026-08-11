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
  SessionAgentEvent,
  ThinkingLevel,
  ThinkingPreset
} from '../../lib/types'
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
import type { StorageEngine } from '../storage-engine'

/**
 * Muse Code (Meta) headless integration notes.
 *
 * Muse is a terminal-only coding agent whose programmatic surface is
 * `muse exec --json` — a one-shot, headless run that streams newline-delimited
 * JSON on stdout and exits when the turn is done. A prior session is resumed
 * with `--session-id <uuid>`.
 *
 * Wire schema (confirmed against Muse Code 0.1.0-R708.1): every line is an
 * envelope `{ record_type, payload_type, payload }`. Meaningful payloads:
 *   - `run.output.delta`  → `payload.text` (incremental assistant text)
 *   - `run.terminal.completed` → `payload.terminal` (`completed`|`error`),
 *     `payload.text` (final), `payload.reason`
 *   - `run.model.configured` → `payload.provider_id` / `payload.model_id`
 * The run/session id shared by every record is `payload.run_stream.id`
 * (== `payload.command_id`). Despite the `--session-id` flag, separate `exec`
 * invocations do NOT resume prior context (each run is a fresh session whose id
 * is never surfaced in the JSONL), so multi-turn context is replayed into the
 * prompt instead of relying on native resume.
 * There is no per-record token/usage telemetry.
 */

const MUSE_PROBE_TIMEOUT_MS = 15_000

/** Provider id under which every Muse-cloud model is catalogued. */
const MUSE_PROVIDER_ID = 'meta'

/** Reasoning-effort presets baked into Muse's `--reasoning-effort` flag. */
const MUSE_THINKING_PRESETS: ThinkingPreset[] = [
  { id: 'minimal', label: 'Minimal', description: 'Minimum reasoning effort' },
  { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  { id: 'high', label: 'High', description: 'High reasoning effort' },
  { id: 'xhigh', label: 'Extra high', description: 'Extra-high reasoning effort' },
  { id: 'ultra', label: 'Ultra', description: 'Ultra reasoning effort' }
]

/** Map a thread's thinking level onto Muse's `--reasoning-effort` values. */
const MUSE_REASONING_EFFORT: Record<ThinkingLevel, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'ultra',
  ultra: 'ultra'
}

/**
 * Static fallback catalog for the Meta provider. Muse exposes no documented
 * model-list subcommand, so the account's observed default model is advertised
 * directly. The contributor-tier id (`-contributor`) matches what `muse exec`
 * reports via `run.model.configured` on a contributor account; a standard-tier
 * account will need this updated to its own model id.
 */
const MUSE_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: MUSE_PROVIDER_ID,
    name: 'Meta',
    harnessId: 'muse',
    models: [
      {
        id: 'muse-spark-1.2-contributor',
        providerId: MUSE_PROVIDER_ID,
        name: 'Muse Spark 1.2',
        reasoning: true,
        thinkingPresets: MUSE_THINKING_PRESETS,
        attachment: false,
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
          reasoning: true,
          thinkingPresets: MUSE_THINKING_PRESETS,
          attachment: false,
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

/** Turn-scoped state correlating the streamed records of one assistant message. */
interface MuseTurnState {
  turnIndex: number
  messageId: string
  createdAt: number
  text: string
  parts: AgentPart[]
  /** True once any assistant part has been emitted (message exists on disk). */
  started: boolean
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
    const effort = MUSE_REASONING_EFFORT[options.settings.thinkingLevel]
    if (effort) args.push('--reasoning-effort', effort)

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

    const prompt = [options.systemPrompt, this.buildHistoryBlock(session), options.text]
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
      started: false
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
        return `[${message.role}]\n${text}`
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
