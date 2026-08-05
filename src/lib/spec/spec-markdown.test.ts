import { describe, expect, it } from 'vitest'
import type { EngineeringSpec } from '../types'
import {
  exportEngineeringSpecMarkdown,
  importEngineeringSpecMarkdown,
  SpecMarkdownError
} from './spec-markdown'

function createSpec(): EngineeringSpec {
  return {
    schemaVersion: 1,
    id: 'SPEC-01',
    projectId: 'project-1',
    threadId: 'thread-1',
    version: 3,
    status: 'draft',
    content: {
      problem: 'Preserve **structured** intent.\n\nIncluding multiple paragraphs.',
      resolutionSummary: 'Produce a reviewed implementation plan.',
      phases: [
        {
          id: 'phase-1',
          title: 'Codec',
          objective: 'Round-trip without losing structure.',
          checkpoints: [
            {
              id: 'checkpoint-1',
              description: 'Round-trip the spec.',
              evidence: 'Deep equality test passes.'
            }
          ],
          fileOperations: [
            {
              path: 'src/lib/spec/spec-markdown.ts',
              operation: 'create',
              reason: 'Own the Markdown boundary.'
            },
            {
              path: 'docs/spec.md',
              operation: 'delete',
              reason: 'Remove the stale contract.'
            }
          ],
          commit: '(Agent) feat(spec): SPEC-01 add codec'
        }
      ],
      successCriteria: ['All eight headings are present.', 'Structured values survive.'],
      testStrategy: 'Export, import, and compare typed values.',
      documentationRequirements: ['Document the portable format.'],
      additionalInfo:
        '## Existing findings\n\n```mermaid\nflowchart LR\n  A[Draft] --> B[Review]\n```',
      commitPattern: '(Agent) type(spec): SPEC-id summary',
      constraints: ['No absolute paths.'],
      risks: ['Manual JSON edits can be malformed.']
    },
    annotations: [],
    decisionComments: [],
    context: [],
    provenance: {
      source: 'manual',
      actor: 'user',
      createdAt: 1
    },
    createdAt: 1,
    updatedAt: 2
  }
}

describe('engineering specification Markdown', () => {
  it('round-trips all eight headings and structured implementation details', () => {
    const spec = createSpec()
    const markdown = exportEngineeringSpecMarkdown(spec)

    expect(markdown.match(/^## /gm)).toHaveLength(8)
    expect(markdown).toContain('## Additional Info')
    expect(markdown).toContain('## Constraints & Risks')
    expect(importEngineeringSpecMarkdown(markdown)).toEqual({
      content: spec.content
    })
  })

  it('rejects a missing required heading with a useful error', () => {
    const markdown = exportEngineeringSpecMarkdown(createSpec()).replace(
      '## Documentation',
      '## Notes'
    )

    expect(() => importEngineeringSpecMarkdown(markdown)).toThrowError(
      new SpecMarkdownError('Missing required heading "## Documentation".')
    )
  })

  it('rejects duplicate headings, malformed JSON, and invalid phase shapes', () => {
    const markdown = exportEngineeringSpecMarkdown(createSpec())

    expect(() =>
      importEngineeringSpecMarkdown(`${markdown}\n## Problem\n\n\`\`\`json\n"x"\n\`\`\`\n`)
    ).toThrow(/appears more than once/)

    expect(() =>
      importEngineeringSpecMarkdown(markdown.replace('"No absolute paths."', 'invalid JSON'))
    ).toThrow(/contains invalid JSON/)

    expect(() =>
      importEngineeringSpecMarkdown(
        markdown.replace('"operation": "create"', '"operation": "move"')
      )
    ).toThrow(/Resolution\.phases/)
  })

  it('rejects sections that are not a single fenced JSON block', () => {
    const markdown = exportEngineeringSpecMarkdown(createSpec()).replace(
      '```json\n"Export, import, and compare typed values."\n```',
      'Export, import, and compare typed values.'
    )

    expect(() => importEngineeringSpecMarkdown(markdown)).toThrow(
      'Section "Test Strategy" must contain exactly one fenced JSON block.'
    )
  })
})
