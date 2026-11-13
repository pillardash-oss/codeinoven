/**
 * The canonical Assignment task-graph JSON schema.
 *
 * It lives beside the validator that checks a submitted graph so both the
 * structured-output tool and the gateway authoring tool can offer the same shape
 * without a dependency cycle between the tool catalogs.
 */
export const ASSIGNMENT_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Concise TL;DR of the Assignment execution plan.'
    },
    phases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          info: { type: 'string' }
        },
        required: ['id', 'title', 'description']
      }
    },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          phaseId: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          info: { type: 'string' },
          prompt: { type: 'string', minLength: 1 },
          owner: { type: 'string', enum: ['senior', 'worker'] },
          dependsOn: { type: 'array', items: { type: 'string', minLength: 1 } },
          expectedFiles: { type: 'array', items: { type: 'string', minLength: 1 } },
          auditChecklist: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 }
          }
        },
        required: [
          'id',
          'phaseId',
          'title',
          'description',
          'prompt',
          'owner',
          'dependsOn',
          'expectedFiles',
          'auditChecklist'
        ]
      }
    }
  },
  required: ['title', 'summary', 'phases', 'tasks']
}
