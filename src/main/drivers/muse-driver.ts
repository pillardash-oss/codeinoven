import { spawn } from 'child_process'
import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentTokenUsage,
  ProviderCatalog,
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
 * JSON on stdout and exits when the turn is done. A prior session can be
 * resumed with `--session-id <uuid>`.
 *
 * The official docs (developer.meta.com / dev.meta.ai) block automated fetches,
 * so the exact `exec --json` wire schema below is reconstructed from secondary
 * sources and is intentionally parsed defensively. Every record maps through
 * the pure `mapMuseRecord` function so the schema can be corrected in a single
 * place once it is confirmed against the live CLI.
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
 * model-list subcommand, so the known default model is advertised directly.
 */
const MUSE_FALLBACK_CATALOG: ProviderCatalog[] = [
  {
    id: MUSE_PROVIDER_ID,
    name: 'Meta',
    harnessId: 'muse',
    models: [
      {
        id: 'muse-spark-1.2',
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

function stringProperty(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const resolved = stringValue(value[key])
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function numberProperty(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const resolved = numberValue(value[key])
    if (resolved !== undefined) return resolved
  }
  return undefined
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

/** Map one Muse token-accounting object into the shared usage shape, if any. */
function mapMuseUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberProperty(usage, 'inputTokens', 'input_tokens', 'promptTokens') ?? 0
  const output = numberProperty(usage, 'outputTokens', 'output_tokens', 'completionTokens') ?? 0
  const reasoning = numberProperty(usage, 'reasoningTokens', 'thinkingTokens') ?? 0
  const cacheRead = numberProperty(usage, 'cacheReadTokens', 'cacheReadInputTokens') ?? 0
  const cacheWrite = numberProperty(usage, 'cacheWriteTokens', 'cacheCreationInputTokens') ?? 0
  const total =
    numberProperty(usage, 'totalTokens', 'total_tokens') ??
    input + output + reasoning + cacheRead + cacheWrite
  return { input, output, reasoning, cacheRead, cacheWrite, total }
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
 * Map one `muse exec --json` record into CodeInOven's stable shapes.
 *
 * The exact Muse wire schema is unverified (docs block bots), so this parser
 * is intentionally tolerant: it never throws, accumulates any recognizable
 * text into the assistant message, surfaces tool activity when a tool is
 * reported, and closes the turn when a terminal status arrives. Unknown record
 * shapes are ignored so a schema drift degrades to a silent turn rather than a
 * broken session. Keeping this boundary pure makes the schema easy to correct
 * and unit-testable once it is confirmed.
 */
export function mapMuseRecord(
  value: unknown,
  context: CliLineParseContext,
  state: MuseTurnState
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null

  const nativeSessionId = stringProperty(entry, 'session_id', 'sessionId', 'session')
  const base: CliLineParseResult = nativeSessionId ? { nativeSessionId } : {}

  // ── Terminal status (run finished, possibly with an error) ──────────────
  const status =
    stringProperty(entry, 'status', 'state', 'finish_reason', 'finishReason', 'result') ??
    stringValue(entry['done'] === true ? 'done' : entry['complete'] === true ? 'done' : undefined)
  const terminal = status !== undefined && !/pending|running|working|stream|init/iu.test(status)
  const failed = /error|fail|exception|cancel/iu.test(status ?? '')

  const text = stringProperty(entry, 'text', 'content', 'message', 'output', 'response', 'delta')
  if (text) {
    state.text = text
    upsertPart(state, textPart(state))
  }

  const usage = mapMuseUsage(entry['usage'] ?? entry['tokens'])
  const events: SessionAgentEvent[] = []

  // ── Tool activity ────────────────────────────────────────────────────────
  const toolName = stringProperty(entry, 'tool', 'toolName', 'tool_name', 'name')
  if (toolName && /^[a-z_]/iu.test(toolName)) {
    const callId = `${state.messageId}:tool:${state.parts.length}`
    const errorText = stringProperty(entry, 'error', 'errorMessage')
    const part: AgentPart = {
      type: 'tool',
      id: callId,
      messageID: state.messageId,
      callID: callId,
      tool: toolName,
      state: {
        status: errorText ? 'error' : terminal ? (failed ? 'error' : 'completed') : 'running',
        input: record(entry['input'] ?? entry['parameters']) ?? {},
        ...(text ? { output: text } : {}),
        ...(errorText ? { error: errorText } : {})
      }
    }
    upsertPart(state, part)
    events.push({ type: 'message.part.updated', sessionId: context.sessionId, part })
  } else if (text) {
    events.push({
      type: 'message.part.updated',
      sessionId: context.sessionId,
      part: textPart(state)
    })
  }

  if (usage && state.started) {
    events.push({
      type: 'usage.updated',
      sessionId: context.sessionId,
      messageId: state.messageId,
      tokens: usage
    })
  }

  // ── Close the turn ───────────────────────────────────────────────────────
  if (terminal && state.started) {
    const error = failed
      ? (stringProperty(entry, 'error', 'errorMessage', 'message') ??
        `${status ?? 'Muse'} turn failed`)
      : undefined
    events.push({
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId: state.messageId,
      ...(usage ? { tokens: usage } : {}),
      ...(error ? { error, issue: museIssue(error) } : {})
    })
    return { ...base, messages: [museMessage(state)], events }
  }

  if (terminal && !state.started && failed) {
    const error = stringProperty(entry, 'error', 'errorMessage', 'message') ?? 'Muse run failed'
    events.push({
      type: 'session.error',
      sessionId: context.sessionId,
      error,
      issue: museIssue(error)
    })
    return { ...base, events }
  }

  if (events.length === 0) return base
  return { ...base, messages: [museMessage(state)], events }
}

/** Process-per-turn bridge for Muse Code's `muse exec --json`. */
export class MuseDriver extends PersistentCliDriver {
  readonly id = 'muse'
  readonly name = 'Muse Code'
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    steering: false,
    nativeResume: true,
    messageHistory: 'mirrored',
    interactivePermissions: false,
    attachments: false,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: true,
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
    return MUSE_FALLBACK_CATALOG
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
      // Inspection chats must not mutate the workspace or stall on approval.
      args.push('--approval-mode', 'never')
    } else if (options.settings.permissionLevel === 'full_access') {
      args.push('--yolo')
    } else {
      // Headless exec cannot render approval cards; Auto Review therefore runs
      // the turn autonomously (Muse's `--yolo`) so it is not cut off waiting on
      // a prompt nobody can see. Full Access is the identical flag — the app
      // still governs which tools each turn may reach at the policy layer.
      args.push('--yolo')
    }

    const prompt = [options.systemPrompt, options.text].filter(Boolean).join('\n\n')
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
