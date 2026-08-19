import type { EngineeringSpec, EngineeringSpecContent, SpecPhase } from '../types'

const SECTION_ORDER = [
  'TL;DR',
  'Problem',
  'Resolution',
  'Success Criteria',
  'Test Strategy',
  'Documentation',
  'Additional Info',
  'Commit Pattern',
  'Constraints & Risks'
] as const

type MarkdownSectionName = (typeof SECTION_ORDER)[number]

export interface EngineeringSpecMarkdownImport {
  content: EngineeringSpecContent
}

export class SpecMarkdownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecMarkdownError'
  }
}

function block(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
}

/** Exports the TL;DR plus seven required sections and optional Additional Info in canonical order. */
export function exportEngineeringSpecMarkdown(spec: EngineeringSpec): string {
  const { content } = spec
  return [
    `# ${spec.id} — Specification v${spec.version}`,
    '',
    '## TL;DR',
    '',
    content.resolutionSummary,
    '',
    '## Problem',
    '',
    block(content.problem),
    '',
    '## Resolution',
    '',
    block({
      phases: content.phases
    }),
    '',
    '## Success Criteria',
    '',
    block(content.successCriteria),
    '',
    '## Test Strategy',
    '',
    block(content.testStrategy),
    '',
    '## Documentation',
    '',
    block(content.documentationRequirements),
    '',
    ...(content.additionalInfo?.trim()
      ? ['## Additional Info', '', block(content.additionalInfo), '']
      : []),
    '## Commit Pattern',
    '',
    block(content.commitPattern),
    '',
    '## Constraints & Risks',
    '',
    block({
      constraints: content.constraints,
      risks: content.risks
    }),
    ''
  ].join('\n')
}

function extractSections(markdown: string): Map<MarkdownSectionName, string> {
  const sections = new Map<MarkdownSectionName, string>()
  const headingPattern = /^## (.+?)\s*$/gm
  const matches = [...markdown.matchAll(headingPattern)].filter((match) =>
    SECTION_ORDER.includes(match[1] as MarkdownSectionName)
  )

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const name = match[1]
    const sectionName = name as MarkdownSectionName
    if (sections.has(sectionName)) {
      throw new SpecMarkdownError(`Section "${sectionName}" appears more than once.`)
    }

    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? markdown.length
    sections.set(sectionName, markdown.slice(start, end).trim())
  }

  for (const sectionName of SECTION_ORDER.filter(
    (name) => name !== 'TL;DR' && name !== 'Additional Info'
  )) {
    if (!sections.has(sectionName)) {
      throw new SpecMarkdownError(`Missing required heading "## ${sectionName}".`)
    }
  }

  return sections
}

function parseBlock(sectionName: MarkdownSectionName, source: string): unknown {
  const match = source.match(/^```json\s*\n([\s\S]*?)\n```\s*$/)
  if (!match) {
    throw new SpecMarkdownError(
      `Section "${sectionName}" must contain exactly one fenced JSON block.`
    )
  }

  try {
    return JSON.parse(match[1])
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : 'unknown JSON error'
    throw new SpecMarkdownError(`Section "${sectionName}" contains invalid JSON: ${detail}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, section: MarkdownSectionName): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SpecMarkdownError(`Section "${section}" must contain a JSON object.`)
  }
  return value
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== 'string') {
    throw new SpecMarkdownError(`${location} must be a string.`)
  }
  return value
}

function requireStringArray(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new SpecMarkdownError(`${location} must be an array of strings.`)
  }
  return value
}

function isPhase(value: unknown): value is SpecPhase {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.objective !== 'string' ||
    typeof value.commit !== 'string' ||
    !Array.isArray(value.checkpoints) ||
    !Array.isArray(value.fileOperations)
  ) {
    return false
  }

  const checkpointsValid = value.checkpoints.every(
    (checkpoint) =>
      isRecord(checkpoint) &&
      typeof checkpoint.id === 'string' &&
      typeof checkpoint.description === 'string' &&
      typeof checkpoint.evidence === 'string'
  )
  const operationsValid = value.fileOperations.every(
    (operation) =>
      isRecord(operation) &&
      typeof operation.path === 'string' &&
      (operation.operation === 'create' ||
        operation.operation === 'edit' ||
        operation.operation === 'delete') &&
      typeof operation.reason === 'string'
  )
  return checkpointsValid && operationsValid
}

function requirePhases(value: unknown): SpecPhase[] {
  if (!Array.isArray(value) || !value.every(isPhase)) {
    throw new SpecMarkdownError(
      'Resolution.phases must be an array of phases with typed checkpoints and file operations.'
    )
  }
  return value
}

/** Imports the Markdown contract, including optional Additional Info. */
export function importEngineeringSpecMarkdown(markdown: string): EngineeringSpecMarkdownImport {
  if (markdown.trim().length === 0) {
    throw new SpecMarkdownError('Specification Markdown is empty.')
  }

  const sections = extractSections(markdown)
  const problem = requireString(parseBlock('Problem', sections.get('Problem') ?? ''), 'Problem')
  const resolution = requireRecord(
    parseBlock('Resolution', sections.get('Resolution') ?? ''),
    'Resolution'
  )
  const resolutionSummary = sections.has('TL;DR')
    ? requireString(sections.get('TL;DR'), 'TL;DR')
    : requireString(resolution.summary, 'Resolution.summary')
  const constraints = requireRecord(
    parseBlock('Constraints & Risks', sections.get('Constraints & Risks') ?? ''),
    'Constraints & Risks'
  )

  return {
    content: {
      problem,
      resolutionSummary,
      phases: requirePhases(resolution.phases),
      successCriteria: requireStringArray(
        parseBlock('Success Criteria', sections.get('Success Criteria') ?? ''),
        'Success Criteria'
      ),
      testStrategy: requireString(
        parseBlock('Test Strategy', sections.get('Test Strategy') ?? ''),
        'Test Strategy'
      ),
      documentationRequirements: requireStringArray(
        parseBlock('Documentation', sections.get('Documentation') ?? ''),
        'Documentation'
      ),
      ...(sections.has('Additional Info')
        ? {
            additionalInfo: requireString(
              parseBlock('Additional Info', sections.get('Additional Info') ?? ''),
              'Additional Info'
            )
          }
        : {}),
      commitPattern: requireString(
        parseBlock('Commit Pattern', sections.get('Commit Pattern') ?? ''),
        'Commit Pattern'
      ),
      constraints: requireStringArray(constraints.constraints, 'Constraints & Risks.constraints'),
      risks: requireStringArray(constraints.risks, 'Constraints & Risks.risks')
    }
  }
}
