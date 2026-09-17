import type { PermissionLevel, ThreadSettings } from '../../../lib/types'
import type { CodexServerRequest } from './codex-protocol'
import { recordValue, stringValue } from './codex-values'

/** Codex question tool, sandbox/approval policy, config and item normalization. */

/** Compatibility fallback for Codex versions that expose their native async
 * question item in default mode. The CIO-owned dynamic tool below is the
 * authoritative, mode-independent path. */
export const CODEX_DEFAULT_QUESTION_CONFIG = 'tools.experimental_request_user_input={}'
export const CODEX_ASYNC_QUESTION_METHOD = 'item/tool/requestUserInputAsync'
export const CODEX_DYNAMIC_QUESTION_METHOD = 'item/tool/call:cio_ask_user'
export const CODEX_QUESTION_TOOL_NAME = 'cio_ask_user'
export const CODEX_QUESTION_TOOL = {
  name: CODEX_QUESTION_TOOL_NAME,
  description:
    'Ask the user one to three structured questions in CodeInOven and wait for their answers. Use this instead of writing a question or choices as assistant text.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            question: { type: 'string', minLength: 1 },
            header: { type: 'string', minLength: 1, maxLength: 40 },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', minLength: 1 },
                  description: { type: 'string', minLength: 1 }
                },
                required: ['label', 'description']
              }
            },
            multiple: { type: 'boolean' }
          },
          required: ['question', 'header', 'options']
        }
      }
    },
    required: ['questions']
  }
} as const
export const CODEX_QUESTION_INSTRUCTION =
  'The application `question` tool is `cio_ask_user`. Whenever the application instructions require a question or user choice, call `cio_ask_user` immediately; do not render the prompt or options as ordinary assistant text. This tool is available in every mode.'

export function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/gu, '_')
      .replace(/^_+|_+$/gu, '') || 'utility'
  )
}

export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`
}

export function tomlStringMap(values: Record<string, string>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${tomlString(key)} = ${tomlString(value)}`
  )
  return `{ ${entries.join(', ')} }`
}

export function sandboxFor(readOnly: boolean, permissionLevel: PermissionLevel): string {
  if (readOnly) return 'read-only'
  return permissionLevel === 'full_access' ? 'danger-full-access' : 'workspace-write'
}

export function codexApprovalPolicy(
  readOnly: boolean,
  permissionLevel: PermissionLevel
): 'never' | 'on-request' {
  return readOnly || permissionLevel === 'full_access' ? 'never' : 'on-request'
}

export function isCodexPermissionRequest(method: string): boolean {
  return (
    method === 'item/commandExecution/requestApproval' ||
    method === 'item/fileChange/requestApproval' ||
    method === 'item/permissions/requestApproval'
  )
}

export function isCodexQuestionRequest(method: string): boolean {
  return method === 'item/tool/requestUserInput'
}

export function isCodexAsyncQuestion(request: CodexServerRequest): boolean {
  return request.method === CODEX_ASYNC_QUESTION_METHOD
}

export function isCodexDynamicQuestion(request: CodexServerRequest): boolean {
  return request.method === CODEX_DYNAMIC_QUESTION_METHOD
}

export function isCodexDynamicQuestionItem(item: Record<string, unknown>): boolean {
  return (
    stringValue(item['type']) === 'function_call' &&
    (stringValue(item['tool']) ?? stringValue(item['name'])) === CODEX_QUESTION_TOOL_NAME
  )
}

export function codexQuestionIds(params: Record<string, unknown>): string[] {
  const questions = Array.isArray(params['questions']) ? params['questions'] : []
  return questions.map((question, index) => {
    const entry = recordValue(question)
    return stringValue(entry?.['id']) ?? `question-${index}`
  })
}

export function codexSandboxPolicy(
  projectPath: string,
  readOnly: boolean,
  permissionLevel: PermissionLevel
): Record<string, unknown> {
  if (readOnly) return { type: 'readOnly', networkAccess: false }
  if (permissionLevel === 'full_access') return { type: 'dangerFullAccess' }
  return {
    type: 'workspaceWrite',
    writableRoots: [projectPath],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

export function codexEffort(value: ThreadSettings['thinkingLevel']): string {
  // Codex calls its lowest supported reasoning effort `low`; `minimal` is the
  // cross-harness alias used by the app and by lightweight internal turns.
  if (value === 'minimal') return 'low'
  return value
}

export function isUnsupportedReasoningSummary(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('reasoning.summary') &&
    (normalized.includes('unsupported parameter') || normalized.includes('unsupported_parameter'))
  )
}

export function normalizeAppServerItem(
  item: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!item) return null
  const rawType = stringValue(item['type'])
  const types: Record<string, string> = {
    agentMessage: 'agent_message',
    userMessage: 'user_message',
    commandExecution: 'command_execution',
    fileChange: 'file_change',
    mcpToolCall: 'mcp_tool_call',
    dynamicToolCall: 'function_call',
    collabToolCall: 'collab_tool_call',
    planUpdate: 'plan_update',
    todoList: 'todo_list'
  }
  return {
    ...item,
    type: rawType ? (types[rawType] ?? rawType) : rawType,
    aggregated_output: item['aggregated_output'] ?? item['aggregatedOutput'],
    exit_code: item['exit_code'] ?? item['exitCode']
  }
}

export interface CodexConfigEdit {
  keyPath: string
  value: unknown
  mergeStrategy: 'upsert'
}

export function parseCodexConfigEdits(
  args: string,
  commandName: 'config' | 'settings'
): CodexConfigEdit[] {
  const assignments = args.trim().split(/\s+/u).filter(Boolean)
  if (assignments.length === 0) {
    throw new Error(`/${commandName} requires one or more key=value arguments in Codex`)
  }

  return assignments.map((assignment) => {
    const separator = assignment.indexOf('=')
    const keyPath = separator > 0 ? assignment.slice(0, separator) : ''
    const rawValue = separator >= 0 ? assignment.slice(separator + 1) : ''
    if (!keyPath || !rawValue || !/^[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_/-]+)*$/u.test(keyPath)) {
      throw new Error(`Invalid Codex config assignment: ${assignment}`)
    }

    let value: unknown = rawValue
    try {
      value = JSON.parse(rawValue) as unknown
    } catch {
      // Bare values are valid TOML strings; JSON literals keep their native type.
    }
    return { keyPath, value, mergeStrategy: 'upsert' }
  })
}
