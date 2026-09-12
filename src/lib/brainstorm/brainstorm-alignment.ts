import type { ResolvedUtility } from '../types'

export const BRAINSTORM_ALIGNMENT_UTILITY_ID = 'cio:brainstorm-alignment'
export const BRAINSTORM_ALIGNMENT_NOTE_LIMIT = 24_000
export const BRAINSTORM_CREATE_DOCUMENT_ANSWER = 'Create document (Recommended)'

export function brainstormDocumentQuestion(version: number): string {
  return `Should I create Brainstorm v${version} from our aligned discussion?`
}

export function isBrainstormDocumentQuestion(prompt: string): boolean {
  return /^Should I create Brainstorm v[1-9]\d* from our aligned discussion\?$/u.test(prompt)
}

export function brainstormAlignmentUtility(
  harnessId: string,
  projectId: string,
  threadId: string
): ResolvedUtility {
  const binding = { harnessId, strategy: 'skill' as const }
  return {
    binding,
    utility: {
      id: BRAINSTORM_ALIGNMENT_UTILITY_ID,
      kind: 'skill',
      name: 'Brainstorm alignment notes',
      description:
        'Save concise interview notes for the next Brainstorm version without generating a document.',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'thread', projectId, threadId },
      config: {
        instructions:
          'Use save_notes with { markdown } to save the complete, concise notes for the current interview round. Preserve intent, confirmed choices, rationale, research sources, rejected alternatives, constraints, and unresolved questions. This never creates a Brainstorm document or approves generation.'
      },
      credentials: [],
      harnessBindings: [binding],
      appOwned: true,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

export const BRAINSTORM_ALIGNMENT_OPERATIONS = [
  {
    name: 'save_notes',
    description:
      'Replace the current round’s alignment notes with a concise cumulative Markdown summary. Save before asking questions and before ending each interview turn. Never discard earlier confirmed intent or sources. The application chooses the version and path.',
    inputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', minLength: 1, maxLength: BRAINSTORM_ALIGNMENT_NOTE_LIMIT }
      },
      required: ['markdown'],
      additionalProperties: false
    }
  }
]
