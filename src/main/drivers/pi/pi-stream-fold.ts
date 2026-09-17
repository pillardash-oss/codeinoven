import type {
  AgentMessage,
  AgentPart,
  AgentToolStatus,
  SessionAgentEvent
} from '../../../lib/types'
import { parseRecord } from '../../../lib/agent-interactions'
import {
  classifyProviderIssue,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'
import type { CliLineParseResult } from '../persistent-cli-driver'
import { isContinuableFinishReasonError, isOversizedRequestError } from './pi-errors'
import {
  CIO_SPAWN_TOOL,
  cioSubagentPart,
  findSubagentPart,
  parseSubagentPayload,
  spawnDoneCustomEvent,
  spawnFailurePatch,
  subagentActivityFromPayload,
  subagentTimeRange
} from './pi-subagent'
import { mapPiCost, mapPiNormalizedUsage, mapPiUsage } from './pi-usage'
import type { PiStreamContext, PiTurnState } from './pi-stream-types'
import { errorText, messageTimestamp, numberValue, record, stringValue } from './pi-values'

/** Maps one documented Pi JSON record into CodeInOven's stable stream shapes. */

/** Map one Pi content block into a CodeInOven AgentPart. */
function mapPiContentBlock(
  blockValue: unknown,
  messageId: string,
  index: number,
  callID: string
): AgentPart | null {
  const block = record(blockValue)
  if (!block) return null
  const type = stringValue(block['type'])
  if (type === 'text') {
    return {
      type: 'text',
      id: `${messageId}:text:${index}`,
      messageID: messageId,
      text: stringValue(block['text']) ?? ''
    }
  }
  if (type === 'thinking') {
    const summary = stringValue(block['summary'])
    return {
      type: 'reasoning',
      id: `${messageId}:reasoning:${index}`,
      messageID: messageId,
      text: stringValue(block['thinking']) ?? '',
      ...(summary ? { summary } : {})
    }
  }
  if (type === 'toolCall') {
    if (stringValue(block['name']) === CIO_SPAWN_TOOL) {
      return cioSubagentPart(messageId, callID, record(block['arguments']))
    }
    return {
      type: 'tool',
      id: `${messageId}:tool:${callID}`,
      messageID: messageId,
      callID,
      tool: stringValue(block['name']) ?? 'tool',
      state: {
        status: 'pending',
        input: record(block['arguments']) ?? {}
      }
    }
  }
  return null
}

function toolCallId(blockValue: unknown): string {
  const block = record(blockValue)
  return stringValue(block?.['id']) ?? ''
}

/** Serialize the `content` of a Pi message or tool result into plain text. */
function serializeContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (typeof entry === 'string') return entry
        const item = record(entry)
        return (
          stringValue(item?.['text']) ?? stringValue(item?.['thinking']) ?? JSON.stringify(item)
        )
      })
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
    return text || undefined
  }
  return undefined
}

/** Find the running tool part for a call id so results preserve its input. */
function findToolPart(
  context: PiStreamContext,
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

/**
 * The minimum a Pi record mapper needs from its host: the app session id the
 * produced events belong to, plus the transcript accumulated so far so tool
 * results and sub-agent cards correlate with the parts that opened them. A
 * root turn passes its CLI session record; a delegated child session (which
 * has no app session record of its own) passes a plain message list.
 */

/**
 * Announce a streamed text/reasoning part with an empty placeholder
 * `message.part.updated` before its first delta. Pi's RPC stream emits
 * `message.part.delta` records without ever publishing the part they append
 * to (`message_start` carries no parts), and every downstream mirror drops
 * deltas for a part that does not exist yet   so pi's streaming text and
 * reasoning never appeared live and the working trace stayed empty until
 * `message_end`, with the final output often beating any visible trace.
 * The claude-code and codex drivers announce parts up front
 * (`content_block_start` / `item.started`); this gives pi the same behavior.
 */
function announceStreamPart(
  sessionId: string,
  turnState: PiTurnState,
  part: AgentPart
): SessionAgentEvent[] {
  let announced = turnState.announcedStreamParts
  if (!announced) {
    announced = new Set<string>()
    turnState.announcedStreamParts = announced
  }
  if (announced.has(part.id)) return []
  announced.add(part.id)
  return [{ type: 'message.part.updated', sessionId, part }]
}

/** Highest driver-generated assistant index already present for this app
 *  session. Pi's RPC process restarts its own turn counter when an old native
 *  transcript is resumed, but CodeInOven message and part IDs must remain
 *  unique across the full persisted session. */
function latestPiTurnIndex(messages: readonly AgentMessage[], sessionId: string): number {
  const prefix = `pi-${sessionId}-`
  let latest = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id.startsWith(prefix)) continue
    const suffix = message.id.slice(prefix.length)
    if (!/^\d+$/u.test(suffix)) continue
    const index = Number(suffix)
    if (Number.isSafeInteger(index)) latest = Math.max(latest, index)
  }
  return latest
}

