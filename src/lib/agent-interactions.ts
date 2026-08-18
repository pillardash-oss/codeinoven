import type { AgentQuestion, AgentQuestionOption } from './types'

const TODO_TOOL_NAMES = new Set([
  'todo',
  'todos',
  'todowrite',
  'writetodo',
  'writetodos',
  'updatetodo',
  'updatetodos',
  'updateplan',
  'planupdate',
  'plan',
  'tasklist',
  'tasklistupdate',
  'updatetasklist',
  'checklist',
  'settasks',
  'taskcreate',
  'taskupdate',
  'tasklist'
])

const QUESTION_TOOL_NAMES = new Set([
  'askuserquestion',
  'requestuserinput',
  'requestinput',
  'question',
  'questions',
  'elicitation',
  'askquestion'
])

const PERMISSION_TOOL_NAMES = new Set([
  'permission',
  'permissions',
  'approval',
  'approvals',
  'requestpermission',
  'requestapproval',
  'toolpermission',
  'canusetool'
])

export function normalizeInteractionName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

export function isTodoToolName(value: string): boolean {
  const normalized = normalizeInteractionName(value)
  return (
    TODO_TOOL_NAMES.has(normalized) ||
    [...TODO_TOOL_NAMES].some((name) => normalized.endsWith(name))
  )
}

export function isQuestionToolName(value: string): boolean {
  const normalized = normalizeInteractionName(value)
  return (
    QUESTION_TOOL_NAMES.has(normalized) ||
    [...QUESTION_TOOL_NAMES].some((name) => normalized.endsWith(name))
  )
}

export function isPermissionToolName(value: string): boolean {
  const normalized = normalizeInteractionName(value)
  return (
    PERMISSION_TOOL_NAMES.has(normalized) ||
    [...PERMISSION_TOOL_NAMES].some((name) => normalized.endsWith(name))
  )
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return recordValue(value)
  try {
    return recordValue(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

export function firstString(...values: unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim()
}

/** Convert the common question shapes emitted by agent CLIs into the shared UI model. */
export function normalizeAgentQuestions(
  value: unknown,
  fallbackPrompt = 'The agent needs your input to continue.'
): AgentQuestion[] {
  const input = parseRecord(value) ?? {}
  const candidates = ['questions', 'prompts', 'items']
    .map((key) => input[key])
    .find((candidate): candidate is unknown[] => Array.isArray(candidate))
  if (candidates) {
    const questions = candidates
      .map((candidate, index) => normalizeQuestion(candidate, index))
      .filter((question): question is AgentQuestion => question !== null)
    if (questions.length > 0) return questions
  }
  const single = normalizeQuestion(input, 0)
  return single ? [single] : [{ prompt: fallbackPrompt, custom: true }]
}

function normalizeQuestion(value: unknown, index: number): AgentQuestion | null {
  const input = recordValue(value)
  if (!input) {
    const prompt = firstString(value)
    return prompt ? { prompt, custom: true } : null
  }
  const prompt = firstString(
    input['question'],
    input['prompt'],
    input['text'],
    input['message'],
    input['description'],
    input['title']
  )
  if (!prompt) return null
  const optionValues = input['options'] ?? input['choices'] ?? input['values']
  const options = Array.isArray(optionValues)
    ? optionValues
        .map((option) =>
          firstString(option, recordValue(option)?.['label'], recordValue(option)?.['name'])
        )
        .filter((option): option is string => option !== undefined)
    : []
  const richOptions = Array.isArray(optionValues)
    ? optionValues
        .map((option): AgentQuestionOption | null => {
          const entry = recordValue(option)
          if (!entry) {
            const label = firstString(option)
            return label ? { label } : null
          }
          const label = firstString(entry['label'], entry['name'], entry['value'])
          if (!label) return null
          return {
            label,
            ...(firstString(entry['description'], entry['detail'], entry['help'])
              ? { description: firstString(entry['description'], entry['detail'], entry['help']) }
              : {}),
            ...(entry['recommended'] === true || /\(recommended\)/iu.test(label)
              ? { recommended: true }
              : {})
          }
        })
        .filter((option): option is AgentQuestionOption => option !== null)
    : []
  const header = firstString(input['header'], input['label'])
  const description = firstString(input['description'], input['help'])
  return {
    prompt,
    ...(header ? { header } : {}),
    ...(description && description !== prompt ? { description } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(richOptions.length > 0 ? { richOptions } : {}),
    ...(input['multiple'] === true || input['multiSelect'] === true ? { multiple: true } : {}),
    ...(input['custom'] === false || input['allowCustom'] === false ? { custom: false } : {}),
    rawInput: JSON.stringify({ index, ...input })
  }
}

export function permissionPatterns(input: Record<string, unknown>): string[] {
  const patterns = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) patterns.add(value.trim())
    if (Array.isArray(value)) value.forEach(add)
  }
  for (const key of [
    'command',
    'cwd',
    'path',
    'filePath',
    'file_path',
    'paths',
    'pattern',
    'blocked_path',
    'blockedPath'
  ])
    add(input[key])
  return [...patterns]
}
