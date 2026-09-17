import type {
  AgentMessage,
  AgentPart,
  AgentSubagentActivity,
  AgentToolState
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import {
  extractQuestionAnswer,
  extractQuestionPrompt,
  mapOpenCodeQuestions
} from './opencode-questions'
import { mapOpenCodeUsage } from './opencode-usage'
import { recordFromUnknown, recordValue, stringValue, textValue } from './opencode-values'

export function mapOpenCodeToolState(raw: unknown): AgentToolState {
  const state = recordValue(raw) ?? {}
  const time = recordValue(state['time'])
  const start = time?.['start']
  const end = time?.['end']
  return {
    status: (state['status'] as AgentToolState['status'] | undefined) ?? 'pending',
    input: recordFromUnknown(state['input']) ?? {},
    title: stringValue(state['title']),
    output: stringValue(state['output']),
    error: stringValue(state['error']),
    metadata: recordValue(state['metadata']),
    time:
      typeof start === 'number'
        ? { start, end: typeof end === 'number' ? end : undefined }
        : undefined
  }
}

export type OpenCodeAgentPart = AgentPart
export type OpenCodeAgentMessage = AgentMessage

interface OpenCodeTaskEnvelope {
  id: string
  state: 'running' | 'completed' | 'error'
  summary?: string
  text: string
}

function parseOpenCodeTaskEnvelope(value: unknown): OpenCodeTaskEnvelope | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.match(
    /^<task id="([^"]+)" state="(running|completed|error)">\n(?:<summary>([\s\S]*?)<\/summary>\n)?<(task_result|task_error)>\n([\s\S]*?)\n<\/\4>\n<\/task>$/u
  )
  if (!match) return undefined
  const state = match[2]
  if (state !== 'running' && state !== 'completed' && state !== 'error') {
    return undefined
  }
  return {
    id: match[1] ?? '',
    state,
    summary: match[3],
    text: match[5] ?? ''
  }
}

function taskStatus(
  state: AgentToolState,
  envelope: OpenCodeTaskEnvelope | undefined
): AgentSubagentActivity['status'] {
  if (envelope?.state === 'running') return 'running'
  if (envelope?.state === 'completed') return 'completed'
  if (envelope?.state === 'error') return 'error'
  return state.status
}

function taskDescription(
  input: Record<string, unknown>,
  state: AgentToolState,
  envelope: OpenCodeTaskEnvelope | undefined
): string {
  const summary = envelope?.summary
    ?.replace(/^Background task (?:completed|failed):\s*/iu, '')
    .trim()
  return stringValue(input['description']) ?? state.title ?? summary ?? 'Delegated task'
}

function mapOpenCodeTaskPart(
  part: Record<string, unknown>,
  id: string,
  messageID: string
): AgentPart {
  const state = mapOpenCodeToolState(part['state'])
  const input = state.input
  const envelope = parseOpenCodeTaskEnvelope(state.output)
  const metadata = {
    ...(recordValue(part['metadata']) ?? {}),
    ...(state.metadata ?? {})
  }
  const model = recordValue(metadata['model'])
  const status = taskStatus(state, envelope)
  const output = envelope?.state === 'running' ? undefined : (envelope?.text ?? state.output)
  const activityTime = state.time
    ? {
        start: state.time.start,
        end: status === 'running' ? undefined : state.time.end
      }
    : undefined
  return {
    type: 'subagent',
    id,
    messageID,
    callID: stringValue(part['callID']),
    activity: {
      status,
      agent: stringValue(input['subagent_type']) ?? '',
      description: taskDescription(input, state, envelope),
      prompt: stringValue(input['prompt']),
      childSessionId:
        stringValue(metadata['sessionId']) ?? envelope?.id ?? stringValue(input['task_id']),
      providerTaskId: stringValue(metadata['jobId']) ?? stringValue(input['task_id']),
      providerId: stringValue(model?.['providerID']),
      modelId: stringValue(model?.['modelID']),
      background: metadata['background'] === true || input['background'] === true,
      output,
      error:
        status === 'error' ? (envelope?.text ?? state.error ?? 'Sub-agent task failed') : undefined,
      time: activityTime
    }
  }
}

function mapOpenCodeTaskResult(
  part: Record<string, unknown>,
  id: string,
  messageID: string
): AgentPart | undefined {
  if (part['synthetic'] !== true) return undefined
  const envelope = parseOpenCodeTaskEnvelope(part['text'])
  if (!envelope) return undefined
  return {
    type: 'subagent',
    id,
    messageID,
    activity: {
      status: envelope.state === 'error' ? 'error' : envelope.state,
      agent: '',
      description:
        envelope.summary?.replace(/^Background task (?:completed|failed):\s*/iu, '').trim() ??
        'Delegated task',
      childSessionId: envelope.id,
      background: true,
      output: envelope.state === 'running' ? undefined : envelope.text,
      error: envelope.state === 'error' ? envelope.text : undefined
    }
  }
}

