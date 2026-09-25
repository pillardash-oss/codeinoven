import type { AgentMessage, AgentPart, AgentToolState } from '../../../lib/types'
import { isOpenCodeV2AbortError, openCodeV2ErrorMessage } from './v2-issues'
import { mapOpenCodeV2Usage } from './v2-usage'
import {
  arrayValue,
  booleanValue,
  numberValue,
  recordFromUnknown,
  recordValue,
  stringValue,
  toolContentText
} from './v2-values'

/** Part id of the n-th text block of one assistant message. */
export function textPartId(messageId: string, ordinal: number): string {
  return `${messageId}:text:${ordinal}`
}

/** Part id of the n-th reasoning block of one assistant message. */
export function reasoningPartId(messageId: string, ordinal: number): string {
  return `${messageId}:reasoning:${ordinal}`
}

/** Part id of one tool call, stable across the streaming and persisted forms. */
export function toolPartId(messageId: string, callId: string): string {
  return `${messageId}:tool:${callId}`
}

/** Part id of a step boundary marker. */
export function stepPartId(messageId: string, ordinal: number): string {
  return `${messageId}:step:${ordinal}`
}

/** V2 tool names that represent a delegated child agent. */
const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'task'])

/** True when a V2 tool name is a delegated sub-agent invocation. */
export function isOpenCodeV2SubagentTool(tool: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(tool.toLowerCase())
}

/**
 * Map a V2 `subagent` tool call to the shared sub-agent part.
 *
 * V2 reports a delegated child agent as an ordinary tool named `subagent`; the
 * child session id arrives on the tool result's `metadata.sessionID`, and the
 * launch arguments carry the agent id, description, and prompt. Mapping it to a
 * sub-agent part instead of a generic tool card is what lets the UI show the
 * child agent, and matches how the V1 transport reports `task`.
 */
export function mapOpenCodeV2SubagentPart(
  messageId: string,
  callId: string,
  state: AgentToolState
): AgentPart {
  const input = state.input
  const metadata = recordValue(state.metadata) ?? {}
  const prompt = stringValue(input['prompt'])
  const childSessionId =
    stringValue(metadata['sessionID']) ??
    stringValue(input['session_id']) ??
    stringValue(input['task_id'])
  const model = recordValue(metadata['model'])
  const providerId = stringValue(model?.['providerID'])
  const modelId = stringValue(model?.['modelID'])
  return {
    type: 'subagent',
    id: toolPartId(messageId, callId),
    messageID: messageId,
    callID: callId,
    activity: {
      status: state.status,
      agent: stringValue(input['agent']) ?? stringValue(input['subagent_type']) ?? '',
      description: stringValue(input['description']) ?? state.title ?? 'Delegated task',
      ...(prompt === undefined ? {} : { prompt }),
      ...(childSessionId === undefined ? {} : { childSessionId }),
      ...(providerId === undefined ? {} : { providerId }),
      ...(modelId === undefined ? {} : { modelId }),
      background: metadata['background'] === true || input['background'] === true,
      ...(state.output === undefined ? {} : { output: state.output }),
      ...(state.error === undefined ? {} : { error: state.error }),
      ...(state.time === undefined ? {} : { time: state.time })
    }
  }
}

/**
 * Map a V2 `ToolState` onto the shared tool state.
 *
 * V2 streams a tool call as `{status:"streaming", input: <raw JSON string>}`
 * and then as `{status:"running", input: {…}}`, completing with the tool's
 * content blocks. A partially streamed argument string is preserved in
 * `metadata.streamingInput` so an unparsable prefix is never rendered as an
 * empty input.
 */
export function mapOpenCodeV2ToolState(raw: unknown): AgentToolState {
  const state = recordValue(raw) ?? {}
  const status = stringValue(state['status']) ?? ''
  const rawInput = state['input']
  const parsedInput = recordFromUnknown(rawInput)
  const metadata: Record<string, unknown> = { ...(recordValue(state['metadata']) ?? {}) }
  const executed = booleanValue(state['executed'])
  if (executed !== undefined) metadata['executed'] = executed
  if (typeof rawInput === 'string' && parsedInput === undefined) {
    metadata['streamingInput'] = rawInput
  }
  const agentStatus: AgentToolState['status'] =
    status === 'completed'
      ? 'completed'
      : status === 'error'
        ? 'error'
        : status === 'streaming' || status === 'running'
          ? 'running'
          : 'pending'
  const output = toolContentText(state['content'])
  const time = recordValue(state['time'])
  const start = numberValue(time?.['created'])
  const end = numberValue(time?.['completed'])
  return {
    status: agentStatus,
    input: parsedInput ?? {},
    ...(output === undefined ? {} : { output }),
    ...(agentStatus === 'error'
      ? { error: openCodeV2ErrorMessage(state['error']) ?? 'Tool call failed' }
      : {}),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
    ...(start === undefined ? {} : { time: { start, end: end === undefined ? undefined : end } })
  }
}

