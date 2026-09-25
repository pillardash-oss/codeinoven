import type { AgentEvent, AgentPart, AgentToolState, PermissionReply } from '../../../lib/types'
import type { OpenCodeV2SseEvent } from '../../opencode-v2/opencode-v2-client'
import { mapOpenCodeV2FormToQuestionRequest } from './v2-forms'
import {
  isOpenCodeV2SubagentTool,
  mapOpenCodeV2SubagentPart,
  reasoningPartId,
  stepPartId,
  textPartId,
  toolPartId,
  mapOpenCodeV2ToolState
} from './v2-messages'
import { mapOpenCodeV2Usage } from './v2-usage'
import { arrayValue, recordValue, stringValue } from './v2-values'

/**
 * Session-scoped state the mapper cannot derive from the event itself.
 *
 * V2 splits some information across events: tool results carry no tool name
 * (only `session.tool.input.started` does), and compaction deltas carry no
 * message id (only `session.compaction.started` does). The driver owns those
 * keys and hands them in, which keeps every mapping function pure.
 */
export interface OpenCodeV2EventContext {
  /** Assistant message currently streaming, when the driver knows it. */
  assistantMessageId?: string
  /** Message id the in-flight compaction writes to. */
  compactionMessageId?: string
  /** Tool name by call id, learned from `session.tool.input.started`. */
  toolNames?: ReadonlyMap<string, string>
}

/** The session an event belongs to, from its payload or its envelope. */
export function eventSessionId(event: OpenCodeV2SseEvent): string {
  return (
    stringValue(event.data['sessionID']) ??
    stringValue(recordValue(event.envelope['location'])?.['directory']) ??
    ''
  )
}

/** Assistant message id an event targets, when it carries one. */
export function eventAssistantMessageId(event: OpenCodeV2SseEvent): string | undefined {
  return stringValue(event.data['assistantMessageID'])
}

/** Read the numeric part ordinal of a text/reasoning event. */
function ordinalOf(data: Record<string, unknown>): number {
  const ordinal = data['ordinal']
  return typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : 0
}

/** The shared permission reply for a V2 `once` | `always` | `reject` decision. */
function permissionReply(value: unknown): PermissionReply {
  const reply = stringValue(value)
  return reply === 'always' || reply === 'reject' ? reply : 'once'
}

/**
 * One V2 tool call as a shared part. A `subagent` call becomes a sub-agent part
 * (so the UI shows the child agent) instead of a generic tool card.
 */
function toolPartFor(
  messageId: string,
  callId: string,
  tool: string,
  state: AgentToolState
): AgentPart {
  if (isOpenCodeV2SubagentTool(tool)) {
    return mapOpenCodeV2SubagentPart(messageId, callId, state)
  }
  return {
    type: 'tool',
    id: toolPartId(messageId, callId),
    messageID: messageId,
    callID: callId,
    tool,
    state
  }
}

/** Turn a compaction message into the shared compaction part event. */
function compactionEvent(
  sessionId: string,
  messageId: string,
  auto: boolean,
  summary?: string
): AgentEvent {
  return {
    type: 'message.part.updated',
    sessionId,
    part: {
      type: 'compaction',
      id: `${messageId}:compaction`,
      messageID: messageId,
      auto,
      ...(summary === undefined ? {} : { summary })
    }
  }
}

/**
 * Convert one V2 event into shared harness events.
 *
 * The turn's three terminal events (`session.execution.succeeded|failed|
 * interrupted`) are deliberately NOT mapped here: they need the driver's own
 * bookkeeping (which message the turn was writing to, and the last step's
 * error) to finalize a turn exactly once.
 */
