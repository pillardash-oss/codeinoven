import type { AgentMessage, AgentPart, SessionAgentEvent } from '../../../lib/types'
import { Logger } from '../../system/logger'
import type {
  CliLineParseContext,
  CliLineParseResult,
  PersistentCliSession
} from '../persistent-cli-driver'
import { codexUsageLimitIssue } from './codex-errors'
import { mapCodexUsage } from './codex-usage'
import {
  arrayText,
  errorText,
  isRecord,
  recordValue,
  stringValue,
  toolInput,
  toolOutput
} from './codex-values'

/** Folds Codex item and record payloads into session messages and events. */

export function parseItem(
  item: Record<string, unknown>,
  completed: boolean,
  sessionId: string
): CliLineParseResult | null {
  const itemType = stringValue(item['type'])
  const itemId = stringValue(item['id'])
  if (!itemType || !itemId) return null
  // Codex item ids (e.g. `item_0`) are only unique within one Codex thread.
  // Namespace them with the CodeInOven session so the agent_messages primary
  // key never collides across threads or freshly recreated sessions.
  const messageId = `${sessionId}:${itemId}`
  if (itemType === 'agent_message') return parseAgentMessage(item, messageId, completed, sessionId)
  if (itemType === 'user_message') return parseUserMessage(item, messageId, completed, sessionId)
  if (itemType === 'reasoning') return parseReasoning(item, messageId, completed, sessionId)
  if (itemType === 'command_execution') return parseCommand(item, messageId, completed, sessionId)
  if (itemType === 'file_change')
    return parseTool(item, messageId, completed, sessionId, 'file_change')
  if (itemType === 'contextCompaction')
    return parseCompaction(item, messageId, completed, sessionId)
  if (itemType === 'collab_tool_call')
    return parseCollaboration(item, messageId, completed, sessionId)
  if (itemType === 'plan_update' || itemType === 'todo_list' || itemType === 'plan')
    return parseTool(item, messageId, completed, sessionId, itemType)
  if (itemType === 'mcp_tool_call')
    return parseTool(
      item,
      messageId,
      completed,
      sessionId,
      stringValue(item['tool']) ?? stringValue(item['name']) ?? 'mcp_tool_call'
    )
  if (itemType === 'function_call') {
    // Codex's collaboration mode (native sub-agents) surfaces as plain
    // function calls (`send_message`, `wait_agent`, ...) instead of the
    // richer `collab_tool_call` item type. Route those to the collaboration
    // parser so the UI renders a sub-agent card instead of an opaque tool
    // row with an encrypted payload the user cannot interpret.
    if (isCollaborationCallItem(item)) {
      return parseCollaboration(item, messageId, completed, sessionId)
    }
    return parseTool(
      item,
      messageId,
      completed,
      sessionId,
      stringValue(item['tool']) ?? stringValue(item['name']) ?? 'function_call'
    )
  }
  return null
}

function codexUserMessageText(item: Record<string, unknown>): string {
  const direct = stringValue(item['text'])
  if (direct) return direct
  const content = item['content']
  if (!Array.isArray(content)) return ''
  return content
    .map((value) => {
      if (typeof value === 'string') return value
      const entry = recordValue(value)
      if (!entry) return ''
      return (
        stringValue(entry['text']) ??
        stringValue(entry['url']) ??
        stringValue(entry['path']) ??
        stringValue(entry['name']) ??
        ''
      )
    })
    .filter(Boolean)
    .join('\n')
}

function parseUserMessage(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const part = {
    type: 'text' as const,
    id: `${itemId}:text`,
    messageID: itemId,
    text: codexUserMessageText(item)
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) events.push({ type: 'message.completed', sessionId, messageId: itemId })
  const message: AgentMessage = {
    id: itemId,
    role: 'user',
    origin: 'subagent',
    visibility: 'subagent_trace',
    parts: [part],
    createdAt: Date.now(),
    ...(completed ? { completedAt: Date.now() } : {})
  }
  return { events, messages: [message] }
}

/** Function-call names Codex uses for its collaboration (sub-agent) tooling. */
const COLLABORATION_FUNCTION_TOOLS = new Set(['spawn_agent', 'send_message', 'wait_agent'])

/** Human-readable labels so sub-agent activity stays understandable even when
 *  Codex encrypts the collaboration payloads themselves. */
const COLLABORATION_TOOL_LABELS: Record<string, string> = {
  spawn_agent: 'Spawning a Codex sub-agent',
  send_message: 'Delegating work to a Codex sub-agent',
  wait_agent: 'Waiting for a Codex sub-agent to finish'
}

function isCollaborationCallItem(item: Record<string, unknown>): boolean {
  if (stringValue(item['namespace']) === 'collaboration') return true
  const tool = stringValue(item['tool']) ?? stringValue(item['name'])
  return tool !== undefined && COLLABORATION_FUNCTION_TOOLS.has(tool)
}