/** Running per-type block counters, so live and persisted part ids agree. */
interface PartOrdinals {
  text: number
  reasoning: number
}

/** One assistant content block, mapped to its shared part. */
function mapAssistantContent(
  block: unknown,
  messageId: string,
  ordinals: PartOrdinals
): AgentPart | null {
  const record = recordValue(block)
  const type = stringValue(record?.['type'])
  if (!record || !type) return null
  switch (type) {
    case 'text': {
      const ordinal = ordinals.text
      ordinals.text += 1
      return {
        type: 'text',
        id: textPartId(messageId, ordinal),
        messageID: messageId,
        text: stringValue(record['text']) ?? ''
      }
    }
    case 'reasoning': {
      const ordinal = ordinals.reasoning
      ordinals.reasoning += 1
      const partTime = recordValue(record['time'])
      const start = numberValue(partTime?.['created'])
      const end = numberValue(partTime?.['completed'])
      const summary = stringValue(record['summary'])
      return {
        type: 'reasoning',
        id: reasoningPartId(messageId, ordinal),
        messageID: messageId,
        text: stringValue(record['text']) ?? '',
        ...(summary ? { summary } : {}),
        ...(start === undefined && end === undefined
          ? {}
          : {
              time: {
                start: start === undefined ? undefined : start,
                end: end === undefined ? undefined : end
              }
            })
      }
    }
    case 'tool': {
      const callId = stringValue(record['id']) ?? ''
      const state = mapOpenCodeV2ToolState(record['state'])
      const toolTime = recordValue(record['time'])
      const start = numberValue(toolTime?.['created'])
      const end = numberValue(toolTime?.['completed'])
      const withTime: AgentToolState =
        state.time === undefined && start !== undefined
          ? { ...state, time: { start, end: end === undefined ? undefined : end } }
          : state
      const name = stringValue(record['name']) ?? ''
      if (isOpenCodeV2SubagentTool(name)) {
        return mapOpenCodeV2SubagentPart(messageId, callId, withTime)
      }
      return {
        type: 'tool',
        id: toolPartId(messageId, callId),
        messageID: messageId,
        callID: callId,
        tool: name,
        state: withTime
      }
    }
    default:
      return null
  }
}

/** Map a V2 assistant message's inline `content` array into shared parts. */
export function mapOpenCodeV2AssistantContent(messageId: string, content: unknown): AgentPart[] {
  const ordinals: PartOrdinals = { text: 0, reasoning: 0 }
  return arrayValue(content)
    .map((block) => mapAssistantContent(block, messageId, ordinals))
    .filter((part): part is AgentPart => part !== null)
}

/** One V2 file attachment, mapped to a shared file part. */
function mapFilePart(file: unknown, messageId: string, index: number): AgentPart | null {
  const record = recordValue(file)
  if (!record) return null
  const source = recordValue(record['source'])
  const uri = stringValue(record['uri']) ?? stringValue(source?.['uri']) ?? ''
  const name = stringValue(record['name'])
  return {
    type: 'file',
    id: `${messageId}:file:${index}`,
    messageID: messageId,
    mime: stringValue(record['mime']) ?? '',
    url: uri,
    ...(name ? { filename: name } : {})
  }
}

/**
 * Wrap a V2 non-user context message (synthetic/system/skill) so it stays in
 * the transcript's transport layer without ever rendering as a user turn.
 */
function hiddenContextMessage(id: string, createdAt: number, text: string): AgentMessage {
  const part: AgentPart = { type: 'text', id: textPartId(id, 0), messageID: id, text }
  return {
    id,
    role: 'user',
    origin: 'harness',
    visibility: 'hidden',
    parts: [],
    transportParts: [part],
    transportOrigin: 'harness',
    createdAt
  }
}

