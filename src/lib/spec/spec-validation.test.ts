import { describe, expect, it } from 'vitest'
import type { EngineeringSpec } from '../types'
import { isSafeProjectRelativePath, validateEngineeringSpec } from './spec-validation'

function createValidSpec(): EngineeringSpec {
  return {
    schemaVersion: 1,
    id: 'spec-1',
    projectId: 'project-1',
    threadId: 'thread-1',
    version: 1,
    status: 'draft',
    content: {
      problem: 'Users cannot review agent implementation.',
      resolutionSummary: 'Add a staged, evidence-backed workflow.',
      phases: [
        {
          id: 'phase-1',
          title: 'Foundation',
          objective: 'Create the validation boundary.',
          checkpoints: [
            {
              id: 'checkpoint-1',
              description: 'Validate a complete specification.',
              evidence: 'Focused tests pass.'
            }
          ],
          fileOperations: [
            {
              path: 'src/lib/spec/spec-validation.ts',
              operation: 'create',
              reason: 'Centralize validation.'
            }
          ],
          commit: 'feat(spec): validate specifications'
        }
      ],
      successCriteria: ['Invalid specifications cannot be approved.'],
      testStrategy: 'Run focused unit tests for valid and invalid specifications.',
      documentationRequirements: ['Document validation failures in the UI.'],
      additionalInfo: 'Recommended direction: keep approval explicit and reviewable.',
      commitPattern: '(Agent) type(spec): SPEC-id summary',
      constraints: ['Paths remain project-relative.'],
      risks: ['Overly strict validation could block valid work.']
    },
    annotations: [],
    decisionComments: [],
    context: [
      {
        id: 'context-1',
        type: 'project_file',
        label: 'Project rules',
        path: 'AGENTS.md',
        selectedAt: 1
      }
    ],
    provenance: {
      source: 'manual',
      actor: 'user',
      createdAt: 1
    },
    createdAt: 1,
    updatedAt: 1
  }
}

describe('validateEngineeringSpec', () => {
  it('accepts a complete specification', () => {
    expect(validateEngineeringSpec(createValidSpec())).toEqual({ valid: true, issues: [] })
  })

  it('reports missing content in every required section', () => {
    const spec = createValidSpec()
    spec.content.problem = ' '
    spec.content.resolutionSummary = ''
    spec.content.phases = []
    spec.content.successCriteria = []
    spec.content.testStrategy = ''
    spec.content.documentationRequirements = []
    spec.content.commitPattern = ''
    spec.content.constraints = []
    spec.content.risks = []

    const result = validateEngineeringSpec(spec)
    expect(result.valid).toBe(false)
    expect(new Set(result.issues.map((issue) => issue.section))).toEqual(
      new Set([
        'problem',
        'resolution',
        'success_criteria',
        'test_strategy',
        'documentation',
        'commit_pattern',
        'constraints_risks'
      ])
    )
  })

  it('requires checkpoints, evidence, file operations, and globally unique ids', () => {
    const spec = createValidSpec()
    const phase = spec.content.phases[0]
    if (!phase) throw new Error('Fixture phase is missing.')

    phase.checkpoints.push({
      id: phase.id,
      description: 'Duplicate id',
      evidence: ''
    })
    phase.fileOperations = []

    const result = validateEngineeringSpec(spec)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'duplicate_id',
          path: 'content.phases[0].checkpoints[1].id'
        }),
        expect.objectContaining({
          code: 'missing_evidence',
          path: 'content.phases[0].checkpoints[1].evidence'
        }),
        expect.objectContaining({
          code: 'required',
          path: 'content.phases[0].fileOperations'
        })
      ])
    )
  })

  it('rejects unsafe operation and context paths', () => {
    const unsafePaths = [
      '/etc/passwd',
      '../secret',
      'src/../../secret',
      'C:\\Users\\secret',
      '\\\\server\\share',
      'src//file.ts',
      'src/./file.ts',
      `src/\0file.ts`
    ]

    for (const unsafePath of unsafePaths) {
      expect(isSafeProjectRelativePath(unsafePath)).toBe(false)
    }
    expect(isSafeProjectRelativePath('src/lib/spec.ts')).toBe(true)
    expect(isSafeProjectRelativePath('src\\lib\\spec.ts')).toBe(true)

    const spec = createValidSpec()
    const phase = spec.content.phases[0]
    const context = spec.context[0]
    if (!phase || !context) throw new Error('Fixture path owner is missing.')
    phase.fileOperations[0] = {
      path: '../secret',
      operation: 'edit',
      reason: 'Unsafe'
    }
    context.path = '/absolute/context.md'

    expect(
      validateEngineeringSpec(spec).issues.filter((issue) => issue.code === 'invalid_path')
    ).toHaveLength(2)
  })
})
