import type { AgentMessage, AgentPart, SessionAgentEvent } from '../../../lib/types'
import { isQuestionToolName, normalizeAgentQuestions } from '../../../lib/agent-interactions'
import {
  classifyProviderIssue,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'
import type {
  CliLineParseContext,
  CliLineParseResult
} from '../persistent-cli/persistent-cli-types'
import { mapClineNormalizedUsage, mapClineUsage } from './cline-usage'
import {
  numberValue,
  record,
  serializeToolOutput,
  stringValue,
  timestampValue
} from './cline-values'

export interface ClineTurnState {
  turnIndex: number
  iteration: number
  messageId: string
  createdAt: number
  parts: AgentPart[]
  /** Interaction request ids promoted from the live turn (used to suppress idle). */
  questionRequestIds: Set<string>
  /** Set when the driver deliberately stops the process at a question boundary. */
  expectsProcessStop?: boolean
}

function clineMessage(state: ClineTurnState): AgentMessage {
  return {
    id: state.messageId,
    role: 'assistant',
    parts: [...state.parts],
    createdAt: state.createdAt,
    harnessId: 'cline'
  }
}

function upsertPart(state: ClineTurnState, part: AgentPart): void {
  const index = state.parts.findIndex((candidate) => candidate.id === part.id)
  if (index === -1) state.parts.push(part)
  else state.parts[index] = part
}

function beginClineIteration(
  context: CliLineParseContext,
  state: ClineTurnState,
  iteration: number,
  createdAt: number
): CliLineParseResult {
  state.iteration = iteration
  state.messageId = `cline:${context.sessionId}:${state.turnIndex}:${iteration}`
  state.createdAt = createdAt
  state.parts = []
  return { messages: [clineMessage(state)] }
}

function mapClineContentEvent(
  event: Record<string, unknown>,
  context: CliLineParseContext,
  state: ClineTurnState,
  complete: boolean
): CliLineParseResult {
  const contentType = stringValue(event['contentType'])
  const messageId = state.messageId
  if (
    contentType === 'text' ||
    contentType === 'reasoning' ||
    contentType === 'reasoning_summary'
  ) {
    const partType = contentType === 'text' ? 'text' : 'reasoning'
    const partId = `${messageId}:${partType}`
    const existing = state.parts.find(
      (part): part is Extract<AgentPart, { type: 'text' | 'reasoning' }> =>
        part.id === partId && (part.type === 'text' || part.type === 'reasoning')
    )
    const chunk = contentType === 'reasoning_summary' ? '' : (stringValue(event[contentType]) ?? '')
    const text = complete ? chunk : `${existing?.text ?? ''}${chunk}`
    const summary =
      stringValue(event['summary']) ??
      (contentType === 'reasoning_summary' ? stringValue(event['reasoning_summary']) : undefined)
    const part: Extract<AgentPart, { type: 'text' | 'reasoning' }> =
      partType === 'reasoning'
        ? {
            type: 'reasoning',
            id: partId,
            messageID: messageId,
            text,
            ...(summary ? { summary } : {})
          }
        : { type: 'text', id: partId, messageID: messageId, text }
    upsertPart(state, part)
    return {
      messages: [clineMessage(state)],
      events: [{ type: 'message.part.updated', sessionId: context.sessionId, part }]
    }
  }

  if (contentType === 'tool') {
    const callId = stringValue(event['toolCallId']) ?? `${messageId}:call`
    const toolName = stringValue(event['toolName']) ?? 'tool'
    const output = serializeToolOutput(event['output'])
    const failed =
      event['isError'] === true ||
      (Array.isArray(event['output']) &&
        event['output'].some((entry) => record(entry)?.['success'] === false))
    const previous = state.parts.find(
      (part): part is Extract<AgentPart, { type: 'tool' }> =>
        part.type === 'tool' && part.callID === callId
    )
    const part: Extract<AgentPart, { type: 'tool' }> = {
      type: 'tool',
      id: `${messageId}:tool:${callId}`,
      messageID: messageId,
      callID: callId,
      tool: toolName,
      state: {
        status: complete ? (failed ? 'error' : 'completed') : 'running',
        input: record(event['input']) ?? previous?.state.input ?? {},
        ...(output ? { output } : {}),
        ...(failed ? { error: output ?? `${toolName} failed` } : {})
      }
    }
    upsertPart(state, part)
    const events: SessionAgentEvent[] = [
      { type: 'message.part.updated', sessionId: context.sessionId, part }
    ]
    // Cline's headless `ask_question` executor never blocks on stdin   it
    // resolves immediately with the first option (`Promise.resolve(F[0])`).
    // Promote the call into the shared interaction stream so the chat engine
    // can pause the turn here and resume it with the user's answers; the
    // question boundary is handled by the driver's `onJsonRecord` hook.
    if (isQuestionToolName(toolName) && !state.questionRequestIds.has(callId)) {
      state.questionRequestIds.add(callId)
      events.push({
        type: 'question.asked',
        sessionId: context.sessionId,
        requestId: callId,
        questions: normalizeAgentQuestions(part.state.input),
        tool: { messageID: messageId, callID: callId }
      })
    }
    return { messages: [clineMessage(state)], events }
  }

  return { events: [] }
}

export function mapCurrentClineRecord(
  entry: Record<string, unknown>,
  context: CliLineParseContext,
  state: ClineTurnState
): CliLineParseResult | null {
  const type = stringValue(entry['type'])
  if (type === 'run_start') {
    const nativeSessionId = stringValue(entry['sessionId']) ?? stringValue(entry['session_id'])
    return nativeSessionId ? { nativeSessionId } : { events: [] }
  }

  if (type === 'error') {
    const error = stringValue(entry['message']) ?? stringValue(entry['error'])
    if (!error) return null
    const kind = classifyProviderIssue(error)
    const retryAt = kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(error) : undefined
    return {
      events: [
        {
          type: 'session.error',
          sessionId: context.sessionId,
          error,
          issue: {
            kind,
            message: presentProviderError(error).message,
            rawError: error,
            harnessId: 'cline',
            retryable: kind !== 'billing',
            ...(retryAt === undefined ? {} : { retryAt })
          }
        }
      ]
    }
  }

  if (type === 'agent_event') {
    const event = record(entry['event'])
    if (!event) return null
    const eventType = stringValue(event['type'])
    if (eventType === 'iteration_start') {
      return beginClineIteration(
        context,
        state,
        numberValue(event['iteration']) ?? state.iteration + 1,
        timestampValue(entry['ts'])
      )
    }
    if (eventType === 'content_start' || eventType === 'content_end') {
      return mapClineContentEvent(event, context, state, eventType === 'content_end')
    }
    if (eventType === 'iteration_end') {
      return {
        messages: [{ ...clineMessage(state), completedAt: timestampValue(entry['ts']) }],
        events: [
          { type: 'message.completed', sessionId: context.sessionId, messageId: state.messageId }
        ]
      }
    }
    return { events: [] }
  }

  if (type === 'run_result') {
    const finishReason = stringValue(entry['finishReason'])
    const failed = finishReason === 'error'
    const finalText = stringValue(entry['text']) ?? ''
    let finalTextPart: AgentPart | undefined
    if (finalText) {
      const part: AgentPart = {
        type: 'text',
        id: `${state.messageId}:text`,
        messageID: state.messageId,
        text: finalText
      }
      upsertPart(state, part)
      finalTextPart = part
    }
    const model = record(entry['model'])
    const usage = mapClineUsage(entry['usage'])
    const normalizedUsage = mapClineNormalizedUsage(entry['usage'])
    const cost = numberValue(record(entry['usage'])?.['totalCost'])
    const message: AgentMessage = {
      ...clineMessage(state),
      completedAt: timestampValue(entry['ts']),
      modelId: stringValue(model?.['id']),
      providerId: stringValue(model?.['provider']),
      ...(usage ? { tokens: usage } : {}),
      ...(normalizedUsage ? { normalizedUsage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(failed ? { error: finalText || 'Cline turn failed' } : {})
    }
    const events: SessionAgentEvent[] = []
    if (finalTextPart) {
      events.push({
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: finalTextPart
      })
    }
    events.push({
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId: state.messageId,
      // Cline reports its whole run once, at the end, so this is the only
      // token-bearing event it emits. It has to be carried here or the turn's
      // tokens/second rate would have nothing to divide by.
      ...(usage ? { tokens: usage } : {}),
      ...(normalizedUsage ? { normalizedUsage } : {}),
      ...(failed ? { error: finalText || 'Cline turn failed' } : {})
    })
    return {
      messages: [message],
      events
    }
  }

  return null
}

function mapClineRecordToEvents(
  value: Record<string, unknown>,
  sessionId: string,
  messageId: string
): { events: SessionAgentEvent[] } | undefined {
  const type = stringValue(value['type'])
  if (type !== 'say' && type !== 'ask') return undefined

  const text = stringValue(value['text']) ?? ''
  const say = stringValue(value['say'])
  const ask = stringValue(value['ask'])
  const reasoning = stringValue(value['reasoning'])
  const partial = value['partial'] === true

  if (type === 'say' && say === 'reasoning' && reasoning) {
    const partId = `${messageId}:reasoning`
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'reasoning',
            id: partId,
            messageID: messageId,
            text: reasoning
          }
        }
      ]
    }
  }

  if (type === 'say' && say === 'text') {
    const partId = `${messageId}:text`
    if (partial) {
      return {
        events: [
          {
            type: 'message.part.delta',
            sessionId,
            messageId,
            partId,
            field: 'text',
            delta: text
          }
        ]
      }
    }
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'text',
            id: partId,
            messageID: messageId,
            text
          }
        }
      ]
    }
  }

  if (type === 'say' && say === 'tool') {
    const partId = `${messageId}:tool`
    const toolName = stringValue(value['tool']) ?? 'unknown'
    const toolInput = record(value['input'])
    const toolOutput = stringValue(value['output'])

    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'tool',
            id: partId,
            messageID: messageId,
            callID: `${messageId}:call`,
            tool: toolName,
            state: {
              status: partial ? 'running' : toolOutput ? 'completed' : 'running',
              input: toolInput ?? {},
              ...(toolOutput ? { output: toolOutput } : {}),
              title: toolName
            }
          }
        }
      ]
    }
  }

  if (type === 'ask') {
    const partId = `${messageId}:ask`
    const questionType = ask ?? 'tool'
    const questionText = text || `Allow ${questionType}?`

    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId,
          part: {
            type: 'tool',
            id: partId,
            messageID: messageId,
            callID: partId,
            tool: 'permission',
            state: {
              status: 'running',
              input: { prompt: questionText, ask: questionType },
              title: questionText
            }
          }
        }
      ]
    }
  }

  return undefined
}

export function mapClineRecord(
  value: unknown,
  context: CliLineParseContext
): CliLineParseResult | null {
  const record_ = record(value)
  if (!record_) return null

  const type = stringValue(record_['type'])
  if (!type) return null

  const ts = numberValue(record_['ts']) ?? Date.now()
  const messageId = `cline:${context.sessionId}:${ts}`

  const result = mapClineRecordToEvents(record_, context.sessionId, messageId)
  if (!result) return null

  const messages: AgentMessage[] = []
  for (const event of result.events) {
    if (event.type === 'message.part.updated') {
      const existingMessage = messages.find((m) => m.id === messageId)
      if (existingMessage) {
        const partIndex = existingMessage.parts.findIndex((p) => p.id === event.part.id)
        if (partIndex === -1) {
          existingMessage.parts.push(event.part)
        } else {
          existingMessage.parts[partIndex] = event.part
        }
      } else {
        messages.push({
          id: messageId,
          role: 'assistant',
          parts: [event.part],
          createdAt: ts,
          harnessId: 'cline'
        })
      }
    }
  }

  const nativeSessionId = stringValue(record_['session_id'])

  return {
    events: result.events,
    messages: messages.length > 0 ? messages : undefined,
    nativeSessionId
  }
}
