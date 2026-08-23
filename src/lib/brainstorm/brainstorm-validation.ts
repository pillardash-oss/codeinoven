import type {
  BrainstormContent,
  BrainstormPrototype,
  BrainstormSection,
  BrainstormSectionId
} from '../types'

export const BRAINSTORM_SECTION_DEFINITIONS = [
  { id: 'context', title: 'What We Learned', legacyTitle: 'Context', required: true },
  { id: 'goals', title: 'What We Are Building', legacyTitle: 'Goals', required: true },
  { id: 'decisions', title: 'Aligned Decisions', legacyTitle: 'Decisions', required: true },
  {
    id: 'open_questions',
    title: 'Still to Decide',
    legacyTitle: 'Open Questions',
    required: true
  },
  { id: 'constraints', title: 'Boundaries', legacyTitle: 'Constraints', required: true },
  {
    id: 'proposed_direction',
    title: 'Agreed Direction',
    legacyTitle: 'Proposed Direction',
    required: true
  },
  {
    id: 'additional_info',
    title: 'Additional Notes',
    legacyTitle: 'Additional Info',
    required: false
  }
] as const satisfies ReadonlyArray<{
  id: BrainstormSectionId
  title: string
  legacyTitle: string
  required: boolean
}>

const DEFINITION_BY_ID = new Map<
  BrainstormSectionId,
  (typeof BRAINSTORM_SECTION_DEFINITIONS)[number]
>(BRAINSTORM_SECTION_DEFINITIONS.map((definition) => [definition.id, definition]))

export const BRAINSTORM_DOCUMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'sections'],
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Two-to-four sentence snapshot of the Brainstorm session.'
    },
    sections: {
      type: 'array',
      minItems: 6,
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'markdown'],
        properties: {
          id: {
            type: 'string',
            enum: BRAINSTORM_SECTION_DEFINITIONS.map((definition) => definition.id)
          },
          title: { type: 'string', minLength: 1 },
          markdown: { type: 'string' }
        }
      }
    },
    prototypes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'fidelity',
          'title',
          'entryFile',
          'artifactPath',
          'previewPath',
          'contentHash',
          'createdAt'
        ],
        properties: {
          id: { type: 'string', pattern: '^[LH][1-9][0-9]*$' },
          fidelity: { type: 'string', enum: ['lofi', 'hifi'] },
          title: { type: 'string', minLength: 1 },
          parentPrototypeId: { type: 'string', pattern: '^L[1-9][0-9]*$' },
          entryFile: { type: 'string', minLength: 1 },
          artifactPath: { type: 'string', minLength: 1 },
          previewPath: { type: 'string', minLength: 1 },
          contentHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          createdAt: { type: 'integer', minimum: 0 }
        }
      }
    }
  }
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

function parseSection(value: unknown, index: number): BrainstormSection {
  if (!isRecord(value)) throw new TypeError(`Brainstorm section ${index} must be an object`)
  const id = requireString(value.id, `Brainstorm section ${index} ID`) as BrainstormSectionId
  const definition = DEFINITION_BY_ID.get(id)
  if (!definition) throw new TypeError(`Unsupported brainstorm section: ${id}`)
  const title = requireString(value.title, `Brainstorm section ${id} title`)
  if (title !== definition.title && title !== definition.legacyTitle) {
    throw new TypeError(
      `Brainstorm section ${id} title must be "${definition.title}" or "${definition.legacyTitle}"`
    )
  }
  return {
    id,
    title,
    markdown: requireString(value.markdown, `Brainstorm section ${id} Markdown`, true)
  }
}

/** Validates structured model output and returns sections in canonical display order. */
export function parseGeneratedBrainstormContent(value: unknown): BrainstormContent {
  if (!isRecord(value)) throw new TypeError('Brainstorm document must be an object')
  const title = requireString(value.title, 'Brainstorm title')
  const summary = requireString(value.summary, 'Brainstorm summary')
  if (!Array.isArray(value.sections)) throw new TypeError('Brainstorm sections must be an array')

  const parsed = value.sections.map(parseSection)
  const sections = new Map<BrainstormSectionId, BrainstormSection>()
  const seen = new Set<BrainstormSectionId>()
  for (const section of parsed) {
    if (seen.has(section.id)) {
      throw new TypeError(`Brainstorm section ${section.id} must appear at most once`)
    }
    seen.add(section.id)
    if (section.id === 'additional_info' && section.markdown.trim().length === 0) continue
    sections.set(section.id, section)
  }

  for (const definition of BRAINSTORM_SECTION_DEFINITIONS) {
    if (definition.required && !sections.has(definition.id)) {
      throw new TypeError(`Brainstorm section ${definition.id} is required`)
    }
  }

  const prototypes = parsePrototypes(value.prototypes)
  return {
    title,
    summary,
    sections: BRAINSTORM_SECTION_DEFINITIONS.flatMap((definition) => {
      const section = sections.get(definition.id)
      return section ? [section] : []
    }),
    ...(prototypes ? { prototypes } : {})
  }
}