const OPEN_CODE_COMPACTION_CONTINUE_PROMPT =
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.'

export function isOpenCodeCompactionContinuePart(part: Record<string, unknown>): boolean {
  if (part['type'] !== 'text' || part['synthetic'] !== true) return false
  const metadata = recordValue(part['metadata'])
  if (metadata?.['compaction_continue'] === true) return true
  return stringValue(part['text'])?.endsWith(OPEN_CODE_COMPACTION_CONTINUE_PROMPT) === true
}

/** Convert one OpenCode wire-format message part into the shared harness shape. */
export function mapOpenCodePart(raw: unknown): OpenCodeAgentPart | null {
  const part = recordValue(raw)
  if (!part) return null
  if (isOpenCodeCompactionContinuePart(part)) return null
  const id = stringValue(part['id']) ?? ''
  const messageID = stringValue(part['messageID']) ?? ''
  switch (part['type']) {
    case 'text': {
      const taskResult = mapOpenCodeTaskResult(part, id, messageID)
      if (taskResult) return taskResult
      return {
        type: 'text',
        id,
        messageID,
        text: stringValue(part['text']) ?? ''
      }
    }
    case 'reasoning': {
      const partTime = recordValue(part['time'])
      const timeStart = partTime?.['start']
      const timeEnd = partTime?.['end']
      const summary = textValue(part['summary'])
      return {
        type: 'reasoning',
        id,
        messageID,
        text: stringValue(part['text']) ?? '',
        ...(summary ? { summary } : {}),
        time:
          typeof timeStart === 'number' || typeof timeEnd === 'number'
            ? {
                start: typeof timeStart === 'number' ? timeStart : undefined,
                end: typeof timeEnd === 'number' ? timeEnd : undefined
              }
            : undefined
      }
    }
    case 'tool': {
      const toolName = stringValue(part['tool']) ?? ''
      if (toolName === 'task') {
        return mapOpenCodeTaskPart(part, id, messageID)
      }
      if (toolName === 'question' || toolName === 'ask') {
        const state = mapOpenCodeToolState(part['state'])
        // Some harnesses serialize tool input as a JSON string; tolerate that.
        const rawState = recordValue(part['state']) ?? {}
        const input = recordFromUnknown(rawState['input']) ?? state.input
        const questions = mapOpenCodeQuestions(input)
        const mappedQuestion = questions[0]
        const prompt = mappedQuestion?.prompt ?? extractQuestionPrompt(input, state.title)
        const rawInput =
          typeof rawState['input'] === 'string' ? rawState['input'] : JSON.stringify(input)
        if (!prompt.trim()) {
          Logger.dev('opencode question tool mapped with empty prompt; raw input:', rawInput)
          return null
        }
        return {
          type: 'question',
          id,
          messageID,
          callID: stringValue(part['callID']),
          question: {
            ...(mappedQuestion ?? {
              prompt,
              custom: input['custom'] !== false
            }),
            answer: extractQuestionAnswer(state.output),
            rawInput
          }
        }
      }
      return {
        type: 'tool',
        id,
        messageID,
        callID: stringValue(part['callID']) ?? '',
        tool: toolName,
        state: mapOpenCodeToolState(part['state'])
      }
    }
    case 'subtask': {
      const model = recordValue(part['model'])
      return {
        type: 'subagent',
        id,
        messageID,
        activity: {
          status: 'pending',
          agent: stringValue(part['agent']) ?? '',
          description: stringValue(part['description']) ?? 'Delegated task',
          prompt: stringValue(part['prompt']),
          providerId: stringValue(model?.['providerID']),
          modelId: stringValue(model?.['modelID']),
          background: false
        }
      }
    }
    case 'file':
      return {
        type: 'file',
        id,
        messageID,
        mime: stringValue(part['mime']) ?? '',
        url: stringValue(part['url']) ?? '',
        filename: stringValue(part['filename'])
      }
    case 'step-start':
      return { type: 'step-start', id, messageID }
    case 'step-finish': {
      const { aggregateTokens, normalizedUsage } = mapOpenCodeUsage(part['tokens'])
      return {
        type: 'step-finish',
        id,
        messageID,
        reason: stringValue(part['reason']) ?? '',
        ...(typeof part['cost'] === 'number' ? { cost: part['cost'] } : {}),
        ...(aggregateTokens ? { tokens: aggregateTokens } : {}),
        ...(normalizedUsage ? { normalizedUsage } : {})
      }
    }
    case 'compaction':
      return {
        type: 'compaction',
        id,
        messageID,
        auto: part['auto'] === true,
        overflow: part['overflow'] === true
      }
    default:
      return null
  }
}