export function mapOpenCodeV2Event(
  event: OpenCodeV2SseEvent,
  context: OpenCodeV2EventContext = {}
): AgentEvent[] {
  const data = event.data
  const sessionId = eventSessionId(event)
  switch (event.type) {
    case 'session.text.started':
    case 'session.reasoning.started': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      if (!messageId) return []
      const reasoning = event.type === 'session.reasoning.started'
      const id = reasoning
        ? reasoningPartId(messageId, ordinalOf(data))
        : textPartId(messageId, ordinalOf(data))
      return [
        reasoning
          ? {
              type: 'message.part.updated',
              sessionId,
              part: { type: 'reasoning', id, messageID: messageId, text: '' }
            }
          : {
              type: 'message.part.updated',
              sessionId,
              part: { type: 'text', id, messageID: messageId, text: '' }
            }
      ]
    }
    case 'session.text.delta':
    case 'session.reasoning.delta': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      if (!messageId) return []
      const reasoning = event.type === 'session.reasoning.delta'
      return [
        {
          type: 'message.part.delta',
          sessionId,
          messageId,
          partId: reasoning
            ? reasoningPartId(messageId, ordinalOf(data))
            : textPartId(messageId, ordinalOf(data)),
          field: 'text',
          delta: stringValue(data['delta']) ?? ''
        }
      ]
    }
    case 'session.text.ended':
    case 'session.reasoning.ended': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      if (!messageId) return []
      const reasoning = event.type === 'session.reasoning.ended'
      const text = stringValue(data['text']) ?? ''
      return [
        reasoning
          ? {
              type: 'message.part.updated',
              sessionId,
              part: {
                type: 'reasoning',
                id: reasoningPartId(messageId, ordinalOf(data)),
                messageID: messageId,
                text
              }
            }
          : {
              type: 'message.part.updated',
              sessionId,
              part: {
                type: 'text',
                id: textPartId(messageId, ordinalOf(data)),
                messageID: messageId,
                text
              }
            }
      ]
    }
    case 'session.step.started': {
      const messageId = eventAssistantMessageId(event)
      if (!messageId) return []
      return [
        {
          type: 'message.part.updated',
          sessionId,
          part: { type: 'step-start', id: stepPartId(messageId, 0), messageID: messageId }
        }
      ]
    }
    case 'session.step.ended': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      if (!messageId) return []
      const { aggregateTokens, normalizedUsage } = mapOpenCodeV2Usage(data['tokens'])
      const cost = typeof data['cost'] === 'number' ? data['cost'] : undefined
      const events: AgentEvent[] = []
      if (aggregateTokens || normalizedUsage) {
        events.push({
          type: 'usage.updated',
          sessionId,
          messageId,
          ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
          ...(normalizedUsage ? { normalizedUsage } : {}),
          ...(cost === undefined ? {} : { cost })
        })
      }
      events.push({
        type: 'message.part.updated',
        sessionId,
        part: {
          type: 'step-finish',
          id: `${messageId}:step-finish`,
          messageID: messageId,
          reason: stringValue(data['finish']) ?? '',
          ...(cost === undefined ? {} : { cost }),
          ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
          ...(normalizedUsage ? { normalizedUsage } : {})
        }
      })
      return events
    }
    case 'session.tool.input.started': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      const callId = stringValue(data['id'])
      if (!messageId || !callId) return []
      return [
        {
          type: 'message.part.updated',
          sessionId,
          part: toolPartFor(messageId, callId, stringValue(data['name']) ?? '', {
            status: 'pending',
            input: {}
          })
        }
      ]
    }
    case 'session.tool.input.ended':
    case 'session.tool.called':
    case 'session.tool.progress':
    case 'session.tool.success':
    case 'session.tool.failed': {
      const messageId = context.assistantMessageId ?? eventAssistantMessageId(event)
      const callId = stringValue(data['id'])
      if (!messageId || !callId) return []
      const completed = event.type === 'session.tool.success'
      const failed = event.type === 'session.tool.failed'
      const state = mapOpenCodeV2ToolState({
        status: completed ? 'completed' : failed ? 'error' : 'running',
        input:
          recordValue(data['input']) ??
          (typeof data['text'] === 'string' ? data['text'] : undefined),
        content: data['content'],
        error: data['error'],
        metadata: data['metadata'],
        executed: data['executed']
      })
      return [
        {
          type: 'message.part.updated',
          sessionId,
          part: toolPartFor(messageId, callId, context.toolNames?.get(callId) ?? '', state)
        }
      ]
    }
    case 'permission.asked': {
      const id = stringValue(data['id'])
      if (!id) return []
      return [
        {
          type: 'permission.asked',
          sessionId,
          permission: {
            id,
            sessionId,
            permission: stringValue(data['action']) ?? '',
            patterns: arrayValue(data['resources']).filter(
              (pattern): pattern is string => typeof pattern === 'string'
            ),
            metadata: {
              ...(recordValue(data['source']) ?? {}),
              ...(arrayValue(data['save']).length > 0 ? { save: data['save'] } : {}),
              ...(stringValue(data['message']) ? { message: data['message'] } : {})
            }
          }
        }
      ]
    }
    case 'permission.replied': {
      const requestId = stringValue(data['requestID'])
      if (!requestId) return []
      const reply = stringValue(data['reply'])
      return [
        {
          type: 'permission.replied',
          sessionId,
          requestId,
          reply: permissionReply(reply)
        }
      ]
    }
    case 'form.created': {
      const request = mapOpenCodeV2FormToQuestionRequest(recordValue(data['form']))
      if (!request) return []
      return [
        {
          type: 'question.asked',
          sessionId: request.sessionId,
          requestId: request.requestId,
          questions: request.questions,
          ...(request.tool ? { tool: request.tool } : {}),
          ...(request.metadata ? { metadata: request.metadata } : {})
        }
      ]
    }
    case 'form.replied': {
      const requestId = stringValue(data['id'])
      if (!requestId) return []
      const answer = recordValue(data['answer']) ?? {}
      return [
        {
          type: 'question.resolved',
          sessionId,
          requestId,
          resolution: 'answered',
          answers: Object.values(answer).map((value) => {
            if (Array.isArray(value)) {
              return value.filter((entry): entry is string => typeof entry === 'string')
            }
            return [String(value)]
          })
        }
      ]
    }
    case 'form.cancelled': {
      const requestId = stringValue(data['id'])
      if (!requestId) return []
      return [{ type: 'question.resolved', sessionId, requestId, resolution: 'dismissed' }]
    }
    case 'session.usage.updated': {
      const { aggregateTokens, normalizedUsage } = mapOpenCodeV2Usage(data['tokens'])
      if (!aggregateTokens && !normalizedUsage) return []
      const cost = typeof data['cost'] === 'number' ? data['cost'] : undefined
      return [
        {
          type: 'usage.updated',
          sessionId,
          messageId: context.assistantMessageId ?? '',
          ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
          ...(normalizedUsage ? { normalizedUsage } : {}),
          ...(cost === undefined ? {} : { cost })
        }
      ]
    }
    case 'session.compaction.started': {
      const messageId = stringValue(data['inputID']) ?? context.compactionMessageId
      if (!messageId) return []
      return [compactionEvent(sessionId, messageId, data['reason'] === 'auto')]
    }
    case 'session.compaction.delta': {
      const messageId = context.compactionMessageId
      if (!messageId) return []
      return [
        {
          type: 'message.part.delta',
          sessionId,
          messageId,
          partId: `${messageId}:compaction`,
          field: 'text',
          delta: stringValue(data['text']) ?? ''
        }
      ]
    }
    case 'session.compaction.ended': {
      const messageId = context.compactionMessageId
      if (!messageId) return []
      return [
        compactionEvent(sessionId, messageId, data['reason'] === 'auto', stringValue(data['text']))
      ]
    }
    case 'session.execution.started':
      return [{ type: 'session.status', sessionId, status: { state: 'working' } }]
    default:
      return []
  }
}