/** Map a V2 compaction message into the shared compaction-only message. */
function mapCompactionMessage(
  record: Record<string, unknown>,
  id: string,
  createdAt: number
): AgentMessage {
  const status = stringValue(record['status']) ?? ''
  const summary = stringValue(record['summary'])
  const { aggregateTokens, normalizedUsage } = mapOpenCodeV2Usage(record['tokens'])
  const model = recordValue(record['model'])
  const cost = numberValue(record['cost'])
  const modelId = stringValue(model?.['id'])
  const providerId = stringValue(model?.['providerID'])
  const part: AgentPart = {
    type: 'compaction',
    id: `${id}:compaction`,
    messageID: id,
    auto: record['reason'] === 'auto',
    ...(summary === undefined ? {} : { summary })
  }
  return {
    id,
    role: 'assistant',
    origin: 'compaction',
    visibility: 'working_trace',
    parts: [part],
    ...(modelId ? { modelId } : {}),
    ...(providerId ? { providerId } : {}),
    createdAt,
    ...(status === 'completed' || status === 'failed' ? { completedAt: createdAt } : {}),
    ...(cost === undefined ? {} : { cost }),
    ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
    ...(normalizedUsage ? { normalizedUsage } : {}),
    ...(status === 'failed'
      ? { error: openCodeV2ErrorMessage(record['error']) ?? 'Context compaction failed' }
      : {})
  }
}

/**
 * Map one persisted V2 message into the shared message shape.
 *
 * V2 has no separate part model: an assistant message carries its parts inline
 * in `content[]`, so the message boundary is where the mapping happens. Messages
 * that carry no conversation (`idle`, agent/model switches, shell records) map
 * to `null`.
 */
export function mapOpenCodeV2Message(raw: unknown): AgentMessage | null {
  const record = recordValue(raw)
  const id = stringValue(record?.['id'])
  const type = stringValue(record?.['type'])
  if (!record || !id || !type) return null
  const time = recordValue(record['time'])
  const createdAt = numberValue(time?.['created']) ?? 0
  const completedAt = numberValue(time?.['completed'])

  switch (type) {
    case 'user': {
      const parts: AgentPart[] = [
        {
          type: 'text',
          id: textPartId(id, 0),
          messageID: id,
          text: stringValue(record['text']) ?? ''
        }
      ]
      const files = arrayValue(record['files'])
        .map((file, index) => mapFilePart(file, id, index))
        .filter((part): part is AgentPart => part !== null)
      return { id, role: 'user', parts: [...parts, ...files], createdAt }
    }
    case 'assistant': {
      const model = recordValue(record['model'])
      const { aggregateTokens, normalizedUsage } = mapOpenCodeV2Usage(record['tokens'])
      const cost = numberValue(record['cost'])
      const modelId = stringValue(model?.['id'])
      const providerId = stringValue(model?.['providerID'])
      // An interrupt is not a failure: the user stopped the turn on purpose, so
      // it must not surface as an error card on the message they cancelled.
      const messageError = isOpenCodeV2AbortError(record['error'])
        ? undefined
        : openCodeV2ErrorMessage(record['error'])
      return {
        id,
        role: 'assistant',
        parts: mapOpenCodeV2AssistantContent(id, record['content']),
        ...(modelId ? { modelId } : {}),
        ...(providerId ? { providerId } : {}),
        createdAt,
        ...(completedAt === undefined ? {} : { completedAt }),
        ...(cost === undefined ? {} : { cost }),
        ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
        ...(normalizedUsage ? { normalizedUsage } : {}),
        ...(messageError === undefined ? {} : { error: messageError })
      }
    }
    case 'synthetic':
    case 'system':
    case 'skill':
      return hiddenContextMessage(id, createdAt, stringValue(record['text']) ?? '')
    case 'compaction':
      return mapCompactionMessage(record, id, createdAt)
    default:
      return null
  }
}

/**
 * Map a `GET /api/session/{id}/message` page into shared messages, oldest
 * first. The endpoint returns `{data, cursor}`; a bare array is also accepted
 * so the mapper can be used against a single-message read.
 */
export function mapOpenCodeV2Messages(payload: unknown): AgentMessage[] {
  const entries = Array.isArray(payload) ? payload : arrayValue(recordValue(payload)?.['data'])
  return entries
    .map((entry) => mapOpenCodeV2Message(entry))
    .filter((message): message is AgentMessage => message !== null)
}

/** The message ids of one V2 message page, in the order they were returned. */
export function openCodeV2MessageIds(payload: unknown): string[] {
  const entries = Array.isArray(payload) ? payload : arrayValue(recordValue(payload)?.['data'])
  return entries
    .map((entry) => stringValue(recordValue(entry)?.['id']))
    .filter((id): id is string => id !== undefined)
}
