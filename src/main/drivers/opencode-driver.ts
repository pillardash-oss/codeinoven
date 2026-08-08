import { execFile, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { promisify } from 'util'
import { Logger } from '../logger'
import type {
  AgentEvent,
  AgentMessage,
  AgentPart,
  AgentProviderIssue,
  AgentQuestion,
  AgentQuestionRequest,
  AgentSubagentActivity,
  AgentTokenUsage,
  AgentToolState,
  HarnessCommand,
  PermissionReply,
  ProviderCatalog,
  ProviderModel,
  ThinkingPreset,
  ThreadSettings
} from '../../lib/types'
import type {
  AgentEventCallback,
  GenerateTitleOptions,
  HarnessCapabilities,
  HarnessDriver,
  HarnessToolDefinition,
  PreparedUtilityRuntime,
  SendPromptOptions,
  SteerPromptOptions,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './driver.interface'
import { buildHarnessEnvironment } from './cli-environment'
import { BaseUrlProviderService } from '../base-url-provider-service'
import { hasNativeProviderCatalog } from '../native-provider-config-service'
import { SecretVault } from '../secret-vault'
import { resolveFastModelId } from '../../lib/fast-inference'
import { classifyProviderIssue } from '../../lib/provider-issue'
import { isSvgAttachment, readSvgAttachmentText, formatSvgAsText } from './svg-attachment'
import { isTextAttachment, readTextAttachment, formatTextAsText } from './text-attachment'
import { buildTitlePrompt, sanitizeGeneratedTitle } from '../title-generator'

/** Time allowed for an opencode server to announce its port before giving up. */
const SERVER_START_TIMEOUT_MS = 25000
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000
const execFileAsync = promisify(execFile)

/** Reasoning-effort variants offered for custom reasoning models. */
const STANDARD_THINKING_VARIANTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max · high usage' },
  { id: 'ultra', label: 'Ultra · highest usage' }
]

/** Delay before retrying a dropped SSE connection. */
const SSE_RECONNECT_MS = 1000
const TITLE_GENERATION_TIMEOUT_MS = 180_000

interface TitleTurnWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ServerHandle {
  projectPath: string
  runtimeId: string | null
  port: number
  baseUrl: string
  process: ChildProcess
  /** Aborts the SSE subscription loop when the server is disposed. */
  abortController: AbortController
}

/**
 * Handle for an isolated `opencode serve` process used for ephemeral work
 * (e.g., thread title generation) so it cannot block the project's main
 * pooled server.
 */
export interface IsolatedHandle extends ServerHandle {
  sessionId: string
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const text = value.filter((entry): entry is string => typeof entry === 'string').join('\n')
  return text || undefined
}

/** Parse `opencode models --verbose`: model ref line followed by one JSON object. */
export function parseOpenCodeModels(output: string): Array<Record<string, unknown>> {
  const models: Array<Record<string, unknown>> = []
  const lines = output.split(/\r?\n/u)
  let index = 0
  while (index < lines.length) {
    const reference = lines[index]?.trim() ?? ''
    index += 1
    if (!reference || reference.startsWith('{')) continue
    while (index < lines.length && !lines[index]?.trim().startsWith('{')) index += 1
    if (index >= lines.length) break
    let depth = 0
    let json = ''
    do {
      const line = lines[index] ?? ''
      json += `${line}\n`
      for (const character of line) {
        if (character === '{') depth += 1
        else if (character === '}') depth -= 1
      }
      index += 1
    } while (index < lines.length && depth > 0)
    try {
      const parsed = JSON.parse(json) as unknown
      const model = recordValue(parsed)
      if (!model) continue
      const [providerId, ...modelIdParts] = reference.split('/')
      const modelId = stringValue(model['id']) ?? modelIdParts.join('/')
      const resolvedProviderId = stringValue(model['providerID']) ?? providerId
      if (!resolvedProviderId || !modelId) continue
      models.push({ ...model, id: modelId, providerID: resolvedProviderId })
    } catch {
      // Ignore one malformed entry; remaining CLI entries can still populate picker.
    }
  }
  return models
}

function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'utility'
  )
}

function openCodeIssue(
  raw: unknown,
  fallback: string,
  overrides: Partial<Pick<AgentProviderIssue, 'attempt' | 'retryAt' | 'retryable'>> = {}
): AgentProviderIssue {
  const error = recordValue(raw)
  const data = recordValue(error?.['data'])
  const message =
    stringValue(data?.['message']) ??
    stringValue(error?.['message']) ??
    stringValue(raw) ??
    fallback
  const statusCode = numberValue(data?.['statusCode']) ?? numberValue(error?.['statusCode'])
  return {
    kind: classifyProviderIssue(message, statusCode),
    message,
    harnessId: 'opencode',
    retryable:
      overrides.retryable ??
      (typeof data?.['isRetryable'] === 'boolean' ? data['isRetryable'] : false),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...overrides
  }
}

/**
 * True when the error is a provider/stream abort rather than a real failure.
 *
 * OpenCode converts any `AbortError`/`DOMException` from the model layer into
 * `MessageAbortedError` ("The operation was aborted."). For a compaction
 * summary this is transient maintenance noise — the conversation is intact,
 * it simply wasn't compacted — so it must never be surfaced as a session
 * error or "aborted" banner. The same abort error also arrives via the
 * `session.error` event (from `SessionProcessor.halt`), which is dropped here.
 */
function isOpenCodeAbortError(raw: unknown): boolean {
  const error = recordValue(raw)
  const data = recordValue(error?.['data'])
  const name = stringValue(error?.['name']) ?? stringValue(data?.['name']) ?? ''
  const message =
    stringValue(data?.['message']) ?? stringValue(error?.['message']) ?? stringValue(raw) ?? ''
  return (
    name === 'MessageAbortedError' ||
    name === 'AbortError' ||
    name === 'DOMException' ||
    /operation was aborted|request aborted|stream aborted|aborted by user/iu.test(message)
  )
}

async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  const detail = body ? `: ${body.slice(0, 500)}` : ''
  return new Error(`${fallback} (${res.status})${detail}`)
}

function eventSessionId(props: Record<string, unknown>): string {
  const part = recordValue(props['part'])
  const info = recordValue(props['info'])
  return (
    stringValue(props['sessionID']) ??
    stringValue(part?.['sessionID']) ??
    stringValue(info?.['sessionID']) ??
    ''
  )
}

function mapOpenCodeToolState(raw: unknown): AgentToolState {
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

/** Convert a value that may be a JSON string into a record. */
function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  const asRecord = recordValue(value)
  if (asRecord) return asRecord
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON — treat as opaque string.
    }
  }
  return undefined
}