function parsePrototypes(value: unknown): BrainstormPrototype[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Brainstorm prototypes must be a non-empty array when present')
  }
  const seen = new Set<string>()
  return value.map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`Brainstorm prototype ${index} must be an object`)
    const id = requireString(raw.id, `Brainstorm prototype ${index} ID`)
    if (!/^[LH][1-9][0-9]*$/u.test(id) || seen.has(id)) {
      throw new TypeError(`Invalid or duplicate Brainstorm prototype ID: ${id}`)
    }
    seen.add(id)
    const fidelity = raw.fidelity
    if (fidelity !== 'lofi' && fidelity !== 'hifi') {
      throw new TypeError(`Brainstorm prototype ${id} has invalid fidelity`)
    }
    if ((fidelity === 'lofi') !== id.startsWith('L')) {
      throw new TypeError(`Brainstorm prototype ${id} fidelity does not match its ID`)
    }
    const parentPrototypeId =
      raw.parentPrototypeId === undefined
        ? undefined
        : requireString(raw.parentPrototypeId, `Brainstorm prototype ${id} parent`)
    if (parentPrototypeId && !/^L[1-9][0-9]*$/u.test(parentPrototypeId)) {
      throw new TypeError(`Brainstorm prototype ${id} parent must be a LoFi identifier`)
    }
    const createdAt = raw.createdAt
    if (!Number.isSafeInteger(createdAt) || Number(createdAt) < 0) {
      throw new TypeError(`Brainstorm prototype ${id} createdAt must be a timestamp`)
    }
    const contentHash = requireString(raw.contentHash, `Brainstorm prototype ${id} content hash`)
    if (!/^[a-f0-9]{64}$/u.test(contentHash)) {
      throw new TypeError(`Brainstorm prototype ${id} content hash must be SHA-256`)
    }
    return {
      id,
      fidelity,
      title: requireString(raw.title, `Brainstorm prototype ${id} title`),
      ...(parentPrototypeId ? { parentPrototypeId } : {}),
      entryFile: requireString(raw.entryFile, `Brainstorm prototype ${id} entry file`),
      artifactPath: requireString(raw.artifactPath, `Brainstorm prototype ${id} artifact path`),
      previewPath: requireString(raw.previewPath, `Brainstorm prototype ${id} preview path`),
      contentHash,
      createdAt: Number(createdAt)
    }
  })
}

const FALLBACK_SECTION_KEYS: Record<BrainstormSectionId, string[]> = {
  context: ['context'],
  goals: ['goals'],
  decisions: ['decisions'],
  open_questions: ['open_questions', 'openQuestions', 'Open Questions'],
  constraints: ['constraints'],
  proposed_direction: ['proposed_direction', 'proposedDirection', 'Proposed Direction'],
  additional_info: ['additional_info', 'additionalInfo', 'Additional Info']
}

function fallbackSectionMarkdown(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!isRecord(value)) return null
  for (const key of ['markdown', 'content', 'body']) {
    if (typeof value[key] === 'string') return value[key]
  }
  return null
}

/** Normalize common JSON-only model shapes, then enforce the canonical contract. */
export function parseGeneratedBrainstormFallbackContent(value: unknown): BrainstormContent {
  if (!isRecord(value) || Array.isArray(value.sections)) {
    return parseGeneratedBrainstormContent(value)
  }
  const sectionSource = isRecord(value.sections) ? value.sections : value
  const sections = BRAINSTORM_SECTION_DEFINITIONS.flatMap((definition) => {
    const candidate = FALLBACK_SECTION_KEYS[definition.id]
      .map((key) => sectionSource[key])
      .find((entry) => entry !== undefined)
    const markdown = fallbackSectionMarkdown(candidate)
    if (markdown === null) return []
    return [{ id: definition.id, title: definition.title, markdown }]
  })
  return parseGeneratedBrainstormContent({ ...value, sections })
}
