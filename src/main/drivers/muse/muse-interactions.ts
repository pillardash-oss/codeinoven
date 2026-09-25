import type { AgentProviderIssue, SessionAgentEvent } from '../../../lib/types'
import {
  classifyProviderIssue,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'
import {
  isQuestionToolName,
  isTodoToolName,
  normalizeAgentQuestions,
  normalizeInteractionName,
  permissionPatterns
} from '../../../lib/agent-interactions'
import type { CliLineParseContext } from '../persistent-cli/persistent-cli-types'
import type { MuseTurnState } from './muse-parts'
import { firstString, parseRecord, record, stringValue } from './muse-values'

export function normalizeMuseQuestions(value: unknown) {
  const source = record(value)
  const rawQuestions = Array.isArray(source?.['questions']) ? source['questions'] : []
  const questions = rawQuestions.map((rawQuestion) => {
    const question = record(rawQuestion)
    const selection = record(question?.['selection'])
    if (!question || selection?.['mode'] !== 'multiple') return rawQuestion
    return { ...question, multiple: true }
  })
  return normalizeAgentQuestions({ questions })
}

export function museToolNeedsPermission(toolName: string): boolean {
  if (isQuestionToolName(toolName) || isTodoToolName(toolName)) return false
  const name = normalizeInteractionName(toolName)
  return [
    'bash',
    'shell',
    'terminal',
    'exec',
    'command',
    'write',
    'edit',
    'patch',
    'delete',
    'remove',
    'move',
    'rename',
    'create',
    'mkdir',
    'save',
    'copy',
    'chmod',
    'chown',
    'install',
    'upload',
    'deploy',
    'commit',
    'push',
    'merge',
    'reset',
    'checkout'
  ].some((operation) => name.includes(operation))
}

export function museIssue(error: string): AgentProviderIssue {
  // Muse reports an in-runtime crash as the exception text itself; keep the
  // card body to the header line and the trace in Raw Error.
  const presentation = presentProviderError(error)
  const kind = classifyProviderIssue(error)
  const retryAt =
    kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(presentation.message) : undefined
  return {
    kind,
    message: presentation.message,
    rawError: error,
    harnessId: 'muse',
    retryable: retryAt !== undefined || kind === 'quota' || kind === 'rate_limit',
    ...(retryAt === undefined ? {} : { retryAt })
  }
}

export function musePermissionEvent(
  context: CliLineParseContext,
  state: MuseTurnState,
  event: Record<string, unknown>
): SessionAgentEvent | null {
  const details = record(event['request']) ?? record(event['approval']) ?? event
  const requestId = firstString(
    details['approval_id'],
    details['request_id'],
    details['prompt_id'],
    details['tool_call_id'],
    event['approval_id'],
    event['request_id']
  )
  if (!requestId || state.promotedInteractions.has(`permission:${requestId}`)) return null
  const toolName =
    firstString(details['tool_name'], details['operation'], details['name']) ?? 'permission'
  const input =
    parseRecord(details['input']) ??
    parseRecord(details['arguments']) ??
    parseRecord(details['args']) ??
    {}
  for (const key of ['command', 'path', 'cwd', 'description']) {
    const value = details[key]
    if (value !== undefined && input[key] === undefined) input[key] = value
  }
  state.promotedInteractions.add(`permission:${requestId}`)
  return {
    type: 'permission.asked',
    sessionId: context.sessionId,
    permission: {
      id: requestId,
      sessionId: context.sessionId,
      permission: toolName,
      patterns: permissionPatterns(input),
      metadata: { tool: toolName, input }
    }
  }
}

/** Normalize a Muse `tool.<name>` task kind / `tool:<name>` operation into a name. */
export function museToolName(value: unknown, strip: 'task_kind' | 'operation'): string | undefined {
  const raw = stringValue(value)
  if (!raw) return undefined
  const prefix = strip === 'task_kind' ? 'tool.' : 'tool:'
  if (!raw.startsWith(prefix)) return undefined
  const name = raw.slice(prefix.length)
  return name.length > 0 ? name : undefined
}
