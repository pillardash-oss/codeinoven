import { validateBoundedString } from '../../ipc/ipc-validation'
import type { BrainstormContent, EngineeringSpecContent, MemoryScope } from '../../../lib/types'
import {
  ASSIGNMENT_PLAN_SCHEMA,
  PROPOSE_MEMORY_SCHEMA,
  SPEC_GENERATION_SCHEMA
} from '../../../lib/agent-tools'
import { generateId } from '../../../lib/utils'
import { parseGeneratedAssignmentContent } from '../../../lib/assignment/assignment-validation'
import { GeneratedJsonParseError, GeneratedSpecOutputError } from './chat-engine-errors'
import type { StructuredMemoryProposal } from './chat-engine-types'

/** Spec-generation contract schema, optionally requiring the Assignment graph. */
export function specGenerationSchema(assignmentRequired: boolean): Record<string, unknown> {
  return assignmentRequired
    ? {
        ...SPEC_GENERATION_SCHEMA,
        properties: {
          ...(SPEC_GENERATION_SCHEMA.properties as Record<string, unknown>),
          assignment: ASSIGNMENT_PLAN_SCHEMA
        },
        required: [...((SPEC_GENERATION_SCHEMA.required as string[]) ?? []), 'assignment']
      }
    : SPEC_GENERATION_SCHEMA
}

export function requireEvidenceDrivenBrainstorm(content: BrainstormContent): BrainstormContent {
  const sectionMarkdown = new Map(
    content.sections.map((section) => [section.id, section.markdown.trim()])
  )
  const requirements: ReadonlyArray<[BrainstormContent['sections'][number]['id'], RegExp, string]> =
    [['context', /\b(?:Verified|Inferred|Unknown)\b/iu, 'evidence confidence labels']]
  const missing = requirements.flatMap(([sectionId, pattern, label]) =>
    pattern.test(sectionMarkdown.get(sectionId) ?? '') ? [] : [label]
  )
  if (missing.length > 0) {
    throw new TypeError(`Brainstorm research is incomplete: ${missing.join(', ')}`)
  }
  return content
}

export function parseGeneratedSpecContent(
  raw: string,
  assignmentRequired = false
): EngineeringSpecContent {
  let parsed: unknown
  try {
    parsed = parseGeneratedJson(raw, 'The spec agent returned invalid JSON')
  } catch (error) {
    if (error instanceof GeneratedJsonParseError) {
      throw new GeneratedSpecOutputError(error.message, error.rawOutput)
    }
    throw error
  }
  return validateGeneratedSpecContent(parsed, assignmentRequired)
}

export function parseGeneratedJson(raw: string, invalidMessage: string): unknown {
  const direct = parseJsonCandidate(raw.trim())
  if (direct.ok) return direct.value
  let exactError = direct.error

  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    const end = findJsonObjectEnd(raw, start)
    if (end === null) continue
    const parsed = parseJsonCandidate(raw.slice(start, end + 1))
    if (parsed.ok) return parsed.value
    exactError = parsed.error
  }

  throw new GeneratedJsonParseError(`${invalidMessage}: ${exactError}`, raw)
}

export type ParsedJsonCandidate = { ok: true; value: unknown } | { ok: false; error: string }

export function parseJsonCandidate(candidate: string): ParsedJsonCandidate {
  if (!candidate) return { ok: false, error: 'The response was empty.' }
  try {
    return { ok: true, value: JSON.parse(candidate) as unknown }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'The JSON parser rejected the response.'
    }
  }
}

export function findJsonObjectEnd(raw: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return null
}

export function memoryProposalSchemaProperties(): Record<string, unknown> {
  const properties = PROPOSE_MEMORY_SCHEMA['properties']
  if (!isRecord(properties)) throw new Error('The memory proposal schema is invalid')
  return properties
}

export function parseStructuredMemoryProposal(
  raw: string,
  allowedScopes: readonly MemoryScope[]
): StructuredMemoryProposal {
  const parsed = parseGeneratedJson(raw, 'The memory extractor returned invalid JSON')
  return validateStructuredMemoryProposal(parsed, allowedScopes)
}

export function validateStructuredMemoryProposal(
  value: unknown,
  allowedScopes: readonly MemoryScope[]
): StructuredMemoryProposal {
  if (!isRecord(value)) throw new Error('The memory extractor returned an invalid object')
  if (typeof value.propose !== 'boolean') {
    throw new TypeError('Memory proposal decision is invalid')
  }
  if (!value.propose) {
    return {
      propose: false,
      title: '',
      content: '',
      category: 'preference',
      priority: 'low',
      scope: allowedScopes[0] ?? 'global'
    }
  }
  return {
    propose: true,
    title: validateBoundedString(value.title, 'Memory title', 1, 80),
    content: validateBoundedString(value.content, 'Memory content', 1, 4_096),
    category: validateMemoryEnum(
      value.category,
      ['behavioral', 'project-rule', 'identity', 'preference', 'models'],
      'Memory category'
    ),
    priority: validateMemoryEnum(
      value.priority,
      ['critical', 'high', 'medium', 'low'],
      'Memory priority'
    ),
    scope: validateMemoryEnum(value.scope, allowedScopes, 'Memory scope')
  }
}

