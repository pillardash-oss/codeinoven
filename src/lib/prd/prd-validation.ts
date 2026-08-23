import { PRD_SECTION_IDS, type PrdContent, type PrdSection, type PrdSectionId } from '../types'

export const PRD_SECTION_DEFINITIONS = [
  { id: 'problem', title: 'Problem' },
  { id: 'goals', title: 'Goals' },
  { id: 'non_goals', title: 'Non-goals' },
  { id: 'users_and_use_cases', title: 'Users and Use Cases' },
  { id: 'product_requirements', title: 'Product Requirements' },
  { id: 'experience_flow', title: 'Experience Flow' },
  { id: 'acceptance_criteria', title: 'Acceptance Criteria' },
  { id: 'dependencies', title: 'Dependencies' },
  { id: 'risks', title: 'Risks' },
  { id: 'open_questions', title: 'Open Questions' }
] as const satisfies ReadonlyArray<{ id: PrdSectionId; title: string }>

export const PRD_DOCUMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'sections'],
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    sections: {
      type: 'array',
      minItems: PRD_SECTION_IDS.length,
      maxItems: PRD_SECTION_IDS.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'markdown'],
        properties: {
          id: { type: 'string', enum: PRD_SECTION_IDS },
          title: { type: 'string', minLength: 1 },
          markdown: { type: 'string' }
        }
      }
    }
  }
} as const

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('PRD document must be an object')
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

export function parseGeneratedPrdContent(value: unknown): PrdContent {
  const input = record(value)
  if (!Array.isArray(input.sections)) throw new TypeError('PRD sections must be an array')
  const sections = new Map<PrdSectionId, PrdSection>()
  for (const rawSection of input.sections) {
    const section = record(rawSection)
    const id = text(section.id, 'PRD section ID') as PrdSectionId
    const definition = PRD_SECTION_DEFINITIONS.find((candidate) => candidate.id === id)
    if (!definition) throw new TypeError(`Unsupported PRD section: ${id}`)
    if (sections.has(id)) throw new TypeError(`PRD section ${id} must appear once`)
    const title = text(section.title, `PRD section ${id} title`)
    if (title !== definition.title) {
      throw new TypeError(`PRD section ${id} title must be "${definition.title}"`)
    }
    sections.set(id, {
      id,
      title,
      markdown: text(section.markdown, `PRD section ${id} Markdown`, id === 'open_questions')
    })
  }
  for (const definition of PRD_SECTION_DEFINITIONS) {
    if (!sections.has(definition.id))
      throw new TypeError(`PRD section ${definition.id} is required`)
  }
  return {
    title: text(input.title, 'PRD title'),
    summary: text(input.summary, 'PRD summary'),
    sections: PRD_SECTION_DEFINITIONS.map((definition) => sections.get(definition.id) as PrdSection)
  }
}