function parseCollaboration(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const providerStatus = stringValue(item['status'])
  const failed =
    providerStatus === 'failed' || providerStatus === 'error' || providerStatus === 'declined'
  const tool = stringValue(item['tool']) ?? stringValue(item['name']) ?? 'collaboration'
  const prompt = stringValue(item['prompt'])
  const childSessionId =
    stringValue(item['newThreadId']) ??
    stringValue(item['new_thread_id']) ??
    stringValue(item['receiverThreadId']) ??
    stringValue(item['receiver_thread_id'])
  const agentStatus = recordValue(item['agentStatus'] ?? item['agent_status'])
  const agent =
    stringValue(agentStatus?.['name']) ??
    stringValue(agentStatus?.['agent']) ??
    stringValue(item['agent']) ??
    'Codex'
  const output =
    stringValue(item['output']) ?? stringValue(item['result']) ?? stringValue(item['message'])
  const status = !completed
    ? ('running' as const)
    : failed
      ? ('error' as const)
      : ('completed' as const)
  const part = {
    type: 'subagent' as const,
    id: `${itemId}:subagent`,
    messageID: itemId,
    callID: itemId,
    activity: {
      status,
      agent,
      description:
        stringValue(item['description']) ?? COLLABORATION_TOOL_LABELS[tool] ?? prompt ?? tool,
      ...(prompt ? { prompt } : {}),
      ...(childSessionId ? { childSessionId } : {}),
      providerTaskId: itemId,
      background: item['background'] === true,
      ...(output ? { output } : {}),
      ...(failed ? { error: output ?? `Codex ${tool} failed` } : {})
    }
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) events.push({ type: 'message.completed', sessionId, messageId: itemId })
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    origin: 'subagent',
    visibility: 'working_trace',
    parts: [part],
    createdAt: Date.now(),
    ...(completed ? { completedAt: Date.now() } : {})
  }
  return { events, messages: [message] }
}

