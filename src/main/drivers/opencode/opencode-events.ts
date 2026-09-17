import type { AgentEvent, PermissionReply } from '../../../lib/types'
import { isOpenCodeAbortError, openCodeIssue } from './opencode-issues'
import { mapOpenCodePart } from './opencode-parts'
import { mapOpenCodeQuestionRequest } from './opencode-questions'
import { numberValue, recordValue, stringValue } from './opencode-values'

export function eventSessionId(props: Record<string, unknown>): string {
  const part = recordValue(props['part'])
  const info = recordValue(props['info'])
  return (
    stringValue(props['sessionID']) ??
    stringValue(part?.['sessionID']) ??
    stringValue(info?.['sessionID']) ??
    ''
  )
}

/**
 * Convert one OpenCode bus event into shared harness events.
 *
 * Keeping this boundary pure makes provider upgrades testable without starting
 * a CLI process or opening an SSE connection.
 */
export function mapOpenCodeEvent(type: string, props: Record<string, unknown>): AgentEvent[] {
  const sessionId = eventSessionId(props)
  switch (type) {
    case 'message.part.updated': {
      const part = mapOpenCodePart(props['part'])
      return part ? [{ type: 'message.part.updated', sessionId, part }] : []
    }
    case 'message.part.delta':
      return [
        {
          type: 'message.part.delta',
          sessionId,
          messageId: stringValue(props['messageID']) ?? '',
          partId: stringValue(props['partID']) ?? '',
          field: stringValue(props['field']) ?? 'text',
          delta: stringValue(props['delta']) ?? ''
        }
      ]
    case 'message.updated': {
      const info = recordValue(props['info'])
      const time = recordValue(info?.['time'])
      const error = info?.['error']
      if (!info || (typeof time?.['completed'] !== 'number' && !error)) {
        return []
      }
      const compaction = info['summary'] === true || info['mode'] === 'compaction'
      // An aborted compaction is transient maintenance noise: the conversation
      // is intact, it simply wasn't compacted. Drop the error so it never
      // surfaces as a session error or "aborted" banner.
      if (compaction && error && isOpenCodeAbortError(error)) {
        return [
          {
            type: 'message.completed',
            sessionId,
            messageId: stringValue(info['id']) ?? '',
            compaction: true
          }
        ]
      }
      const issue = error ? openCodeIssue(error, 'OpenCode message failed') : undefined
      const structuredOutput = info['structured'] ?? info['structured_output']
      return [
        {
          type: 'message.completed',
          sessionId,
          messageId: stringValue(info['id']) ?? '',
          error: issue?.message,
          ...(compaction ? { compaction: true } : {}),
          ...(structuredOutput === undefined ? {} : { structuredOutput }),
          ...(issue ? { issue } : {})
        }
      ]
    }
    case 'session.status': {
      const status = recordValue(props['status'])
      switch (status?.['type']) {
        case 'busy':
          return [{ type: 'session.status', sessionId, status: { state: 'working' } }]
        case 'idle':
          return [{ type: 'session.status', sessionId, status: { state: 'idle' } }]
        case 'retry': {
          const issue = openCodeIssue(status['message'], 'OpenCode is waiting to retry', {
            retryable: true,
            attempt: numberValue(status['attempt']),
            retryAt: numberValue(status['next'])
          })
          return [
            {
              type: 'session.status',
              sessionId,
              status: { state: 'waiting', issue }
            }
          ]
        }
        default:
          return []
      }
    }
    case 'session.idle':
      return [{ type: 'session.idle', sessionId }]
    case 'session.error': {
      // An aborted turn is not a session failure: the message-level error
      // already surfaced it, and an aborted compaction summarizer leaves the
      // conversation intact (it simply wasn't compacted). Emitting a session
      // error here would mark the session errored and show a scary "aborted"
      // banner on transient maintenance noise.
      if (isOpenCodeAbortError(props['error'])) {
        return []
      }
      const issue = openCodeIssue(props['error'], 'The OpenCode session failed')
      return [
        {
          type: 'session.error',
          sessionId,
          error: issue.message,
          issue
        }
      ]
    }
    case 'permission.asked':
      return [
        {
          type: 'permission.asked',
          sessionId,
          permission: {
            id: stringValue(props['id']) ?? '',
            sessionId,
            permission: stringValue(props['permission']) ?? '',
            patterns: Array.isArray(props['patterns'])
              ? props['patterns'].filter(
                  (pattern): pattern is string => typeof pattern === 'string'
                )
              : [],
            metadata: recordValue(props['metadata']) ?? {}
          }
        }
      ]
    case 'permission.replied':
      return [
        {
          type: 'permission.replied',
          sessionId,
          requestId: stringValue(props['requestID']) ?? '',
          reply: (props['reply'] as PermissionReply | undefined) ?? 'once'
        }
      ]
    case 'question.asked':
    case 'question.v2.asked': {
      const request = mapOpenCodeQuestionRequest(props)
      if (!request) return []
      return [
        {
          type: 'question.asked',
          sessionId: request.sessionId,
          requestId: request.requestId,
          questions: request.questions,
          tool: request.tool
        }
      ]
    }
    case 'question.replied':
    case 'question.v2.replied':
      return [
        {
          type: 'question.resolved',
          sessionId,
          requestId: stringValue(props['requestID']) ?? '',
          resolution: 'answered',
          answers: Array.isArray(props['answers'])
            ? props['answers'].map((answer) =>
                Array.isArray(answer)
                  ? answer.filter((value): value is string => typeof value === 'string')
                  : []
              )
            : undefined
        }
      ]
    case 'question.rejected':
    case 'question.v2.rejected':
      return [
        {
          type: 'question.resolved',
          sessionId,
          requestId: stringValue(props['requestID']) ?? '',
          resolution: 'dismissed'
        }
      ]
    default:
      return []
  }
}