export function validateMemoryEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  label: string
): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new TypeError(`${label} is invalid`)
  }
  return value as Value
}

export function validateGeneratedSpecContent(
  parsed: unknown,
  assignmentRequired = false
): EngineeringSpecContent {
  try {
    return validateGeneratedSpecContentUnchecked(parsed, assignmentRequired)
  } catch (error) {
    if (error instanceof GeneratedSpecOutputError) throw error
    throw new GeneratedSpecOutputError(
      error instanceof Error ? error.message : 'The spec agent returned an invalid object',
      stringifyRejectedSpecOutput(parsed)
    )
  }
}

export function stringifyRejectedSpecOutput(parsed: unknown): string {
  try {
    return `${JSON.stringify(parsed, null, 2)}\n`
  } catch {
    return String(parsed)
  }
}

export function validateGeneratedSpecContentUnchecked(
  parsed: unknown,
  assignmentRequired = false
): EngineeringSpecContent {
  if (!isRecord(parsed)) throw new Error('The spec agent returned an invalid object')
  const assignment =
    parsed.assignment === undefined ? undefined : parseGeneratedAssignmentContent(parsed.assignment)
  const additionalInfo = optionalGeneratedString(parsed.additionalInfo)
  if (assignmentRequired && !assignment) {
    throw new Error('The Sr. Engineer did not return the required Assignment graph')
  }

  return {
    problem: requiredGeneratedString(parsed.problem, 'problem'),
    resolutionSummary: requiredGeneratedString(parsed.resolutionSummary, 'resolution summary'),
    phases: requiredGeneratedArray(parsed.phases, 'phases').map((value) => {
      if (!isRecord(value)) throw new Error('A generated phase is invalid')
      const phaseId = optionalGeneratedString(value.id) ?? generateId()
      const checkpoints =
        Array.isArray(value.checkpoints) && value.checkpoints.length > 0
          ? value.checkpoints
          : (assignment?.tasks
              .filter((task) => task.phaseId === phaseId)
              .map((task) => ({
                id: generateId(),
                description: task.title,
                evidence: task.auditChecklist.join('; ')
              })) ?? requiredGeneratedArray(value.checkpoints, 'phase checkpoints'))
      return {
        id: phaseId,
        title: requiredGeneratedString(value.title, 'phase title'),
        objective: requiredGeneratedString(value.objective, 'phase objective'),
        checkpoints: checkpoints.map((checkpoint) => {
          if (!isRecord(checkpoint)) {
            throw new Error('A generated checkpoint is invalid')
          }
          return {
            id: optionalGeneratedString(checkpoint.id) ?? generateId(),
            description: requiredGeneratedString(checkpoint.description, 'checkpoint description'),
            evidence: requiredGeneratedString(checkpoint.evidence, 'checkpoint evidence')
          }
        }),
        fileOperations: Array.isArray(value.fileOperations)
          ? value.fileOperations.map((operation) => {
              if (!isRecord(operation)) {
                throw new Error('A generated file operation is invalid')
              }
              const operationType = operation.operation
              if (
                operationType !== 'create' &&
                operationType !== 'edit' &&
                operationType !== 'delete'
              ) {
                throw new Error('A generated file operation has an invalid type')
              }
              return {
                path: requiredGeneratedString(operation.path, 'file path'),
                operation: operationType,
                reason: requiredGeneratedString(operation.reason, 'file operation reason')
              }
            })
          : [],
        commit: requiredGeneratedString(value.commit, 'phase commit')
      }
    }),
    successCriteria: generatedStringArray(parsed.successCriteria, 'success criteria'),
    testStrategy: requiredGeneratedString(parsed.testStrategy, 'test strategy'),
    documentationRequirements: generatedStringArray(
      parsed.documentationRequirements,
      'documentation requirements'
    ),
    ...(additionalInfo ? { additionalInfo } : {}),
    commitPattern: requiredGeneratedString(parsed.commitPattern, 'commit pattern'),
    constraints: optionalGeneratedStringArray(parsed.constraints),
    risks: optionalGeneratedStringArray(parsed.risks),
    ...(assignment ? { assignment } : {})
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function permissionCommands(metadata: Record<string, unknown>): string[] {
  const commands = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || !isRecord(value)) return
    for (const [key, candidate] of Object.entries(value)) {
      if (key === 'command' || key === 'cmd' || key === 'script') {
        if (typeof candidate === 'string' && candidate.trim()) commands.add(candidate.trim())
        if (Array.isArray(candidate)) {
          const tokens = candidate.filter(
            (token): token is string => typeof token === 'string' && token.trim().length > 0
          )
          if (tokens.length > 0) {
            commands.add(tokens.join(' '))
            for (const token of tokens) commands.add(token.trim())
          }
        }
      }
      if (isRecord(candidate)) visit(candidate, depth + 1)
    }
  }
  visit(metadata, 0)
  return [...commands]
}

export function requiredGeneratedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`The generated ${label} is missing`)
  }
  return value.trim()
}

export function optionalGeneratedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function requiredGeneratedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`The generated ${label} are missing`)
  }
  return value
}

export function generatedStringArray(value: unknown, label: string): string[] {
  return requiredGeneratedArray(value, label).map((item) => requiredGeneratedString(item, label))
}

export function optionalGeneratedStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}