/** Extract the question text from the tool input, tolerating several field names. */
function extractQuestionPrompt(input: Record<string, unknown>, title?: string): string {
  return (
    stringValue(input['prompt']) ||
    stringValue(input['question']) ||
    stringValue(input['text']) ||
    stringValue(input['message']) ||
    stringValue(input['content']) ||
    title ||
    ''
  )
}

/** Extract options from either `options` or `richOptions`. */
function extractQuestionOptions(input: Record<string, unknown>): {
  options: string[]
  richOptions: { label: string; description?: string }[]
} {
  const rawOptions = Array.isArray(input['options']) ? input['options'] : []
  const rawRichOptions = Array.isArray(input['richOptions']) ? input['richOptions'] : []
  const allOptions = [...rawOptions, ...rawRichOptions]

  const options = allOptions
    .map((o: unknown) =>
      typeof o === 'string' ? o : (stringValue((o as Record<string, unknown>)['label']) ?? '')
    )
    .filter(Boolean)

  const richOptions = allOptions
    .map((o: unknown) => {
      if (typeof o === 'string') return null
      const opt = o as Record<string, unknown>
      const label = stringValue(opt['label'])
      return label
        ? {
            label,
            description: stringValue(opt['description']),
            ...(opt['recommended'] === true || /\(recommended\)/iu.test(label)
              ? { recommended: true }
              : {})
          }
        : null
    })
    .filter((o): o is NonNullable<typeof o> => o !== null)

  return { options, richOptions }
}

/** Normalize one provider question while preserving its position in a batch. */
function mapOpenCodeQuestion(raw: unknown): AgentQuestion | null {
  const input = recordValue(raw)
  if (!input) return null
  const { options, richOptions } = extractQuestionOptions(input)
  const prompt = extractQuestionPrompt(input)
  if (!prompt.trim()) return null
  return {
    prompt,
    header: stringValue(input['header']),
    description: stringValue(input['description']),
    options: options.length > 0 ? options : undefined,
    richOptions: richOptions.length > 0 ? richOptions : undefined,
    multiple: input['multiple'] === true,
    custom: input['custom'] !== false
  }
}

/** Normalize the current ordered `questions` array and legacy single input. */
function mapOpenCodeQuestions(input: Record<string, unknown>): AgentQuestion[] {
  const values = Array.isArray(input['questions']) ? input['questions'] : [input]
  return values
    .map((value) => mapOpenCodeQuestion(value))
    .filter((value): value is AgentQuestion => value !== null)
}

function mapOpenCodeQuestionRequest(raw: unknown): AgentQuestionRequest | null {
  const request = recordValue(raw)
  if (!request) return null
  const requestId = stringValue(request['id']) ?? stringValue(request['requestID']) ?? ''
  const sessionId = stringValue(request['sessionID']) ?? ''
  const questions = mapOpenCodeQuestions(request)
  if (!requestId || !sessionId || questions.length === 0) return null
  const tool = recordValue(request['tool'])
  return {
    requestId,
    sessionId,
    questions,
    tool: tool
      ? {
          messageID: stringValue(tool['messageID']) ?? '',
          callID: stringValue(tool['callID']) ?? ''
        }
      : undefined
  }
}

/** Extract the user's answer from the tool output. */
function extractQuestionAnswer(output: unknown): string | undefined {
  const outputRecord = recordFromUnknown(output)
  if (outputRecord) {
    return (
      stringValue(outputRecord['answer']) ||
      stringValue(outputRecord['result']) ||
      stringValue(outputRecord['value'])
    )
  }
  return stringValue(output)
}

function mapOpenCodeTokens(raw: unknown): AgentTokenUsage | undefined {
  const tokens = recordValue(raw)
  if (!tokens) return undefined
  const cache = recordValue(tokens['cache'])
  const input = numberValue(tokens['input']) ?? 0
  const output = numberValue(tokens['output']) ?? 0
  const reasoning = numberValue(tokens['reasoning']) ?? 0
  const cacheRead = numberValue(cache?.['read']) ?? 0
  const cacheWrite = numberValue(cache?.['write']) ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite
  }
}

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

function isOpenCodeCompactionContinuePart(part: Record<string, unknown>): boolean {
  if (part['type'] !== 'text' || part['synthetic'] !== true) return false
  const metadata = recordValue(part['metadata'])
  if (metadata?.['compaction_continue'] === true) return true
  return stringValue(part['text'])?.endsWith(OPEN_CODE_COMPACTION_CONTINUE_PROMPT) === true
}