/** Map one documented Pi JSON print-mode record into CodeInOven's stable shapes. */
export function mapPiRecord(
  value: unknown,
  context: PiStreamContext,
  turnState: PiTurnState
): CliLineParseResult | null {
  const entry = record(value)
  if (!entry) return null
  const type = stringValue(entry['type'])

  if (type === 'turn_start') {
    turnState.turnIndex += 1
    turnState.assistantMessageId = null
    turnState.announcedStreamParts?.clear()
    return { events: [] }
  }

  if (type === 'message_start' && entry['message']) {
    const message = record(entry['message'])
    if (message?.['role'] === 'assistant') {
      turnState.assistantMessageId = `pi-${context.sessionId}-${turnState.turnIndex}`
    }
    return { events: [] }
  }

  if (type === 'message_update') {
    const message = record(entry['message'])
    const event = record(entry['assistantMessageEvent'])
    const messageId =
      stringValue(message?.['id']) ??
      turnState.assistantMessageId ??
      `pi-${context.sessionId}-${turnState.turnIndex}`
    const eventType = stringValue(event?.['type'])
    const contentIndex = numberValue(event?.['contentIndex']) ?? 0
    if (eventType === 'text_delta') {
      const delta = stringValue(event?.['delta'])
      if (!delta) return { events: [] }
      const partId = `${messageId}:text:${contentIndex}`
      return {
        events: [
          ...announceStreamPart(context.sessionId, turnState, {
            type: 'text',
            id: partId,
            messageID: messageId,
            text: ''
          }),
          {
            type: 'message.part.delta',
            sessionId: context.sessionId,
            messageId,
            partId,
            field: 'text',
            delta
          }
        ]
      }
    }
    if (eventType === 'thinking_delta') {
      const delta = stringValue(event?.['delta'])
      if (!delta) return { events: [] }
      const partId = `${messageId}:reasoning:${contentIndex}`
      return {
        events: [
          ...announceStreamPart(context.sessionId, turnState, {
            type: 'reasoning',
            id: partId,
            messageID: messageId,
            text: ''
          }),
          {
            type: 'message.part.delta',
            sessionId: context.sessionId,
            messageId,
            partId,
            field: 'text',
            delta
          }
        ]
      }
    }
    return { events: [] }
  }

  if (type === 'message_end' && entry['message']) {
    const message = record(entry['message'])
    if (message?.['role'] === 'custom') return spawnDoneCustomEvent(message, context)
    if (message?.['role'] !== 'assistant') return { events: [] }
    return buildAssistantMessage(message, context.sessionId, turnState)
  }

  if (type === 'tool_execution_start' || type === 'tool_execution_update') {
    const callId = stringValue(entry['toolCallId'])
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    if (!callId) return { events: [] }
    const toolName = stringValue(entry['toolName']) ?? 'tool'
    const partialResult = record(entry['partialResult'])
    const partialOutput = serializeContent(partialResult?.['content'])
    if (toolName === CIO_SPAWN_TOOL) {
      const args = record(entry['args'])
      const existing = findSubagentPart(context, callId)
      const base = existing?.activity ?? cioSubagentPart(messageId, callId, args).activity
      const payloadPatch =
        type === 'tool_execution_update' ? parseSubagentPayload(partialOutput) : undefined
      return {
        events: [
          {
            type: 'message.part.updated',
            sessionId: context.sessionId,
            part: {
              type: 'subagent',
              id: existing?.id ?? `pi-subagent-${callId}`,
              messageID: existing?.messageID ?? messageId,
              callID: callId,
              activity: {
                ...base,
                ...(payloadPatch ?? {}),
                status: payloadPatch?.status ?? 'running',
                background: base.background,
                time: base.time ?? { start: Date.now() }
              }
            }
          }
        ]
      }
    }
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'tool',
            id: `${messageId}:tool:${callId}`,
            messageID: messageId,
            callID: callId,
            tool: toolName,
            state: {
              status: 'running',
              input: record(entry['args']) ?? {},
              ...(partialOutput ? { output: partialOutput } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'tool_execution_end') {
    const callId = stringValue(entry['toolCallId'])
    const messageId =
      turnState.assistantMessageId ?? `pi-${context.sessionId}-${turnState.turnIndex}`
    if (!callId) return { events: [] }
    const toolName = stringValue(entry['toolName']) ?? 'tool'
    const failed = entry['isError'] === true
    const result = record(entry['result'])
    const output = serializeContent(result?.['content']) ?? stringValue(result?.['text'])
    if (toolName === CIO_SPAWN_TOOL) {
      const existing = findSubagentPart(context, callId)
      const base =
        existing?.activity ?? cioSubagentPart(messageId, callId, record(entry['args'])).activity
      // The final result carries the full structured sub-agent payload.
      const payloadPatch = subagentActivityFromPayload(parseRecord(output ?? ''))
      const failurePatch = payloadPatch ? undefined : spawnFailurePatch(output)
      const status: AgentToolStatus = failed
        ? 'error'
        : (payloadPatch?.status ?? failurePatch?.status ?? 'completed')
      return {
        events: [
          {
            type: 'message.part.updated',
            sessionId: context.sessionId,
            part: {
              type: 'subagent',
              id: existing?.id ?? `pi-subagent-${callId}`,
              messageID: existing?.messageID ?? messageId,
              callID: callId,
              activity: {
                ...base,
                ...(payloadPatch ?? failurePatch ?? {}),
                status,
                background: base.background,
                time: subagentTimeRange(base, status)
              }
            }
          }
        ]
      }
    }
    // The end event may not repeat `args`; never wipe the input captured at start.
    const existing = findToolPart(context, callId)
    const endArgs = record(entry['args'])
    const input =
      endArgs && Object.keys(endArgs).length > 0 ? endArgs : (existing?.state.input ?? {})
    return {
      events: [
        {
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'tool',
            id: `${messageId}:tool:${callId}`,
            messageID: messageId,
            callID: callId,
            tool: toolName,
            state: {
              status: failed ? 'error' : 'completed',
              input,
              ...(output ? { output } : {}),
              ...(failed ? { error: stringValue(result?.['error']) } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'turn_end' && entry['message']) {
    const rawMessage = record(entry['message'])
    if (!rawMessage) return { events: [] }
    const message = rawMessage
    const messageId =
      stringValue(message?.['id']) ??
      turnState.assistantMessageId ??
      `pi-${context.sessionId}-${turnState.turnIndex}`
    const events: SessionAgentEvent[] = []
    const toolResults = Array.isArray(entry['toolResults']) ? entry['toolResults'] : []
    for (const resultValue of toolResults) {
      const result = record(resultValue)
      const callId = stringValue(result?.['toolCallId'])
      if (!callId) continue
      const failed = result?.['isError'] === true
      const output = serializeContent(result?.['content'])
      const existingToolPart = findToolPart(context, callId)
      if ((stringValue(result?.['toolName']) ?? existingToolPart?.tool) === CIO_SPAWN_TOOL) {
        const existingSubagent = findSubagentPart(context, callId)
        const base =
          existingSubagent?.activity ?? cioSubagentPart(messageId, callId, undefined).activity
        const payloadPatch = subagentActivityFromPayload(parseRecord(output ?? ''))
        const failurePatch = payloadPatch ? undefined : spawnFailurePatch(output)
        const status: AgentToolStatus = failed
          ? 'error'
          : (payloadPatch?.status ?? failurePatch?.status ?? 'completed')
        events.push({
          type: 'message.part.updated',
          sessionId: context.sessionId,
          part: {
            type: 'subagent',
            id: existingSubagent?.id ?? `pi-subagent-${callId}`,
            messageID: existingSubagent?.messageID ?? messageId,
            callID: callId,
            activity: {
              ...base,
              ...(payloadPatch ?? failurePatch ?? {}),
              status,
              background: base.background,
              time: subagentTimeRange(base, status)
            }
          }
        })
        continue
      }
      const existing = existingToolPart
      events.push({
        type: 'message.part.updated',
        sessionId: context.sessionId,
        part: {
          type: 'tool',
          id: existing?.id ?? `${messageId}:tool:${callId}`,
          messageID: existing?.messageID ?? messageId,
          callID: callId,
          tool: existing?.tool ?? stringValue(result?.['toolName']) ?? 'tool',
          state: {
            status: failed ? 'error' : 'completed',
            input: existing?.state.input ?? {},
            ...(output ? { output } : {}),
            ...(failed ? { error: serializeContent(result?.['content']) } : {})
          }
        }
      })
    }
    const usage = mapPiUsage(message['usage'])
    const normalizedUsage = mapPiNormalizedUsage(message['usage'])
    const cost = mapPiCost(message['usage'])
    const rawError = errorText(message)
    const continuable =
      message['stopReason'] === 'error' &&
      (isContinuableFinishReasonError(rawError) || isOversizedRequestError(rawError))
    const failed =
      (message['stopReason'] === 'error' && !continuable) || message['stopReason'] === 'aborted'
    const completed: SessionAgentEvent = {
      type: 'message.completed',
      sessionId: context.sessionId,
      messageId,
      ...(usage ? { tokens: usage } : {}),
      ...(normalizedUsage ? { normalizedUsage } : {}),
      ...(cost !== undefined ? { cost } : {}),
      // A continuable finish-reason flake is neutralized here; the driver
      // reads the marker back when deciding whether to silently re-prompt.
      ...(continuable ? { silentContinue: { error: rawError } } : failed ? { error: rawError } : {})
    }
    events.push(completed)
    return { events }
  }

  if (
    type === 'compaction_start' ||
    type === 'compaction_end' ||
    type === 'auto_compaction_start' ||
    type === 'auto_compaction_end'
  ) {
    const result = record(entry['result'])
    const summary =
      type.endsWith('_end') && entry['aborted'] !== true
        ? stringValue(result?.['summary'])
        : undefined
    const messageId = `pi-${context.sessionId}-compaction-${turnState.turnIndex}`
    const part: AgentPart = {
      type: 'compaction',
      id: `${messageId}:compaction`,
      messageID: messageId,
      auto:
        type.startsWith('auto_') ||
        entry['reason'] === 'threshold' ||
        entry['reason'] === 'overflow',
      ...(summary?.trim()
        ? {
            summary,
            firstKeptEntryId: stringValue(result?.['firstKeptEntryId']),
            firstKeptCreatedAt: numberValue(entry['firstKeptCreatedAt'])
          }
        : {})
    }
    return {
      messages: [
        {
          id: messageId,
          role: 'assistant',
          origin: 'compaction',
          visibility: 'working_trace',
          createdAt: Date.now(),
          parts: [part]
        }
      ],
      events: [
        { type: 'message.part.updated', sessionId: context.sessionId, part },
        ...(type.endsWith('_end')
          ? [
              {
                type: 'message.completed' as const,
                sessionId: context.sessionId,
                messageId,
                compaction: true
              }
            ]
          : [])
      ]
    }
  }

  if (type === 'auto_retry_start') {
    const message = stringValue(entry['errorMessage']) ?? 'Pi is waiting to retry'
    // When the retry is driven by a usage window, the message carries a
    // parseable reset so the card can show a concrete countdown and the
    // scheduler can resume at the right moment instead of guessing.
    const retryAt = parseUsageResetAt(message)
    return {
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'waiting',
            issue: {
              kind: 'provider_unavailable',
              message,
              harnessId: 'pi',
              retryable: true,
              ...(retryAt === undefined ? {} : { retryAt })
            }
          }
        }
      ]
    }
  }

  if (type === 'auto_retry_end') {
    const success = entry['success'] === true
    if (success) {
      return {
        events: [
          {
            type: 'session.status',
            sessionId: context.sessionId,
            status: { state: 'working' }
          }
        ]
      }
    }
    const finalError =
      stringValue(entry['finalError']) ?? stringValue(entry['errorMessage']) ?? 'Pi retries failed'
    // An oversized request body is claimed by the driver's compact-and-continue
    // recovery (armed stripping + re-prompt)   surfacing it here would flash an
    // error card on every recovery attempt before the turn resumes. The
    // terminal failure after the recovery cap still surfaces via the claimed
    // message.completed error, so nothing is hidden permanently.
    if (isOversizedRequestError(finalError)) return { events: [] }
    // When the retries were exhausted against a usage window, the final error
    // still classifies as a reset wait   surface it with a concrete retryAt so
    // the engine converts it into the will-retry card and auto-resumes later,
    // instead of parking the thread on a terminal error.
    const kind = classifyProviderIssue(finalError)
    const { message } = presentProviderError(finalError)
    const retryAt =
      kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
    return {
      events: [
        {
          type: 'session.status',
          sessionId: context.sessionId,
          status: {
            state: 'error',
            issue: {
              kind,
              message,
              rawError: finalError,
              harnessId: 'pi',
              retryable: retryAt !== undefined,
              ...(retryAt === undefined ? {} : { retryAt }),
              ...(numberValue(entry['attempt']) ? { attempt: numberValue(entry['attempt']) } : {})
            }
          }
        }
      ]
    }
  }

  if (type === 'agent_settled') {
    const session = context.session
    const lastAssistant = [...session.messages].reverse().find((message) => {
      return message.role === 'assistant'
    })
    if (lastAssistant?.error) {
      // Oversized request bodies are driver-recoverable (silent compact,
      // arm stripping, re-prompt); surfacing them here would flash an error
      // card after every compaction before the turn resumes. The recovery-cap
      // terminal failure still surfaces through the claimed message.completed
      // error, so a permanently oversized request is never hidden.
      if (isOversizedRequestError(lastAssistant.error)) return { events: [] }
      const kind = classifyProviderIssue(lastAssistant.error)
      const { message } = presentProviderError(lastAssistant.error)
      const retryAt =
        kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
      return {
        events: [
          {
            type: 'session.status',
            sessionId: context.sessionId,
            status: {
              state: 'error',
              issue: {
                kind,
                message,
                rawError: lastAssistant.error,
                harnessId: 'pi',
                retryable: retryAt !== undefined,
                ...(retryAt === undefined ? {} : { retryAt })
              }
            }
          }
        ]
      }
    }
    return { events: [] }
  }

  if (type === 'extension_error') {
    return {
      events: [
        {
          type: 'session.error',
          sessionId: context.sessionId,
          error: stringValue(entry['error']) ?? 'A Pi extension failed'
        }
      ]
    }
  }

  if (type === 'agent_end') {
    // Never finalize here: a transient failure is followed by `auto_retry_start`.
    // Only `agent_settled` signals that no retry or queued continuation remains.
    return { events: [] }
  }

  return { events: [] }
}

/** Build the full assistant message and its part events from a Pi message object. */
function buildAssistantMessage(
  message: Record<string, unknown>,
  sessionId: string,
  turnState: PiTurnState
): CliLineParseResult | null {
  const content = Array.isArray(message['content']) ? message['content'] : []
  const messageId = `pi-${sessionId}-${turnState.turnIndex}`
  const now = messageTimestamp(message)
  const parts: AgentPart[] = []
  const events: SessionAgentEvent[] = []
  content.forEach((blockValue, index) => {
    const callId = toolCallId(blockValue) || `call-${index}`
    const part = mapPiContentBlock(blockValue, messageId, index, callId)
    if (!part) return
    parts.push(part)
    events.push({ type: 'message.part.updated', sessionId, part })
  })
  const usage = mapPiUsage(message['usage'])
  const normalizedUsage = mapPiNormalizedUsage(message['usage'])
  const cost = mapPiCost(message['usage'])
  const rawError = errorText(message)
  const continuableError =
    message['stopReason'] === 'error' &&
    (isContinuableFinishReasonError(rawError) || isOversizedRequestError(rawError))
      ? rawError
      : null
  const failed =
    (message['stopReason'] === 'error' && continuableError === null) ||
    message['stopReason'] === 'aborted'
  const completed: AgentMessage = {
    id: messageId,
    role: 'assistant',
    parts,
    createdAt: now,
    harnessId: 'pi',
    modelId: stringValue(message['model']),
    providerId: stringValue(message['provider']),
    ...(usage ? { tokens: usage } : {}),
    ...(normalizedUsage ? { normalizedUsage } : {}),
    ...(cost !== undefined ? { cost } : {}),
    // A continuable finish-reason flake must not mark the mirrored message as
    // failed: the driver silently re-prompts and the turn keeps going.
    ...(failed ? { error: rawError } : {})
  }
  return { events, messages: [completed] }
}

export { latestPiTurnIndex, buildAssistantMessage, serializeContent }
