import type {
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentRateLimitWindow,
  AgentTokenUsage,
  NormalizedUsage,
  ProviderCatalog,
  ProviderModel,
  SessionAgentEvent,
  ThinkingLevel,
  ThinkingPreset
} from '../../lib/types'
import { buildProcessEnvironment } from './cli-environment'
import { attachmentReferences } from './attachment-reference'
import { antigravityModelSlugs } from './antigravity-model-output'
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
  SendPromptOptions
} from './driver.interface'
import type { StorageEngine } from '../storage/storage-engine'
import { runHarnessCommand } from './harness-runtime'

/**
 * Antigravity CLI reads its stdin and hangs when that pipe stays open without
 * EOF or a terminal. Every short-lived probe (version, model list) must spawn
 * with stdin ignored so it exits promptly in a desktop context.
 */
async function runAgy(
  args: string[],
  timeoutMs: number
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  try {
    const result = await runHarnessCommand('agy', args, {
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

const AGY_PROBE_TIMEOUT_MS = 15_000

/** Selectable reasoning effort baked into an Antigravity model slug. */
const EFFORT_SUFFIX = /-(low|medium|high)$/iu

const EFFORT_ORDER: ThinkingLevel[] = ['low', 'medium', 'high']

const EFFORT_PRESETS: Record<'low' | 'medium' | 'high', ThinkingPreset> = {
  low: { id: 'low', label: 'Low', description: 'Low reasoning effort' },
  medium: { id: 'medium', label: 'Medium', description: 'Moderate reasoning effort' },
  high: { id: 'high', label: 'High', description: 'High reasoning effort' }
}

/** Provider id under which every Antigravity-cloud model is catalogued. */
const ANTIGRAVITY_PROVIDER_ID = 'google'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberProperty(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const resolved = numberValue(value[key])
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function stringProperty(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const resolved = stringValue(value[key])
    if (resolved !== undefined) return resolved
  }
  return undefined
}

function epochMilliseconds(value: unknown): number | undefined {
  const numeric = numberValue(value)
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric
  const text = stringValue(value)
  if (!text) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function retryAtFromError(error: string, now = Date.now()): number | undefined {
  const duration = error.match(/resets?\s+in\s+(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/iu)
  if (!duration) return undefined
  const days = Number(duration[1] ?? 0)
  const hours = Number(duration[2] ?? 0)
  const minutes = Number(duration[3] ?? 0)
  const seconds = Number(duration[4] ?? 0)
  const delayMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000
  return delayMs > 0 ? now + delayMs : undefined
}

function antigravityIssue(error: string): AgentProviderIssue {
  const normalized = error.toLowerCase()
  const retryAt = retryAtFromError(error)
  const quota = normalized.includes('quota') || normalized.includes('limit')
  const authentication = normalized.includes('auth') || normalized.includes('sign in')
  return {
    kind: quota ? 'quota' : authentication ? 'authentication' : 'unknown',
    message: error,
    rawError: error,
    harnessId: 'antigravity',
    retryable: quota || retryAt !== undefined,
    ...(retryAt === undefined ? {} : { retryAt })
  }
}

/** Turn a model slug into a friendly display name. */
function prettyModelName(id: string): string {
  const thinking = id.endsWith('-thinking')
  const core = thinking ? id.slice(0, -'-thinking'.length) : id
  const base = core
    .split('-')
    .filter(Boolean)
    .map((token) => {
      const upper = token.toUpperCase()
      if (upper === 'GPT' || upper === 'OSS') return upper
      return token.charAt(0).toUpperCase() + token.slice(1)
    })
    .join(' ')
  return thinking ? `${base} (Thinking)` : base
}

interface ParsedAntigravityCatalog {
  catalogs: ProviderCatalog[]
  variants: Map<string, Map<ThinkingLevel, string>>
}

/** Collapse effort-suffixed slugs into one model with dedicated thinking presets. */
function parseAntigravityModels(output: string): ParsedAntigravityCatalog {
  const slugs = antigravityModelSlugs(output)
  const variants = new Map<string, Map<ThinkingLevel, string>>()
  const standalone = new Set<string>()
  for (const slug of slugs) {
    if (!/^[a-z0-9][a-z0-9.-]*$/iu.test(slug)) continue
    const suffix = slug.match(EFFORT_SUFFIX)
    if (!suffix) {
      standalone.add(slug)
      continue
    }
    const modelId = slug.slice(0, -suffix[0].length)
    const effort = suffix[1].toLowerCase() as 'low' | 'medium' | 'high'
    const modelVariants = variants.get(modelId) ?? new Map<ThinkingLevel, string>()
    modelVariants.set(effort, slug)
    variants.set(modelId, modelVariants)
  }

  const models: ProviderModel[] = []
  for (const [modelId, modelVariants] of variants) {
    models.push({
      id: modelId,
      providerId: ANTIGRAVITY_PROVIDER_ID,
      name: prettyModelName(modelId),
      reasoning: true,
      thinkingPresets: EFFORT_ORDER.filter((effort) => modelVariants.has(effort)).map(
        (effort) => EFFORT_PRESETS[effort as 'low' | 'medium' | 'high']
      ),
      attachment: true,
      toolcall: true
    })
  }
  for (const modelId of standalone) {
    models.push({
      id: modelId,
      providerId: ANTIGRAVITY_PROVIDER_ID,
      name: prettyModelName(modelId),
      reasoning: modelId.endsWith('-thinking'),
      attachment: true,
      toolcall: true
    })
  }
  if (models.length === 0) return { catalogs: [], variants }
  return {
    catalogs: [
      {
        id: ANTIGRAVITY_PROVIDER_ID,
        name: 'Google',
        harnessId: 'antigravity',
        models
      }
    ],
    variants
  }
}

/** Map Antigravity accounting into the canonical normalized contract and display aggregates. */
export function mapAntigravityUsage(value: unknown): {
  aggregateTokens: AgentTokenUsage | undefined
  normalizedUsage: NormalizedUsage | undefined
} {
  const usage = record(value)
  if (!usage) return { aggregateTokens: undefined, normalizedUsage: undefined }
  const input = numberProperty(usage, 'input_tokens', 'inputTokens')
  const output = numberProperty(usage, 'output_tokens', 'outputTokens')
  const reasoning = numberProperty(usage, 'thinking_tokens', 'thinkingTokens')
  const cachedInput = numberProperty(usage, 'cache_read_tokens', 'cacheReadTokens')
  const cacheWrite = numberProperty(usage, 'cache_write_tokens', 'cacheWriteTokens')
  const rawTotal = numberProperty(usage, 'total_tokens', 'totalTokens')
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined ||
    rawTotal !== undefined
  if (!reported) return { aggregateTokens: undefined, normalizedUsage: undefined }
  // Antigravity reports thinking as a subset of output, cache reads as a subset
  // of input, and its total as covering every category, so the provider total's
  // categories overlap when one is reported. A synthesized input+output total
  // would hide cache or reasoning usage, so no comparable total is fabricated
  // and the semantics are declared explicitly: `categories_may_overlap` when
  // the provider reports a total and `unavailable` when it does not. Because
  // the reported input already contains cached reads, uncached input is the
  // remainder after subtracting them, clamped at zero so an inconsistent
  // cache>input payload never produces a negative normalized category.
  const normalizedUsage: NormalizedUsage = {
    uncachedInput: input === undefined ? null : Math.max(0, input - (cachedInput ?? 0)),
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...usage },
    rawTotal: rawTotal ?? null,
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'categories_may_overlap'
  }
  const aggregateTokens: AgentTokenUsage | undefined =
    rawTotal === undefined
      ? undefined
      : {
          input: input ?? 0,
          output: output ?? 0,
          reasoning: reasoning ?? 0,
          cacheRead: cachedInput ?? 0,
          cacheWrite: cacheWrite ?? 0,
          total: rawTotal
        }
  return { aggregateTokens, normalizedUsage }
}

/** Normalize quota maps used by Antigravity's API and status-line payload. */
function mapAntigravityRateLimits(value: unknown): AgentRateLimitWindow[] {
  const root = record(value)
  if (!root) return []
  const directQuota = record(root['quota'])
  const modelMap = record(root['models'])
  const entries = directQuota
    ? Object.entries(directQuota)
    : modelMap
      ? Object.entries(modelMap).map(([id, model]) => {
          const modelRecord = record(model)
          return [id, modelRecord?.['quotaInfo'] ?? modelRecord?.['quota_info']] as const
        })
      : []
  return entries.flatMap(([id, rawQuota]) => {
    const quota = record(rawQuota)
    if (!quota) return []
    const remainingFraction = numberProperty(quota, 'remaining_fraction', 'remainingFraction')
    const resetsAt = epochMilliseconds(quota['reset_time'] ?? quota['resetTime'])
    if (remainingFraction === undefined && resetsAt === undefined) return []
    return [
      {
        id,
        label: id
          .split('-')
          .filter(Boolean)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' '),
        ...(remainingFraction === undefined
          ? {}
          : { usedPercent: Math.max(0, Math.min(100, (1 - remainingFraction) * 100)) }),
        ...(resetsAt === undefined ? {} : { resetsAt })
      }
    ]
  })
}

/** Turn-scoped state correlating the streamed steps of one assistant message. */
interface AntigravityTurnState {
  turnIndex: number
  messageId: string
  createdAt: number
  text: string
  parts: AgentPart[]
  /** True once any assistant part has been emitted (message exists on disk). */
  started: boolean
  /** Latest normalized usage metadata reported for this turn, when any. */
  normalizedUsage?: NormalizedUsage
  /** Wall-clock anchor for the reconstructed step timeline (first stream event). */
  timelineAnchor: number
  /** Cumulative reported step durations, advancing in agy's step order. */
  elapsedMs: number
}

function antigravityMessage(state: AntigravityTurnState): AgentMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    parts: [...state.parts],
    createdAt: state.createdAt,
    harnessId: 'antigravity',
    ...(state.normalizedUsage ? { normalizedUsage: state.normalizedUsage } : {})
  }
}

/**
 * A textless, timed reasoning part. Antigravity strips thought summaries from
 * headless streams, so the duration is the only observable trace of a thinking
 * phase; the block renders as a timed "Thinking" entry with no expandable text.
 */
function reasoningPart(
  state: AntigravityTurnState,
  stepIndex: number | undefined,
  start: number,
  end: number
): Extract<AgentPart, { type: 'reasoning' }> {
  return {
    type: 'reasoning',
    id: `${state.messageId}:thinking:${stepIndex ?? state.parts.length}`,
    messageID: state.messageId,
    text: '',
    time: { start, end }
  }
}

function upsertPart(state: AntigravityTurnState, part: AgentPart): void {
  const index = state.parts.findIndex((candidate) => candidate.id === part.id)
  if (index === -1) state.parts.push(part)
  else state.parts[index] = part
  if (!state.started) state.createdAt = Date.now()
  state.started = true
}

function textPart(state: AntigravityTurnState): Extract<AgentPart, { type: 'text' }> {
  return {
    type: 'text',
    id: `${state.messageId}:text`,
    messageID: state.messageId,
    text: state.text
  }
}

function usageEvent(
  state: AntigravityTurnState,
  rawUsage: unknown,
  sessionId: string
): SessionAgentEvent | null {
  if (!state.started) return null
  const mapped = mapAntigravityUsage(rawUsage)
  if (mapped.normalizedUsage) state.normalizedUsage = mapped.normalizedUsage
  if (!mapped.aggregateTokens && !mapped.normalizedUsage) return null
  return {
    type: 'usage.updated',
    sessionId,
    messageId: state.messageId,
    ...(mapped.aggregateTokens ? { tokens: mapped.aggregateTokens } : {}),
    ...(mapped.normalizedUsage ? { normalizedUsage: mapped.normalizedUsage } : {})
  }
}

/**
 * Map one documented `agy --output-format stream-json` record into CodeInOven's
 * stable shapes. The stream is `init` → `step_update`* → `result`.
 *
 * Keeping this boundary pure makes provider upgrades testable without spawning
 * the CLI.
 */
export function mapAntigravityRecord(
  value: unknown,
  context: CliLineParseContext,
  state: AntigravityTurnState
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  // The step timeline is reconstructed from per-step `duration_seconds`, so it
  // must be anchored to the wall clock when the very first event arrives.
  if (state.timelineAnchor === 0) state.timelineAnchor = Date.now()
  const eventType = stringValue(entry['event'])
  const conversationId = stringValue(entry['conversation_id'])
  const base: CliLineParseResult = conversationId ? { nativeSessionId: conversationId } : {}

  if (eventType === 'result') {
    const result = record(entry['result'])
    if (!result) return base
    const status = stringValue(result['status']) ?? 'ERROR'
    const response = stringValue(result['response'])
    let error =
      status === 'SUCCESS'
        ? undefined
        : (stringValue(result['error']) ??
          stringProperty(record(result['error']) ?? {}, 'message', 'detail') ??
          `Antigravity run ${status.toLowerCase()}`)
    if (response) {
      state.text = response
      upsertPart(state, textPart(state))
    }
    const events: SessionAgentEvent[] = []
    if (state.started) {
      const terminalToolError = [...state.parts]
        .reverse()
        .find((part) => part.type === 'tool' && part.state.status === 'error')
      if (!error && !response && terminalToolError?.type === 'tool') {
        error = terminalToolError.state.error ?? 'Antigravity stopped after a tool failed'
      }
      const text = state.parts.find((part) => part.type === 'text')
      if (text) {
        events.push({
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: textPart(state)
        })
      }
      const mappedUsage = mapAntigravityUsage(result['usage'])
      const usage = mappedUsage.aggregateTokens
      if (mappedUsage.normalizedUsage) state.normalizedUsage = mappedUsage.normalizedUsage
      const structuredRateLimits = mapAntigravityRateLimits(result)
      const issue = error ? antigravityIssue(error) : undefined
      const rateLimits =
        structuredRateLimits.length > 0
          ? structuredRateLimits
          : issue?.kind === 'quota'
            ? [
                {
                  id: 'antigravity-quota',
                  label: 'Antigravity quota',
                  usedPercent: 100,
                  ...(issue.retryAt === undefined ? {} : { resetsAt: issue.retryAt })
                }
              ]
            : []
      if (usage || rateLimits.length > 0) {
        events.push({
          type: 'usage.updated',
          sessionId: context.sessionId,
          messageId: state.messageId,
          ...(usage ? { tokens: usage } : {}),
          ...(mappedUsage.normalizedUsage ? { normalizedUsage: mappedUsage.normalizedUsage } : {}),
          ...(rateLimits.length > 0 ? { rateLimits } : {})
        })
      }
      events.push({
        type: 'message.completed',
        sessionId: context.sessionId,
        messageId: state.messageId,
        ...(usage ? { tokens: usage } : {}),
        ...(mappedUsage.normalizedUsage ? { normalizedUsage: mappedUsage.normalizedUsage } : {}),
        ...(rateLimits.length > 0 ? { rateLimits } : {}),
        ...(error ? { error } : {}),
        ...(issue ? { issue } : {})
      })
      return { ...base, messages: [antigravityMessage(state)], events }
    }
    if (error) {
      events.push({
        type: 'session.error',
        sessionId: context.sessionId,
        error,
        issue: antigravityIssue(error)
      })
    }
    return { ...base, events }
  }

  if (eventType !== 'step_update') return base

  const step = record(entry['step_update'])
  if (!step) return base
  const stepType = stringValue(step['step_type'])
  const terminal = step['state'] === 'DONE' || step['state'] === 'ERROR'
  const stepIndex = numberValue(step['step_index'])
  const stepUsage = usageEvent(state, step['usage'], context.sessionId)
  // Each DONE/ERROR step reports the wall-clock time that step alone consumed.
  // Accumulating them in arrival order reconstructs a per-step timeline so
  // thinking phases can carry an honest start/end even though agy emits no
  // timestamps.
  const durationMs = (numberValue(step['duration_seconds']) ?? 0) * 1000
  const stepStart = state.timelineAnchor + state.elapsedMs
  if (terminal) state.elapsedMs += durationMs

  if (stepType === 'agent_response') {
    const delta = stringValue(step['text_delta'])
    if (!delta) {
      // Antigravity strips thought summaries from headless streams: the
      // concatenated `text_delta` stream always equals the final `response`,
      // even when the step consumed hundreds of thinking tokens. A completed
      // agent_response step that carries thinking tokens but no text is the
      // only stream-level trace of inter-tool reasoning, so surface it as a
      // timed reasoning part; the working trace renders it as a Thinking entry.
      const thinkingTokens =
        numberProperty(record(step['usage']) ?? {}, 'thinking_tokens', 'thinkingTokens') ?? 0
      if (terminal && thinkingTokens > 0 && durationMs > 0) {
        const part = reasoningPart(state, stepIndex, stepStart, stepStart + durationMs)
        upsertPart(state, part)
        return {
          ...base,
          messages: [antigravityMessage(state)],
          events: [
            { type: 'message.part.updated', sessionId: context.sessionId, part },
            ...(stepUsage ? [stepUsage] : [])
          ]
        }
      }
      return { ...base, events: stepUsage ? [stepUsage] : [] }
    }
    state.text += delta
    upsertPart(state, textPart(state))
    const events: SessionAgentEvent[] = [
      { type: 'message.part.updated', sessionId: context.sessionId, part: textPart(state) }
    ]
    if (stepUsage) events.push(stepUsage)
    return { ...base, messages: [antigravityMessage(state)], events }
  }

  if (stepType === 'tool') {
    const toolInfo = record(step['tool_info'])
    const toolName = stringValue(toolInfo?.['name']) ?? stringValue(step['tool_name']) ?? 'tool'
    const callId = `${state.messageId}:tool:${stepIndex ?? state.parts.length}`
    const errorValue = toolInfo?.['error']
    const errorRecord = record(errorValue)
    const error =
      stringValue(errorRecord?.['message']) ??
      (typeof errorValue === 'string' ? errorValue : undefined)
    const output = stringValue(toolInfo?.['output'])
    const part: AgentPart = {
      type: 'tool',
      id: callId,
      messageID: state.messageId,
      callID: callId,
      tool: toolName,
      state: {
        status: error ? 'error' : terminal ? 'completed' : 'running',
        input: record(toolInfo?.['parameters']) ?? {},
        ...(output ? { output } : {}),
        ...(error ? { error } : {})
      }
    }
    upsertPart(state, part)
    const events: SessionAgentEvent[] = [
      { type: 'message.part.updated', sessionId: context.sessionId, part }
    ]
    if (stepUsage) events.push(stepUsage)
    return { ...base, messages: [antigravityMessage(state)], events }
  }

  if (stepType === 'subagent') {
    const info = record(step['subagent_info'])
    const subagents = Array.isArray(info?.['subagents']) ? info['subagents'] : []
    const events: SessionAgentEvent[] = []
    subagents.forEach((raw, index) => {
      const subagent = record(raw)
      if (!subagent) return
      const agent = stringValue(subagent['type_name']) ?? 'subagent'
      const part: AgentPart = {
        type: 'subagent',
        id: `${state.messageId}:subagent:${index}`,
        messageID: state.messageId,
        activity: {
          status: terminal ? 'completed' : 'running',
          agent,
          description: stringValue(subagent['role']) ?? agent,
          prompt: stringValue(subagent['initial_prompt']),
          childSessionId: stringValue(subagent['conversation_id']),
          background: false
        }
      }
      upsertPart(state, part)
      events.push({ type: 'message.part.updated', sessionId: context.sessionId, part })
    })
    if (events.length === 0) return { ...base, events: stepUsage ? [stepUsage] : [] }
    if (stepUsage) events.push(stepUsage)
    return { ...base, messages: [antigravityMessage(state)], events }
  }

  return { ...base, events: stepUsage ? [stepUsage] : [] }
}

/** Process-per-turn bridge for Antigravity CLI's `-p --output-format stream-json`. */
export class AntigravityDriver extends PersistentCliDriver {
  readonly id = 'antigravity'
  readonly name = 'Antigravity'
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
    sessionStatus: false,
    contextUsage: true,
    compaction: false,
    subagents: true,
    nativeUtilities: ['web_search', 'web_fetch']
  }

  private turnStates = new Map<string, AntigravityTurnState>()
  private modelVariants = new Map<string, Map<ThinkingLevel, string>>()
  private modelVariantsAttempted = false

  constructor(storage: StorageEngine) {
    super(storage)
  }

  protected async ensureCliReady(): Promise<void> {
    const result = await runAgy(['--version'], AGY_PROBE_TIMEOUT_MS)
    if (!result.succeeded) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error'
      throw new Error(`Antigravity CLI is unavailable: ${detail}`)
    }
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const result = await runAgy(['models'], AGY_PROBE_TIMEOUT_MS)
    if (!result.succeeded) return []
    const parsed = parseAntigravityModels(result.stdout)
    this.modelVariants = parsed.variants
    return parsed.catalogs
  }

  /** Cheapest available catalog model, shared by title and grading runs. */
  private async cheapestCandidate(): Promise<TitleModelCandidate[]> {
    const catalogs = await this.listProviders()
    const models = catalogs.flatMap((catalog) => catalog.models)
    const cheapest = ['gemini-3.5-flash', 'gemini-3.6-flash']
      .map((modelId) => models.find((model) => model.id === modelId))
      .find((model) => model !== undefined)
    return cheapest ? [{ providerId: cheapest.providerId, modelId: cheapest.id }] : []
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

  private resolveModelId(modelId: string, thinkingLevel: ThinkingLevel): string {
    const variants = this.modelVariants.get(modelId)
    if (!variants || variants.size === 0) return modelId
    const requested =
      thinkingLevel === 'minimal'
        ? 'low'
        : thinkingLevel === 'xhigh' || thinkingLevel === 'max' || thinkingLevel === 'ultra'
          ? 'high'
          : thinkingLevel
    const exact = variants.get(requested)
    if (exact) return exact
    const requestedIndex = EFFORT_ORDER.indexOf(requested)
    const closest = [...variants.entries()].sort((left, right) => {
      const leftDistance = Math.abs(EFFORT_ORDER.indexOf(left[0]) - requestedIndex)
      const rightDistance = Math.abs(EFFORT_ORDER.indexOf(right[0]) - requestedIndex)
      return (
        leftDistance - rightDistance ||
        EFFORT_ORDER.indexOf(left[0]) - EFFORT_ORDER.indexOf(right[0])
      )
    })[0]
    return closest?.[1] ?? modelId
  }

  /**
   * Populate the effort-variant map on first use so bare effort model ids
   * (`gemini-3.6-flash`) resolve to an effort-suffixed slug before being sent
   * to agy. Discovery may serve the catalog from the persisted snapshot without
   * ever running `listProviders` on this instance, which would otherwise leak
   * the bare id into the turn command and make agy reject it. The probe runs at
   * most once per driver instance even when it fails.
   */
  private async ensureModelVariants(): Promise<void> {
    if (this.modelVariantsAttempted || this.modelVariants.size > 0) return
    this.modelVariantsAttempted = true
    const result = await runAgy(['models'], AGY_PROBE_TIMEOUT_MS)
    if (result.succeeded) this.modelVariants = parseAntigravityModels(result.stdout).variants
  }

  protected async buildTurnCommand(
    projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    const attached = await attachmentReferences(options.attachments)
    const prompt = [options.systemPrompt, attached, options.text].filter(Boolean).join('\n\n')
    // agy's custom flag parser treats `--output-format` (and its value) as part
    // of the prompt unless the prompt directly follows `-p`. The prompt must
    // come immediately after `-p`, with every flag after it, or print mode
    // silently emits the model's plain-text response instead of NDJSON events.
    // Antigravity keeps its model workspace separate from the process cwd.
    // Register the resolved scope root explicitly or relative repository paths
    // are rewritten beneath Antigravity's scratch directory and file writes are
    // then rejected as invalid conversation-artifact paths.
    const args: string[] = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--add-dir',
      projectPath
    ]
    if (session.nativeSessionId) args.push('--conversation', session.nativeSessionId)
    if (options.settings.modelId && options.settings.modelId !== 'default') {
      await this.ensureModelVariants()
      args.push(
        '--model',
        this.resolveModelId(options.settings.modelId, options.settings.thinkingLevel)
      )
    }
    if (options.readOnly) args.push('--mode', 'plan')
    if (options.settings.permissionLevel === 'full_access') {
      args.push('--dangerously-skip-permissions')
    } else {
      // Print mode cannot display Antigravity's approval cards. Leaving its
      // default request-review policy active auto-denies the first protected
      // tool, after which the CLI exits successfully with an empty response.
      // Auto Review therefore auto-approves inside Antigravity's OS sandbox;
      // Full Access is the only tier that runs without that containment.
      args.push('--sandbox', '--dangerously-skip-permissions')
    }
    // Agentic turns routinely outlive the 5m print default; give the agent a
    // generous ceiling so the turn is not cut off mid-implementation.
    args.push('--print-timeout', '30m')

    const turnIndex = session.messages.filter((message) => message.role === 'assistant').length + 1
    this.turnStates.set(session.id, {
      turnIndex,
      messageId: `antigravity:${session.id}:${turnIndex}`,
      createdAt: Date.now(),
      text: '',
      parts: [],
      started: false,
      timelineAnchor: 0,
      elapsedMs: 0
    })
    return { command: 'agy', args, env: buildProcessEnvironment() }
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId)
    if (!state) return null
    return mapAntigravityRecord(value, context, state)
  }

  dispose(): void {
    this.turnStates.clear()
    this.modelVariants.clear()
    super.dispose()
  }
}
