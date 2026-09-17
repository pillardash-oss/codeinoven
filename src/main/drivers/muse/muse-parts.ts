import type {
  AgentMessage,
  AgentPart,
  AgentSubagentActivity,
  SessionAgentEvent
} from '../../../lib/types'
import { isQuestionToolName, normalizeInteractionName } from '../../../lib/agent-interactions'
import type {
  CliLineParseContext,
  CliLineParseResult
} from '../persistent-cli/persistent-cli-types'
import { numberValue, record, stringValue } from './muse-values'

/** In-flight tool-call record correlated across Muse's task lifecycle events. */
export interface MuseToolState {
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

export function museMessage(state: MuseTurnState): AgentMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    parts: [...state.parts],
    createdAt: state.createdAt,
    harnessId: 'muse'
  }
}

export function upsertPart(state: MuseTurnState, part: AgentPart): void {
  const index = state.parts.findIndex((candidate) => candidate.id === part.id)
  if (index === -1) state.parts.push(part)
  else state.parts[index] = part
  if (!state.started) state.createdAt = Date.now()
  state.started = true
}

export function textPart(state: MuseTurnState): Extract<AgentPart, { type: 'text' }> {
  return {
    type: 'text',
    id: `${state.messageId}:text`,
    messageID: state.messageId,
    text: state.text
  }
}

export function reasoningPart(state: MuseTurnState): Extract<AgentPart, { type: 'reasoning' }> {
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
export function museApplyChunkFields(tool: MuseToolState, chunk: string): void {
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
export function museApplyResultText(tool: MuseToolState, text: string): void {
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

export function isMuseSubagentSpawn(name: string): boolean {
  return normalizeInteractionName(name) === 'subagent_spawn' || name === 'subagent_spawn'
}

export function normalizeMuseWorktreeIsolation(input: unknown): void {
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
  // Force shared worktree   CodeInOven owns worktree lifecycle, never isolated
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

export function museSubagentEvent(
  context: CliLineParseContext,
  state: MuseTurnState,
  tool: MuseToolState
) {
  const part = museSubagentPart(state, tool)
  upsertPart(state, part)
  return { type: 'message.part.updated' as const, sessionId: context.sessionId, part }
}

/** Build a `tool` part from an in-flight Muse tool-call record. */
export function museToolPart(state: MuseTurnState, tool: MuseToolState): AgentPart {
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
export function museToolEvent(
  context: CliLineParseContext,
  state: MuseTurnState,
  tool: MuseToolState
) {
  const part = museToolPart(state, tool)
  upsertPart(state, part)
  return { type: 'message.part.updated' as const, sessionId: context.sessionId, part }
}

/** Mark a tool settled and emit its final card event. `null` for tools that
 *  must stay out of the conversation (harness-native questions). */
export function museCompleteTool(
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
 * Finalize every in-flight tool card that outlived its run   e.g. the run was
 * stopped for a permission gate or steering while a sibling call was mid-flight,
 * or the turn ended without the call reporting a result. Without this the
 * affected cards spin forever and never show their details.
 */
export function museFinalizeInterruptedTools(
  context: CliLineParseContext,
  state: MuseTurnState
): SessionAgentEvent[] {
  const events: SessionAgentEvent[] = []
  for (const tool of state.tools.values()) {
    if (tool.status !== 'pending' && tool.status !== 'running') continue
    if (state.gatedTaskIds.has(tool.taskId) || tool.requiresPermission) continue
    tool.error = 'Interrupted   the Muse run stopped before this call reported a result.'
    const event = museCompleteTool(context, state, tool, undefined, true)
    if (event) events.push(event)
  }
  return events
}

export function museCompactionResult(
  context: CliLineParseContext,
  state: MuseTurnState,
  summary: string | undefined,
  auto: boolean,
  overflow?: boolean
): CliLineParseResult {
  const fallbackSummary =
    summary ??
    'Automatic context compaction by Muse   older history summarized per summary-preserved-suffix/v1; next turn continues seamlessly from this checkpoint with preserved suffix.'
  // Muse mirrors the same compaction checkpoint into both the headless stdout
  // and its durable session log with unrelated record ids. One CodeInOven
  // checkpoint per actual compaction   skip an identical repeat.
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

export function museToolForCall(
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
