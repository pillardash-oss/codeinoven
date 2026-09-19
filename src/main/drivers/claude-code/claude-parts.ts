import type { AgentMessage, AgentPart } from '../../../lib/types'
import type { CliLineParseContext } from '../persistent-cli-driver'
import { tokenUsage } from './claude-usage'
import { record, string, summaryText } from './claude-values'

/** Claude Code tool, sub-agent, reasoning, and assistant part construction. */

/**
 * Marker the Claude Code CLI returns as an Agent tool_result when the call was
 * queued as a background task instead of running synchronously. The tool call
 * "completes" instantly, but the CLI keeps the turn process alive and later
 * injects the agent's <task-notification> as a new prompt in the SAME process,
 * so that process still needs a live stdin for can_use_tool control responses
 * (AskUserQuestion and permission prompts) after the first result arrives.
 */
export const CLAUDE_ASYNC_AGENT_LAUNCH_MARKER = 'Async agent launched successfully'

export function toolPart(
  messageId: string,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  status: 'pending' | 'completed' | 'error',
  output?: string
): AgentPart {
  return {
    type: 'tool',
    id: `claude-tool-${callId}`,
    messageID: messageId,
    callID: callId,
    tool: name,
    state: { status, input, output }
  }
}

export function isClaudeSubagentTool(name: string): boolean {
  return name === 'Agent' || name === 'Task'
}

export function claudeSubagentPart(
  messageId: string,
  callId: string,
  name: string,
  input: Record<string, unknown>,
  status: 'pending' | 'running' | 'completed' | 'error',
  output?: string
): AgentPart {
  const description =
    string(input['description']) ?? string(input['name']) ?? string(input['subagent_type']) ?? name
  return {
    type: 'subagent',
    id: `claude-subagent-${callId}`,
    messageID: messageId,
    callID: callId,
    activity: {
      status,
      agent: string(input['subagent_type']) ?? string(input['agent']) ?? name,
      description,
      prompt: string(input['prompt']),
      providerTaskId: callId,
      modelId: string(input['model']),
      background: input['run_in_background'] === true || input['background'] === true,
      ...(output ? { output } : {}),
      ...(status === 'error' ? { error: output ?? 'Claude sub-agent task failed' } : {})
    }
  }
}

export function partFromBlock(
  messageId: string,
  block: Record<string, unknown>,
  index: number
): AgentPart | null {
  const type = string(block['type'])
  if (type === 'text') {
    return {
      type: 'text',
      id: `claude-text-${messageId}-${index}`,
      messageID: messageId,
      text: string(block['text']) ?? ''
    }
  }
  if (type === 'thinking') {
    const summary = summaryText(block['summary'])
    return {
      type: 'reasoning',
      id: `claude-thinking-${messageId}-${index}`,
      messageID: messageId,
      text: string(block['thinking']) ?? '',
      ...(summary ? { summary } : {})
    }
  }
  if (type === 'tool_use') {
    const callId = string(block['id']) ?? `claude-call-${messageId}-${index}`
    const name = string(block['name']) ?? 'unknown'
    const input = record(block['input']) ?? {}
    // AskUserQuestion is handled exclusively through the native can_use_tool
    // control request. Promoting it here too would race that control event
    // and register a second, differently-keyed question.asked, showing the
    // same question set twice.
    if (name === 'AskUserQuestion') return null
    if (isClaudeSubagentTool(name)) {
      return claudeSubagentPart(messageId, callId, name, input, 'pending')
    }
    return toolPart(messageId, callId, name, input, 'pending')
  }
  return null
}

export function findToolPart(
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

export function findSubagentPart(
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

export function activeClaudeSubagentParts(
  context: CliLineParseContext,
  background: boolean
): Extract<AgentPart, { type: 'subagent' }>[] {
  return context.session.messages.flatMap((message) =>
    message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'subagent' }> =>
        part.type === 'subagent' &&
        part.activity.background === background &&
        (part.activity.status === 'pending' || part.activity.status === 'running')
    )
  )
}

export function messageFromAssistant(message: Record<string, unknown>): AgentMessage {
  const messageId = string(message['id']) ?? `claude-assistant-${Date.now()}`
  const content = Array.isArray(message['content']) ? message['content'] : []
  const parts: AgentPart[] = []
  const now = Date.now()
  for (const [index, blockValue] of content.entries()) {
    const block = record(blockValue)
    if (!block) continue
    const part = partFromBlock(messageId, block, index)
    if (part) parts.push(part)
  }
  const tokens = tokenUsage(message['usage'])
  return { id: messageId, role: 'assistant', parts, createdAt: now, ...(tokens ? { tokens } : {}) }
}

export function latestAssistant(context: CliLineParseContext): AgentMessage | undefined {
  return [...context.session.messages].reverse().find((message) => message.role === 'assistant')
}

export function mergeAssistantRecord(existing: AgentMessage, incoming: AgentMessage): AgentMessage {
  const parts = new Map(existing.parts.map((part) => [part.id, part]))
  for (const part of incoming.parts) parts.set(part.id, part)
  return {
    ...existing,
    ...incoming,
    createdAt: existing.createdAt,
    parts: [...parts.values()]
  }
}