/** Convert one OpenCode wire-format message part into the shared harness shape. */
export function mapOpenCodePart(raw: unknown): AgentPart | null {
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
    case 'step-finish':
      return {
        type: 'step-finish',
        id,
        messageID,
        reason: stringValue(part['reason']) ?? '',
        cost: typeof part['cost'] === 'number' ? part['cost'] : undefined,
        tokens: mapOpenCodeTokens(part['tokens'])
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

/**
 * OpenCodeDriver — headless harness driver for the OpenCode CLI.
 *
 * Spawns a pooled `opencode serve` instance per project directory and
 * communicates over HTTP. Streaming events arrive via a persistent SSE
 * subscription and are forwarded to the registered AgentEventCallback.
 *
 * This driver is transport-only: it knows nothing about threads, projects,
 * or permission policy. Coordination lives in the ChatEngine.
 */
export class OpenCodeDriver implements HarnessDriver {
  readonly id = 'opencode'
  readonly name = 'OpenCode'
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    steering: true,
    nativeResume: true,
    messageHistory: 'native',
    interactivePermissions: true,
    attachments: true,
    commands: true,
    providerCatalog: true,
    sessionStatus: true,
    contextUsage: true,
    compaction: true,
    subagents: true,
    // OpenCode 1.18.10 accepts structured prompts but its history endpoint can
    // fail to decode their stored format. Use deterministic JSON-only output.
    structuredOutput: false,
    nativeUtilities: ['web_fetch'],
    // OpenCode schedules and performs its own provider retries (`session.status`
    // `retry` with a `next` timestamp) — the app must not auto-resume for it.
    scheduledRetry: true
  }

  private servers = new Map<string, ServerHandle>()
  private starting = new Map<string, Promise<ServerHandle>>()
  private turnServers = new Map<string, ServerHandle>()
  private turnStarting = new Map<string, Promise<ServerHandle>>()
  private utilityRuntimes = new Map<string, PreparedUtilityRuntime>()
  private messageRoles = new Map<string, 'user' | 'assistant'>()
  private eventCallback: AgentEventCallback | null = null
  private isolatedServers = new Set<IsolatedHandle>()
  private titleSessions = new Set<string>()
  private titleTurnWaiters = new Map<string, TitleTurnWaiter>()

  /**
   * Optional collaborators for custom base-URL providers. When supplied, the
   * driver resolves every enabled provider's API key from the vault and injects
   * the provider configuration into `OPENCODE_CONFIG_CONTENT` so the models
   * appear in the `/models` picker.
   */
  constructor(
    private readonly baseUrlProviders?: BaseUrlProviderService,
    private readonly secretVault?: SecretVault
  ) {}

  // ─── HarnessDriver interface ──────────────────────────────────────────────

  onEvent(callback: AgentEventCallback): void {
    this.eventCallback = callback
  }

  async ensureReady(projectPath: string): Promise<void> {
    await execFileAsync('opencode', ['--version'], {
      cwd: projectPath,
      env: this.buildEnv(),
      timeout: 5_000,
      windowsHide: true
    })
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const mcp: Record<string, Record<string, unknown>> = {}
    const provider: Record<string, Record<string, unknown>> = {}
    const keys = new Set<string>()
    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind === 'provider' && binding.strategy === 'provider') {
        const environmentVariable = utility.credentials.find(
          (credential) => credential.environmentVariable
        )?.environmentVariable
        provider[utility.config.providerId] = {
          ...(utility.config.endpoint || environmentVariable
            ? {
                options: {
                  ...(utility.config.endpoint ? { baseURL: utility.config.endpoint } : {}),
                  ...(environmentVariable ? { apiKey: `{env:${environmentVariable}}` } : {})
                }
              }
            : {}),
          ...(utility.config.defaultModel
            ? {
                models: {
                  [utility.config.defaultModel]: { name: utility.config.defaultModel }
                }
              }
            : {})
        }
        continue
      }
      if (binding.strategy !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
      keys.add(key)

      if (utility.kind === 'mcp' && utility.config.transport === 'stdio') {
        const config = utility.config
        if (!config.command) {
          throw new TypeError(`OpenCode MCP utility "${utility.name}" requires a command`)
        }
        mcp[key] = {
          type: 'local',
          command: [config.command, ...(config.args ?? [])],
          environment: { ...(config.environment ?? {}) },
          enabled: true
        }
        continue
      }
      const url =
        utility.kind === 'mcp'
          ? utility.config.url
          : utility.kind === 'web_search' ||
              utility.kind === 'web_fetch' ||
              utility.kind === 'computer_use'
            ? utility.config.endpoint
            : undefined
      if (!url) {
        throw new TypeError(`OpenCode MCP utility "${utility.name}" requires a URL`)
      }
      mcp[key] = {
        type: 'remote',
        url,
        ...(utility.kind === 'mcp' && utility.config.headers
          ? { headers: utility.config.headers }
          : {}),
        enabled: true
      }
    }

    // ─── Custom base-URL providers ───────────────────────────────────────────
    // Resolve every enabled base-URL provider, vault its API key into a
    // deterministic env var, and merge the OpenCode-format provider config so
    // the models appear in the /models picker. This mirrors how OpenCode's own
    // opencode.json defines custom providers (npm, name, options, models).
    const baseUrlEnv: Record<string, string> = {}
    if (this.baseUrlProviders && this.secretVault && !hasNativeProviderCatalog(this.id)) {
      const customProviders = await this.baseUrlProviders.listEnabled(this.id)
      for (const custom of customProviders) {
        const options: Record<string, unknown> = { baseURL: custom.baseURL }
        if (custom.apiKeyRef && custom.apiKeyEnvVar) {
          const apiKey = await this.secretVault.resolve(custom.apiKeyRef)
          baseUrlEnv[custom.apiKeyEnvVar] = apiKey
          options.apiKey = `{env:${custom.apiKeyEnvVar}}`
        }
        if (custom.headers) options.headers = custom.headers
        const models: Record<string, Record<string, unknown>> = {}
        for (const model of custom.models) {
          const limit =
            model.contextWindow && model.maxOutputTokens
              ? { context: model.contextWindow, output: model.maxOutputTokens }
              : undefined
          const variants =
            model.thinkingPresets && model.thinkingPresets.length > 0
              ? model.thinkingPresets.map((p) => [p.id, { name: p.label }])
              : model.reasoning || model.defaultThinkingLevel
                ? STANDARD_THINKING_VARIANTS.map((p) => [p.id, { name: p.label }])
                : []
          models[model.id] = {
            name: model.name,
            ...(model.reasoning ? { reasoning: true } : {}),
            ...(limit ? { limit } : {}),
            ...(variants.length > 0 ? { variants: Object.fromEntries(variants) } : {})
          }
        }
        provider[custom.id] = {
          npm: custom.npm,
          name: custom.name,
          options,
          models
        }
      }
    }

    return Object.keys(mcp).length > 0 || Object.keys(provider).length > 0
      ? {
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp, provider }),
            ...baseUrlEnv
          }
        }
      : Object.keys(baseUrlEnv).length > 0
        ? { env: baseUrlEnv }
        : {}
  }

  async applyPreparedUtilityRuntime(
    _projectPath: string,
    runtime: PreparedUtilityRuntime | null,
    sessionId: string
  ): Promise<void> {
    void _projectPath
    const previous = this.utilityRuntimes.get(sessionId)
    if ((previous?.id ?? null) === runtime?.id) return
    if (previous) await this.stopTurnServer(sessionId)
    if (runtime) this.utilityRuntimes.set(sessionId, runtime)
    else this.utilityRuntimes.delete(sessionId)
    if (previous) await previous.cleanup()
  }

  async createSession(projectPath: string, title: string): Promise<string> {
    const handle = await this.ensureServer(projectPath)
    return this.createSessionOnHandle(handle, title)
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    const catalogs = await this.listProviders(projectPath).catch(() => [])
    const openCodeModels = catalogs.find((catalog) => catalog.id === 'opencode')?.models ?? []
    const freeModel = openCodeModels
      .filter((model) => /(?:^|[-:])free$/iu.test(model.id))
      .sort(
        (left, right) =>
          Number(left.id !== 'deepseek-v4-flash-free') -
          Number(right.id !== 'deepseek-v4-flash-free')
      )[0]
    const goFlash = catalogs
      .find((catalog) => catalog.id === 'opencode-go')
      ?.models.find((model) => model.id === 'deepseek-v4-flash')
    const attempts = [
      ...(freeModel ? [{ providerId: freeModel.providerId, modelId: freeModel.id }] : []),
      ...(goFlash ? [{ providerId: goFlash.providerId, modelId: goFlash.id }] : []),
      { providerId: options.settings.providerId, modelId: options.settings.modelId }
    ].filter(
      (candidate, index, all) =>
        Boolean(candidate.providerId && candidate.modelId) &&
        all.findIndex(
          (other) =>
            other.providerId === candidate.providerId && other.modelId === candidate.modelId
        ) === index
    )

    for (const candidate of attempts) {
      let isolated: IsolatedHandle | null = null
      let completion: { promise: Promise<void>; cancel: () => void } | null = null
      try {
        isolated = await this.createIsolatedSession(projectPath, 'Thread title')
        this.titleSessions.add(isolated.sessionId)
        completion = this.waitForTitleTurn(isolated.sessionId)
        await this.sendPrompt(
          projectPath,
          {
            sessionId: isolated.sessionId,
            settings: {
              ...options.settings,
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              thinkingLevel: 'minimal',
              inferenceMode: 'normal',
              permissionLevel: 'auto_review',
              engineeringMode: false
            },
            text: buildTitlePrompt(options.message.slice(0, 2_000)),
            attachments: [],
            readOnly: true,
            allowedTools: []
          },
          isolated
        )
        await completion.promise
        const messages = await this.loadMessages(projectPath, isolated.sessionId, isolated)
        const response = [...messages].reverse().find((message) => message.role === 'assistant')
        const raw = response?.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
        const title = raw ? sanitizeGeneratedTitle(raw) : null
        if (title) return title
      } catch (error) {
        Logger.dev(
          `OpenCode title model ${candidate.providerId}/${candidate.modelId} unavailable:`,
          error
        )
      } finally {
        completion?.cancel()
        if (isolated) {
          this.titleSessions.delete(isolated.sessionId)
          await this.deleteSessionOnHandle(isolated).catch(() => undefined)
          this.disposeIsolatedSession(isolated)
        }
      }
    }
    return null
  }

  /**
   * Create a session on a fresh, isolated `opencode serve` process. Use this
   * for short, independent tasks that must not share the main project's
   * request queue (e.g., thread title generation).
   */
  async createIsolatedSession(projectPath: string, title: string): Promise<IsolatedHandle> {
    const handle = await this.startIsolatedServer(projectPath)
    const sessionId = await this.createSessionOnHandle(handle, title)
    const isolated: IsolatedHandle = { ...handle, sessionId }
    this.isolatedServers.add(isolated)
    isolated.process.on('exit', () => {
      this.isolatedServers.delete(isolated)
    })
    return isolated
  }

  /** Tear down an isolated server created by `createIsolatedSession`. */
  disposeIsolatedSession(handle: IsolatedHandle): void {
    this.isolatedServers.delete(handle)
    handle.abortController.abort()
    handle.process.kill()
  }

  private async createSessionOnHandle(handle: ServerHandle, title: string): Promise<string> {
    const res = await fetch(`${handle.baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to create session')
    const session = (await res.json()) as { id: string }
    return session.id
  }

  async sendPrompt(
    projectPath: string,
    opts: SendPromptOptions,
    isolated?: IsolatedHandle
  ): Promise<void> {
    const handle =
      isolated ??
      (await this.ensureTurnServer(projectPath, opts.sessionId, opts.settings.providerId))

    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: opts.text }]
    for (const attachment of opts.attachments) {
      if (isSvgAttachment(attachment)) {
        // The opencode backend rasterizes image parts and its default decoder
        // cannot decode SVG, so inline the raw markup as text instead.
        const content = await readSvgAttachmentText(attachment)
        if (content !== null) {
          parts.push({ type: 'text', text: formatSvgAsText(attachment, content) })
          continue
        }
      }
      if (isTextAttachment(attachment)) {
        // Some providers reject file parts whose media type they do not
        // support (e.g. application/json), so inline text-ish content instead.
        const content = await readTextAttachment(attachment)
        if (content !== null) {
          parts.push({ type: 'text', text: formatTextAsText(attachment, content) })
          continue
        }
      }
      parts.push({
        type: 'file',
        mime: attachment.mime,
        url: attachment.url,
        filename: attachment.filename
      })
    }

    const body: Record<string, unknown> = {
      variant: opts.settings.thinkingLevel,
      parts
    }
    if (opts.userMessageId) {
      body['messageID'] = opts.userMessageId
    }
    const model = this.resolvedModel(opts.settings)
    if (model.providerId && model.modelId) {
      body['model'] = {
        providerID: model.providerId,
        modelID: model.modelId
      }
    }
    if (opts.systemPrompt) {
      body['system'] = opts.systemPrompt
    }
    if (opts.allowedTools) {
      body['tools'] = Object.fromEntries([
        ['*', false],
        ...opts.allowedTools.map((tool) => [tool, true] as const)
      ])
    }
    if (opts.structuredOutput) {
      body['format'] = {
        type: 'json_schema',
        schema: opts.structuredOutput.schema,
        retryCount: opts.structuredOutput.retryCount
      }
    }

    const res = await fetch(`${handle.baseUrl}/session/${opts.sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to send prompt')
    }
  }

  /** Append input through OpenCode's native asynchronous session prompt endpoint. */
  async steerPrompt(
    projectPath: string,
    opts: SteerPromptOptions,
    isolated?: IsolatedHandle
  ): Promise<void> {
    const handle =
      isolated ?? this.turnServers.get(opts.sessionId) ?? (await this.ensureServer(projectPath))
    const parts: Array<Record<string, unknown>> = [{ type: 'text', text: opts.text }]
    for (const attachment of opts.attachments) {
      if (isSvgAttachment(attachment)) {
        const content = await readSvgAttachmentText(attachment)
        if (content !== null) {
          parts.push({ type: 'text', text: formatSvgAsText(attachment, content) })
          continue
        }
      }
      if (isTextAttachment(attachment)) {
        // Some providers reject file parts whose media type they do not
        // support (e.g. application/json), so inline text-ish content instead.
        const content = await readTextAttachment(attachment)
        if (content !== null) {
          parts.push({ type: 'text', text: formatTextAsText(attachment, content) })
          continue
        }
      }
      parts.push({
        type: 'file',
        mime: attachment.mime,
        url: attachment.url,
        filename: attachment.filename
      })
    }
    const res = await fetch(`${handle.baseUrl}/session/${opts.sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: opts.userMessageId, parts })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to steer active OpenCode session')
  }

  async loadMessages(
    projectPath: string,
    sessionId: string,
    isolated?: IsolatedHandle
  ): Promise<AgentMessage[]> {
    const turnHandle = isolated ? undefined : this.turnServers.get(sessionId)
    const handle = isolated ?? turnHandle ?? (await this.ensureServer(projectPath))
    try {
      return await this.fetchMessages(handle, sessionId)
    } catch (error) {
      // End-of-turn mirroring and renderer refreshes can read concurrently.
      // Utility cleanup deliberately kills the per-turn server after the
      // canonical mirror finishes, which terminates any other fetch already in
      // flight. OpenCode sessions persist outside that process, so retry the
      // read once through whichever transport owns the session now.
      if (!turnHandle || isolated || this.turnServers.get(sessionId) === turnHandle) throw error
      const replacementHandle =
        this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
      return this.fetchMessages(replacementHandle, sessionId)
    }
  }

  async abort(projectPath: string, sessionId: string, isolated?: IsolatedHandle): Promise<void> {
    const handle =
      isolated ?? this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    await fetch(`${handle.baseUrl}/session/${sessionId}/abort`, {
      method: 'POST',
      signal: AbortSignal.timeout(5_000)
    })
  }

  /**
   * Forcefully terminate the harness process backing a session (SIGTERM).
   * Kills the per-session `opencode serve` process that streams the SSE turn so
   * the connection is torn down immediately — used when the user confirms a
   * forced close. Falls back to a graceful abort when no dedicated turn server
   * exists for the session (the pooled server is left for the app to dispose).
   */
  terminate(projectPath: string, sessionId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId)
    if (handle) {
      handle.abortController.abort()
      if (!handle.process.killed) handle.process.kill('SIGTERM')
      return Promise.resolve()
    }
    return this.abort(projectPath, sessionId)
  }

  /**
   * Permanently remove a session from the pooled server, releasing the work it
   * owned (in-flight turns and any processes it spawned). No-op when the
   * project's server is not running, and an already-missing session counts as
   * deleted.
   */
  async deleteSession(projectPath: string, sessionId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? this.servers.get(projectPath)
    if (!handle) return
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok && res.status !== 404) {
      throw await errorFromResponse(res, 'Failed to delete session')
    }
  }

  private async deleteSessionOnHandle(handle: IsolatedHandle): Promise<void> {
    const res = await fetch(`${handle.baseUrl}/session/${handle.sessionId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok && res.status !== 404) {
      throw await errorFromResponse(res, 'Failed to delete isolated session')
    }
  }

  async listProviders(projectPath: string): Promise<ProviderCatalog[]> {
    const { stdout } = await execFileAsync('opencode', ['models', '--verbose'], {
      cwd: projectPath,
      env: this.buildEnv(),
      timeout: MODEL_DISCOVERY_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
    const rawProviders = new Map<string, Record<string, unknown>>()
    for (const model of parseOpenCodeModels(stdout)) {
      const providerId = stringValue(model['providerID'])
      const modelId = stringValue(model['id'])
      if (!providerId || !modelId) continue
      const provider = rawProviders.get(providerId) ?? {
        id: providerId,
        name: providerId,
        models: {}
      }
      const models = recordValue(provider['models']) ?? {}
      models[modelId] = model
      provider['models'] = models
      rawProviders.set(providerId, provider)
    }
    const catalogs = [...rawProviders.values()]
      .map((provider) => this.mapProvider(provider))
      .filter((provider): provider is ProviderCatalog => provider !== null)
    if (!this.baseUrlProviders) return catalogs
    const customProviders = await this.baseUrlProviders.listEnabled(this.id)
    const customIds = new Set(customProviders.map((provider) => provider.id))
    const merged = catalogs.filter((catalog) => !customIds.has(catalog.id))
    for (const custom of customProviders) {
      merged.push({
        id: custom.id,
        name: custom.name,
        harnessId: this.id,
        models: custom.models.map((model) => ({
          id: model.id,
          providerId: custom.id,
          name: model.name,
          reasoning: model.reasoning,
          thinkingPresets: model.thinkingPresets,
          // Custom providers expose no capability data; use the user-declared
          // vision flag and default to vision-capable so a custom vision model
          // is never wrongly hidden or gated.
          attachment: model.vision !== false,
          toolcall: true,
          contextWindow: model.contextWindow,
          fastSupported: false
        }))
      })
    }
    return merged
  }

  async listCommands(projectPath: string): Promise<HarnessCommand[]> {
    const handle = await this.ensureServer(projectPath)
    const res = await fetch(`${handle.baseUrl}/command`)
    if (!res.ok) return []
    const data = (await res.json()) as Array<Record<string, unknown>>
    return data
      .map((c) => ({
        name: (c['name'] as string) ?? '',
        description: c['description'] as string | undefined,
        source: c['source'] as HarnessCommand['source']
      }))
      .filter((c) => c.name)
  }

  async listTools(
    projectPath: string,
    providerId: string,
    modelId: string
  ): Promise<HarnessToolDefinition[]> {
    const handle = await this.ensureServer(projectPath)
    const url = new URL(`${handle.baseUrl}/experimental/tool`)
    url.searchParams.set('provider', providerId)
    url.searchParams.set('model', modelId)
    url.searchParams.set('directory', projectPath)
    const res = await fetch(url)
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to list agent tools')
    }
    const data = (await res.json()) as Array<Record<string, unknown>>
    return data
      .map((item) => ({
        name: stringValue(item['id']) ?? '',
        description: stringValue(item['description']) ?? '',
        inputSchema: recordValue(item['parameters']) ?? {}
      }))
      .filter((tool) => tool.name)
  }

  async runCommand(
    projectPath: string,
    sessionId: string,
    command: string,
    args: string
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, arguments: args })
    })
    if (!res.ok) throw await errorFromResponse(res, 'Failed to run command')
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    settings: ThreadSettings
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerID: settings.providerId,
        modelID: settings.modelId
      })
    })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to compact session')
    }
  }

  async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    const handle =
      (sessionId ? this.turnServers.get(sessionId) : undefined) ??
      (await this.ensureServer(projectPath))
    try {
      const res = await fetch(`${handle.baseUrl}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply, ...(message !== undefined ? { message } : {}) })
      })
      if (!res.ok) Logger.error(`permission reply rejected (${res.status})`)
    } catch (error) {
      Logger.error('permission reply failed:', error)
    }
  }

  async replyToQuestion(
    projectPath: string,
    sessionId: string,
    requestId: string,
    answers: string[][]
  ): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/question/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers })
    })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to answer question')
    }
  }

  async rejectQuestion(projectPath: string, sessionId: string, requestId: string): Promise<void> {
    const handle = this.turnServers.get(sessionId) ?? (await this.ensureServer(projectPath))
    const res = await fetch(`${handle.baseUrl}/question/${encodeURIComponent(requestId)}/reject`, {
      method: 'POST'
    })
    if (!res.ok) {
      throw await errorFromResponse(res, 'Failed to dismiss question')
    }
  }

  async listPendingQuestions(projectPath: string): Promise<AgentQuestionRequest[]> {
    const pooled = await this.ensureServer(projectPath)
    const handles = [
      pooled,
      ...[...this.turnServers.values()].filter((handle) => handle.projectPath === projectPath)
    ]
    const pending = await Promise.all(
      handles.map(async (handle) => {
        const response = await fetch(`${handle.baseUrl}/question`)
        if (!response.ok) {
          throw await errorFromResponse(response, 'Failed to list pending questions')
        }
        const raw = (await response.json()) as unknown
        if (!Array.isArray(raw)) return []
        return raw
          .map((request) => mapOpenCodeQuestionRequest(request))
          .filter((request): request is AgentQuestionRequest => request !== null)
      })
    )
    return [
      ...new Map(pending.flat().map((request) => [request.requestId, request] as const)).values()
    ]
  }

  dispose(): void {
    for (const handle of this.servers.values()) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.servers.clear()
    for (const handle of this.turnServers.values()) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.turnServers.clear()
    for (const handle of this.isolatedServers) {
      handle.abortController.abort()
      handle.process.kill()
    }
    this.isolatedServers.clear()
    for (const waiter of this.titleTurnWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('OpenCode is shutting down'))
    }
    this.titleTurnWaiters.clear()
    this.titleSessions.clear()
    this.starting.clear()
    this.turnStarting.clear()
    for (const runtime of this.utilityRuntimes.values()) {
      void runtime.cleanup().catch((error) => {
        Logger.error('OpenCode utility runtime cleanup failed:', error)
      })
    }
    this.utilityRuntimes.clear()
    this.eventCallback = null
  }

  // ─── Server pool ──────────────────────────────────────────────────────────

  private async ensureServer(projectPath: string): Promise<ServerHandle> {
    const existing = this.servers.get(projectPath)
    if (existing) return existing
    const pending = this.starting.get(projectPath)
    if (pending) return pending

    const promise = this.startServer(projectPath)
    this.starting.set(projectPath, promise)
    try {
      const handle = await promise
      this.servers.set(projectPath, handle)
      return handle
    } finally {
      if (this.starting.get(projectPath) === promise) this.starting.delete(projectPath)
    }
  }

  private async ensureTurnServer(
    projectPath: string,
    sessionId: string,
    providerId: string
  ): Promise<ServerHandle> {
    const sourceRuntime = this.utilityRuntimes.get(sessionId)
    if (!sourceRuntime) return this.ensureServer(projectPath)
    const runtime = await this.runtimeForProvider(sourceRuntime, providerId)
    const existing = this.turnServers.get(sessionId)
    if (existing?.runtimeId === runtime.id) return existing
    if (existing) await this.stopTurnServer(sessionId)
    const pending = this.turnStarting.get(sessionId)
    if (pending) return pending

    const promise = this.startIsolatedServer(projectPath, runtime)
    this.turnStarting.set(sessionId, promise)
    try {
      const handle = await promise
      if (this.utilityRuntimes.get(sessionId)?.id !== sourceRuntime.id) {
        handle.abortController.abort()
        handle.process.kill()
        throw new Error('Utility runtime was released before the turn server became ready')
      }
      this.turnServers.set(sessionId, handle)
      handle.process.once('exit', () => {
        if (this.turnServers.get(sessionId) === handle) this.turnServers.delete(sessionId)
      })
      return handle
    } finally {
      if (this.turnStarting.get(sessionId) === promise) this.turnStarting.delete(sessionId)
    }
  }

  /**
   * OpenCode validates every provider in OPENCODE_CONFIG_CONTENT at startup.
   * Keep utility-provided entries, but expose only the custom provider selected
   * for this turn so a broken unrelated provider cannot block prompt sending.
   */
  private async runtimeForProvider(
    runtime: PreparedUtilityRuntime,
    selectedProviderId: string
  ): Promise<PreparedUtilityRuntime> {
    if (!this.baseUrlProviders) return runtime
    const customProviders = (await this.baseUrlProviders.listProviders()).filter(
      (provider) => provider.harnessId === this.id
    )
    if (customProviders.length === 0) return runtime

    const configContent = runtime.env['OPENCODE_CONFIG_CONTENT']
    if (!configContent) return runtime
    let config: Record<string, unknown> | undefined
    try {
      const parsed = JSON.parse(configContent) as unknown
      config = recordValue(parsed)
    } catch {
      return runtime
    }
    if (!config) return runtime

    const customIds = new Set(customProviders.map((provider) => provider.id))
    const configuredProviders = recordValue(config['provider']) ?? {}
    config['provider'] = Object.fromEntries(
      Object.entries(configuredProviders).filter(
        ([id]) => !customIds.has(id) || id === selectedProviderId
      )
    )
    const env: Record<string, string> = {
      ...runtime.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
    }
    for (const provider of customProviders) {
      if (provider.id === selectedProviderId || !provider.apiKeyEnvVar) continue
      delete env[provider.apiKeyEnvVar]
    }
    return {
      ...runtime,
      id: `${runtime.id}:provider:${selectedProviderId}`,
      env
    }
  }

  private async stopTurnServer(sessionId: string): Promise<void> {
    const pending = this.turnStarting.get(sessionId)
    if (pending) {
      try {
        const pendingHandle = await pending
        pendingHandle.abortController.abort()
        pendingHandle.process.kill()
      } catch {
        // A failed start has no live server to stop.
      }
      if (this.turnStarting.get(sessionId) === pending) this.turnStarting.delete(sessionId)
    }
    const handle = this.turnServers.get(sessionId)
    if (!handle) return
    handle.abortController.abort()
    handle.process.kill()
    this.turnServers.delete(sessionId)
  }

  /** Spawn a dedicated `opencode serve` process independent of the project pool. */
  private startIsolatedServer(
    projectPath: string,
    runtime?: PreparedUtilityRuntime
  ): Promise<Omit<IsolatedHandle, 'sessionId'>> {
    return new Promise((resolve, reject) => {
      const args = ['serve', '--port', '0', '--hostname', '127.0.0.1', ...(runtime?.args ?? [])]
      const child = spawn('opencode', args, {
        cwd: projectPath,
        env: this.buildEnv(runtime),
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error('Timed out waiting for isolated opencode server to start'))
        }
      }, SERVER_START_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          const port = parseInt(match[1] ?? '', 10)
          const handle: Omit<IsolatedHandle, 'sessionId'> = {
            projectPath,
            runtimeId: runtime?.id ?? null,
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            process: child,
            abortController: new AbortController()
          }
          Logger.dev(`isolated opencode server up for ${projectPath} on :${port}`)
          this.subscribeEvents(handle)
          resolve(handle)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        Logger.dev(`isolated opencode[${projectPath}]`, chunk.toString().trim())
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      })

      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`isolated opencode exited before announcing a port (code ${code})`))
        }
      })
    })
  }

  /** Spawn `opencode serve` for a project and wait for it to announce its port. */
  private startServer(projectPath: string): Promise<ServerHandle> {
    return new Promise((resolve, reject) => {
      const args = ['serve', '--port', '0', '--hostname', '127.0.0.1']
      const child = spawn('opencode', args, {
        cwd: projectPath,
        env: this.buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill()
          reject(new Error('Timed out waiting for opencode server to start'))
        }
      }, SERVER_START_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const match = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          const port = parseInt(match[1] ?? '', 10)
          const handle: ServerHandle = {
            projectPath,
            runtimeId: null,
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            process: child,
            abortController: new AbortController()
          }
          Logger.dev(`opencode server up for ${projectPath} on :${port}`)
          this.subscribeEvents(handle)
          resolve(handle)
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        Logger.dev(`opencode[${projectPath}]`, chunk.toString().trim())
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      })

      child.on('exit', (code) => {
        const current = this.servers.get(projectPath)
        if (current?.process === child) {
          current.abortController.abort()
          this.servers.delete(projectPath)
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`opencode exited before announcing a port (code ${code})`))
        }
      })
    })
  }

  /** GUI apps don't inherit the shell PATH — augment with common install locations. */
  private buildEnv(runtime?: PreparedUtilityRuntime): NodeJS.ProcessEnv {
    if (!runtime) return buildHarnessEnvironment()

    const configPath =
      runtime.configPaths['OPENCODE_CONFIG'] ??
      runtime.configPaths['opencode-config'] ??
      runtime.configPaths['config']
    const skillPath =
      runtime.configPaths['OPENCODE_CONFIG_DIR'] ??
      runtime.configPaths['opencode-skills'] ??
      runtime.configPaths['skills']
    return buildHarnessEnvironment({
      ...process.env,
      ...(configPath ? { OPENCODE_CONFIG: configPath } : {}),
      ...(skillPath ? { OPENCODE_CONFIG_DIR: skillPath } : {}),
      ...runtime.env
    })
  }

  /**
   * Stop the pooled server for a project (and any isolated servers bound to
   * it), releasing its process and ports. Sessions persist in opencode's own
   * store and rehydrate when the project is next used.
   */
  async releaseProjectResources(projectPath: string): Promise<void> {
    await this.stopProjectServers(projectPath)
  }

  private async stopProjectServers(projectPath: string): Promise<void> {
    const pending = this.starting.get(projectPath)
    if (pending) {
      try {
        const pendingHandle = await pending
        pendingHandle.abortController.abort()
        pendingHandle.process.kill()
      } catch {
        // A failed start has no live server to stop.
      }
      if (this.starting.get(projectPath) === pending) this.starting.delete(projectPath)
    }
    const handle = this.servers.get(projectPath)
    if (handle) {
      handle.abortController.abort()
      handle.process.kill()
      this.servers.delete(projectPath)
    }
    for (const isolated of this.isolatedServers) {
      if (isolated.projectPath !== projectPath) continue
      this.disposeIsolatedSession(isolated)
    }
    for (const [sessionId, turn] of this.turnServers) {
      if (turn.projectPath !== projectPath) continue
      await this.stopTurnServer(sessionId)
    }
  }

  // ─── Event stream ─────────────────────────────────────────────────────────

  /** Subscribe to the server's SSE bus and forward events, reconnecting on drops. */
  private subscribeEvents(handle: ServerHandle): void {
    const { signal } = handle.abortController
    void (async () => {
      while (!signal.aborted) {
        try {
          const res = await fetch(`${handle.baseUrl}/event`, {
            signal,
            headers: { Accept: 'text/event-stream' }
          })
          if (!res.ok || !res.body) break
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let sseBuffer = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done || signal.aborted) break
            sseBuffer += decoder.decode(value, { stream: true })
            let separator: number
            while ((separator = sseBuffer.indexOf('\n\n')) !== -1) {
              const frame = sseBuffer.slice(0, separator)
              sseBuffer = sseBuffer.slice(separator + 2)
              this.handleSseFrame(frame)
            }
          }
        } catch (error) {
          if (signal.aborted) break
          Logger.dev('SSE connection dropped, reconnecting:', error)
          await new Promise((resolve) => setTimeout(resolve, SSE_RECONNECT_MS))
        }
      }
    })()
  }

  /** Parse a single SSE frame and route its `data:` payload. */
  private handleSseFrame(frame: string): void {
    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
    if (dataLines.length === 0) return

    let event: { type?: string; properties?: Record<string, unknown> }
    try {
      event = JSON.parse(dataLines.join('\n')) as {
        type?: string
        properties?: Record<string, unknown>
      }
    } catch {
      return
    }
    if (!event.type || !event.properties) return
    this.routeEvent(event.type, event.properties)
  }

  /** Map an opencode bus event onto an AgentEvent and emit it. */
  private routeEvent(type: string, props: Record<string, unknown>): void {
    if (type === 'message.updated') {
      const info = recordValue(props['info'])
      const id = stringValue(info?.['id'])
      const role = info?.['role']
      if (id && (role === 'user' || role === 'assistant')) {
        this.messageRoles.set(id, role)
      }
    }
    for (const event of mapOpenCodeEvent(type, props)) {
      const messageId =
        event.type === 'message.part.updated'
          ? event.part.messageID
          : event.type === 'message.part.delta'
            ? event.messageId
            : undefined
      if (messageId && this.messageRoles.get(messageId) === 'user') {
        if (event.type === 'message.part.delta') continue
        if (
          event.type === 'message.part.updated' &&
          event.part.type !== 'compaction' &&
          event.part.type !== 'subagent'
        ) {
          continue
        }
      }
      this.emit(event)
    }
  }

  private emit(event: AgentEvent): void {
    if ('sessionId' in event && this.titleSessions.has(event.sessionId)) {
      const waiter = this.titleTurnWaiters.get(event.sessionId)
      if (event.type === 'session.error') {
        this.clearTitleTurnWaiter(event.sessionId)
        waiter?.reject(new Error(event.error ?? 'OpenCode title generation failed'))
      } else if (
        event.type === 'session.idle' ||
        (event.type === 'session.status' && event.status.state === 'idle')
      ) {
        this.clearTitleTurnWaiter(event.sessionId)
        waiter?.resolve()
      }
      return
    }
    this.eventCallback?.(event)
  }

  private waitForTitleTurn(sessionId: string): { promise: Promise<void>; cancel: () => void } {
    let resolvePromise: () => void = () => undefined
    let rejectPromise: (error: Error) => void = () => undefined
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const timer = setTimeout(() => {
      this.clearTitleTurnWaiter(sessionId)
      rejectPromise(new Error('OpenCode title generation timed out'))
    }, TITLE_GENERATION_TIMEOUT_MS)
    this.titleTurnWaiters.set(sessionId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      timer
    })
    return { promise, cancel: () => this.clearTitleTurnWaiter(sessionId) }
  }

  private clearTitleTurnWaiter(sessionId: string): void {
    const waiter = this.titleTurnWaiters.get(sessionId)
    if (!waiter) return
    clearTimeout(waiter.timer)
    this.titleTurnWaiters.delete(sessionId)
  }

  // ─── Wire-format mapping ──────────────────────────────────────────────────

  private async fetchMessages(handle: ServerHandle, sessionId: string): Promise<AgentMessage[]> {
    const res = await fetch(`${handle.baseUrl}/session/${sessionId}/message`)
    if (!res.ok) throw await errorFromResponse(res, 'Failed to load messages')
    const raw = (await res.json()) as Array<{
      info: Record<string, unknown>
      parts: Array<Record<string, unknown>>
    }>
    return raw
      .map((entry) => this.mapMessage(entry.info, entry.parts))
      .filter((message): message is AgentMessage => message !== null)
  }

  private mapMessage(
    info: Record<string, unknown>,
    parts: Array<Record<string, unknown>>
  ): AgentMessage | null {
    const role = info['role']
    if (role !== 'user' && role !== 'assistant') return null

    const time = info['time'] as { created?: number; completed?: number } | undefined
    const error = recordValue(info['error'])
    const errorData = recordValue(error?.['data'])
    const userModel = info['model'] as Record<string, unknown> | undefined
    const compactionSummary = info['summary'] === true || info['mode'] === 'compaction'
    // Keep aborted compaction summaries out of the mirror's error state too:
    // they are transient, and the conversation is intact.
    const errorMessage =
      compactionSummary && isOpenCodeAbortError(info['error'])
        ? undefined
        : (stringValue(errorData?.['message']) ?? stringValue(error?.['message']))
    const hiddenTransportParts = parts
      .filter(isOpenCodeCompactionContinuePart)
      .map((part, index): AgentPart => ({
        type: 'text',
        id: stringValue(part['id']) ?? `${String(info['id'] ?? 'message')}-transport-${index}`,
        messageID: stringValue(part['messageID']) ?? String(info['id'] ?? ''),
        text: stringValue(part['text']) ?? ''
      }))
    const mappedParts = parts
      .map((part) => mapOpenCodePart(part))
      .filter((part): part is AgentPart => part !== null)
      .map((part): AgentPart =>
        compactionSummary && part.type === 'text'
          ? {
              type: 'compaction-summary',
              id: part.id,
              messageID: part.messageID,
              text: part.text
            }
          : part
      )
    if (
      role === 'user' &&
      mappedParts.length === 0 &&
      parts.length > 0 &&
      hiddenTransportParts.length === 0
    ) {
      return null
    }

    return {
      id: (info['id'] as string | undefined) ?? '',
      role,
      ...(hiddenTransportParts.length > 0
        ? {
            origin: 'harness' as const,
            visibility: 'hidden' as const,
            transportParts: hiddenTransportParts,
            transportOrigin: 'harness' as const
          }
        : {}),
      parts: mappedParts,
      modelId:
        (info['modelID'] as string | undefined) ?? (userModel?.['modelID'] as string | undefined),
      providerId:
        (info['providerID'] as string | undefined) ??
        (userModel?.['providerID'] as string | undefined),
      createdAt: time?.created ?? 0,
      completedAt: time?.completed,
      cost: numberValue(info['cost']),
      tokens: mapOpenCodeTokens(info['tokens']),
      error: errorMessage,
      structuredOutput: info['structured'] ?? info['structured_output']
    }
  }

  /** Model id actually sent for a turn — fast inference appends the `*-fast` suffix. */
  private resolvedModel(settings: ThreadSettings): { providerId: string; modelId: string } {
    return {
      providerId: settings.providerId,
      modelId: resolveFastModelId(settings.modelId, settings.inferenceMode)
    }
  }

  private modelThinkingPresets(m: Record<string, unknown>): ThinkingPreset[] | undefined {
    const variants = recordValue(m['variants']) as Record<string, unknown> | undefined
    if (!variants) return undefined
    return Object.keys(variants).map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      description: `${id} reasoning effort`
    }))
  }

  private mapProvider(raw: Record<string, unknown>): ProviderCatalog | null {
    const id = raw['id'] as string | undefined
    if (!id) return null
    const modelsById = (raw['models'] as Record<string, Record<string, unknown>> | undefined) ?? {}
    const models: ProviderModel[] = Object.values(modelsById)
      .map((m) => {
        const capabilities = (m['capabilities'] as Record<string, boolean> | undefined) ?? {}
        const limit = recordValue(m['limit'])
        const reasoning = capabilities['reasoning'] === true
        const modelId = (m['id'] as string | undefined) ?? ''
        return {
          id: modelId,
          providerId: id,
          name: (m['name'] as string | undefined) ?? modelId,
          reasoning,
          thinkingPresets: this.modelThinkingPresets(m),
          // opencode reports `capabilities.attachment` (false for text-only
          // models). Unknown state stays vision-capable so models are never
          // hidden incorrectly.
          attachment: capabilities['attachment'] !== false,
          toolcall: capabilities['toolcall'] === true,
          contextWindow: numberValue(limit?.['context']),
          fastSupported: Boolean(modelId && modelsById[`${modelId}-fast`])
        }
      })
      .filter((m) => m.id)
    return { id, name: (raw['name'] as string | undefined) ?? id, harnessId: 'opencode', models }
  }
}