function parseAgentMessage(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const text = stringValue(item['text']) ?? ''
  const phase = stringValue(item['phase'])
  const normalizedPhase: 'commentary' | 'final_answer' =
    phase === 'final_answer' ? 'final_answer' : 'commentary'
  const part = {
    type: 'text' as const,
    id: `${itemId}:text`,
    messageID: itemId,
    text,
    phase: normalizedPhase
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  if (completed) {
    message.completedAt = Date.now()
    events.push({ type: 'message.completed', sessionId, messageId: itemId })
  }
  return { events, messages: [message] }
}

function parseReasoning(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const text = arrayText(item['content']) || stringValue(item['text']) || ''
  const summary = arrayText(item['summary'])
  if (completed && !text && !summary) {
    // Completion snapshots may omit the content already delivered through
    // reasoning deltas. Do not replace the accumulated session message with an
    // empty item; only mark that streamed message complete.
    return {
      events: [{ type: 'message.completed', sessionId, messageId: itemId }],
      messages: []
    }
  }
  const part = {
    type: 'reasoning' as const,
    id: `${itemId}:reasoning`,
    messageID: itemId,
    text,
    ...(summary ? { summary } : {})
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) events.push({ type: 'message.completed', sessionId, messageId: itemId })
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

function parseCommand(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const command = stringValue(item['command'])
  return parseTool(item, itemId, completed, sessionId, 'command_execution', command)
}

function parseTool(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string,
  providerTool: string,
  command?: string
): CliLineParseResult {
  const providerStatus = stringValue(item['status'])
  const failed = completed && (providerStatus === 'failed' || providerStatus === 'error')
  const toolPart = {
    type: 'tool' as const,
    id: `${itemId}:tool`,
    messageID: itemId,
    callID: itemId,
    tool: providerTool,
    state: {
      status: !completed
        ? ('running' as const)
        : failed
          ? ('error' as const)
          : ('completed' as const),
      input: toolInput(item),
      title: command,
      output: toolOutput(item)
    }
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part: toolPart }]
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [toolPart],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

function parseCompaction(
  item: Record<string, unknown>,
  itemId: string,
  completed: boolean,
  sessionId: string
): CliLineParseResult {
  const summary = stringValue(item['summary']) ?? stringValue(item['text'])
  const part = {
    type: 'compaction' as const,
    id: `${itemId}:compaction`,
    messageID: itemId,
    auto: true,
    ...(summary ? { summary } : {})
  }
  const events: SessionAgentEvent[] = [{ type: 'message.part.updated', sessionId, part }]
  if (completed) {
    events.push({ type: 'message.completed', sessionId, messageId: itemId, compaction: true })
  }
  const message: AgentMessage = {
    id: itemId,
    role: 'assistant',
    parts: [part],
    createdAt: Date.now()
  }
  return { events, messages: [message] }
}

/**
 * Rewrite a native Codex message id into its session-namespaced form. Only
 * assistant messages carry raw codex item ids; user messages keep the
 * generated id CodeInOven assigned at send time.
 */
export function namespacedMessage(message: AgentMessage, sessionId: string): AgentMessage {
  const prefix = `${sessionId}:`
  if (message.role !== 'assistant' || message.id.startsWith(prefix)) return message
  const messageId = `${prefix}${message.id}`
  const parts = message.parts.map((part) => ({
    ...part,
    id: part.messageID === message.id ? `${prefix}${part.id}` : part.id,
    messageID: part.messageID === message.id ? messageId : part.messageID,
    ...(part.type === 'tool' && part.callID === message.id ? { callID: messageId } : {})
  }))
  return { ...message, id: messageId, parts }
}

/** Parse one Codex app-server/exec JSONL line into stable agent events. */
export interface CodexLineHooks {
  refreshContextUsage(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string,
    nativeThreadId: string
  ): Promise<void>
  refreshRateLimits(
    projectPath: string,
    session: PersistentCliSession,
    messageId: string
  ): Promise<void>
}

export function parseCodexJsonLine(
  value: unknown,
  context: CliLineParseContext,
  hooks: CodexLineHooks
): CliLineParseResult | null {
  if (!isRecord(value)) return null
  const type = stringValue(value['type']) ?? stringValue(value['method'])
  if (!type) return null
  if (type === 'thread.started') {
    const threadId = stringValue(value['thread_id'])
    return threadId ? { nativeSessionId: threadId } : null
  }
  if (type === 'turn.failed' || type === 'error') {
    const error = errorText(value)
    const issue = codexUsageLimitIssue(value, error)
    return {
      events: [
        {
          type: 'session.error',
          sessionId: context.sessionId,
          error,
          ...(issue ? { issue } : {})
        }
      ]
    }
  }
  if (type === 'event_msg') {
    const payload = recordValue(value['payload'])
    if (stringValue(payload?.['type']) !== 'token_count') return null
    const usage = mapCodexUsage(payload?.['info'])
    if (!usage) return { events: [] }
    const latestMessage = [...context.session.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    if (!latestMessage) return { events: [] }
    if (usage.normalizedUsage) latestMessage.normalizedUsage = usage.normalizedUsage
    return {
      events: [
        {
          type: 'usage.updated',
          sessionId: context.sessionId,
          messageId: latestMessage.id,
          ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
          ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
          ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
        }
      ]
    }
  }
  if (type === 'turn.completed') {
    const usage = mapCodexUsage(value['usage'])
    const finalMessage = [...context.session.messages]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' && message.parts.some((part) => part.type === 'text')
      )
    if (!finalMessage) return { events: [] }
    const finalTextPart = finalMessage.parts.find(
      (part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text'
    )
    const finalPhaseUpdate =
      finalTextPart && finalTextPart.phase !== 'final_answer'
        ? {
            type: 'message.part.updated' as const,
            sessionId: context.sessionId,
            part: { ...finalTextPart, phase: 'final_answer' as const }
          }
        : undefined
    const events: SessionAgentEvent[] = finalPhaseUpdate ? [finalPhaseUpdate] : []
    if (usage) {
      if (usage.normalizedUsage) finalMessage.normalizedUsage = usage.normalizedUsage
      events.push({
        type: 'message.completed',
        sessionId: context.sessionId,
        messageId: finalMessage.id,
        ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
        ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
        ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
        ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
      })
    }
    if (context.projectPath) {
      if (context.session.nativeSessionId) {
        void hooks
          .refreshContextUsage(
            context.projectPath,
            context.session,
            finalMessage.id,
            context.session.nativeSessionId
          )
          .catch((error) => Logger.dev('Codex context usage refresh unavailable:', error))
      }
      void hooks
        .refreshRateLimits(context.projectPath, context.session, finalMessage.id)
        .catch((error) => Logger.dev('Codex account rate-limit refresh unavailable:', error))
    }
    return { events }
  }
  if (type === 'thread/tokenUsage/updated' || type === 'thread.tokenUsage.updated') {
    const params = recordValue(value['params']) ?? value
    const usage = mapCodexUsage(
      params['tokenUsage'] ?? params['token_usage'] ?? params['usage'] ?? params
    )
    if (!usage) return { events: [] }
    const latestMessage = [...context.session.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    if (!latestMessage) return { events: [] }
    if (usage.normalizedUsage) latestMessage.normalizedUsage = usage.normalizedUsage
    return {
      events: [
        {
          type: 'usage.updated',
          sessionId: context.sessionId,
          messageId: latestMessage.id,
          ...(usage.aggregateTokens ? { tokens: usage.aggregateTokens } : {}),
          ...(usage.normalizedUsage ? { normalizedUsage: usage.normalizedUsage } : {}),
          ...(usage.contextUsed === undefined ? {} : { contextUsed: usage.contextUsed }),
          ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow })
        }
      ]
    }
  }
  if (type === 'item.started' || type === 'item.completed') {
    const item = recordValue(value['item'])
    return item ? parseItem(item, type === 'item.completed', context.sessionId) : null
  }
  return null
}
