import type { ApplicationAgentToolDefinition } from './types'
import { APP_NAME } from './brand'
import { BRAINSTORM_DOCUMENT_JSON_SCHEMA } from './brainstorm/brainstorm-validation'

/** Stable application-facing name for the canonical specification contract. */
export const ENGINEERING_SPEC_TOOL_NAME = 'engineering_spec'
export const BRAINSTORM_DOCUMENT_TOOL_NAME = 'brainstorm_document'
export const FEATURE_AUDIT_TOOL_NAME = 'request_audit'
export const AUDIT_REPORT_TOOL_NAME = 'audit_report'
export const PROPOSE_MEMORY_TOOL_NAME = 'propose_memory'

/** Corrective request sent when a planning agent returned prose instead of the contract. */
export const ENGINEERING_SPEC_REQUEST_PROMPT =
  `YOU MUST USE THE ${ENGINEERING_SPEC_TOOL_NAME} TOOL TO DEFINE THE SPEC, ` +
  'NOT A GENERIC TEXT RESPONSE. ENSURE YOU FOLLOW THE INSTRUCTIONS TO THE LETTER.'

export const ASSIGNMENT_PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
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

/** Exact response schema supplied to the harness for specification generation. */
export const SPEC_GENERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    problem: {
      type: 'string',
      minLength: 1,
      description:
        'Concrete user problem and current failure, written as readable Markdown with paragraphs or lists when useful.'
    },
    resolutionSummary: {
      type: 'string',
      minLength: 1,
      description:
        'Implementation-ready summary written as readable Markdown. Use newline-delimited Markdown lists when enumerating multiple steps or recommendations; never use inline parenthesized numbering.'
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
          objective: { type: 'string', minLength: 1 },
          checkpoints: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', minLength: 1 },
                description: { type: 'string', minLength: 1 },
                evidence: { type: 'string', minLength: 1 }
              },
              required: ['id', 'description', 'evidence']
            }
          },
          fileOperations: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: {
                  type: 'string',
                  minLength: 1,
                  description: 'Project-relative path.'
                },
                operation: {
                  type: 'string',
                  enum: ['create', 'edit', 'delete']
                },
                reason: { type: 'string', minLength: 1 }
              },
              required: ['path', 'operation', 'reason']
            }
          },
          commit: { type: 'string', minLength: 1 }
        },
        required: ['id', 'title', 'objective', 'checkpoints', 'fileOperations', 'commit']
      }
    },
    successCriteria: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    testStrategy: {
      type: 'string',
      minLength: 1,
      description:
        'Readable Markdown describing the test strategy, with newline-delimited lists when it contains multiple distinct checks.'
    },
    documentationRequirements: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 }
    },
    additionalInfo: {
      type: 'string',
      minLength: 1,
      description:
        'Optional free-form Markdown, including Mermaid diagrams, only when useful task information does not fit the existing specification sections.'
    },
    commitPattern: { type: 'string', minLength: 1 },
    constraints: {
      type: 'array',
      items: { type: 'string', minLength: 1 }
    },
    risks: {
      type: 'array',
      items: { type: 'string', minLength: 1 }
    },
    assignment: ASSIGNMENT_PLAN_SCHEMA
  },
  required: [
    'problem',
    'resolutionSummary',
    'phases',
    'successCriteria',
    'testStrategy',
    'documentationRequirements',
    'commitPattern',
    'constraints',
    'risks'
  ]
}

export const AUDIT_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executiveSummary: { type: 'string', minLength: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          title: { type: 'string', minLength: 1 },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'info']
          },
          description: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 }
        },
        required: ['id', 'title', 'severity', 'description', 'evidence']
      }
    },
    resolutionRecommendation: { type: 'string', minLength: 1 },
    conclusion: { type: 'string', minLength: 1 }
  },
  required: ['executiveSummary', 'findings', 'resolutionRecommendation', 'conclusion']
}

export const FEATURE_AUDIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Concise summary of the completed implementation and verification evidence.'
    }
  },
  required: ['summary']
}

export const PROPOSE_MEMORY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    propose: {
      type: 'boolean',
      description:
        'True only for information expected to govern future turns after the current task is complete. False for concrete implementation requests and other one-off work.'
    },
    title: {
      type: 'string',
      maxLength: 80,
      description: 'A concise title when propose is true; otherwise an empty string.'
    },
    content: {
      type: 'string',
      maxLength: 4_096,
      description: 'Self-contained durable information when propose is true; otherwise empty.'
    },
    category: {
      type: 'string',
      enum: ['behavioral', 'project-rule', 'identity', 'preference'],
      description: 'The semantic kind of durable information.'
    },
    priority: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description: 'How important it is to preserve and consistently apply this memory.'
    },
    scope: {
      type: 'string',
      enum: ['global', 'project', 'thread', 'chat'],
      description: 'Where the memory should apply. The extraction prompt supplies valid scopes.'
    }
  },
  required: ['propose', 'title', 'content', 'category', 'priority', 'scope']
}

/** App-owned tools/contracts added independently of the harness's built-ins. */
export const APPLICATION_AGENT_TOOLS: ApplicationAgentToolDefinition[] = [
  {
    name: PROPOSE_MEMORY_TOOL_NAME,
    transportName: 'StructuredOutput',
    description: `Decide whether a user message warrants a durable ${APP_NAME} memory proposal. Propose only recurring standing preferences, reusable rules, or stable facts that remain useful after the current task—not concrete implementation requests, conversational continuations, confirmations, questions, or other one-off work. When uncertain, do not propose. The application validates affirmative proposals and requires explicit user approval before persistence.`,
    inputSchema: PROPOSE_MEMORY_SCHEMA,
    source: 'application',
    sentWhen: 'An isolated agent decision after each completed user-and-assistant turn'
  },
  {
    name: 'utility_search',
    description:
      'Search app-managed MCP servers, skills, web services, and computer-use capabilities when a skill or MCP is not directly available. Only conclude something does not exist after a search returns no relevant result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability or task to search for.' },
        kinds: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['mcp', 'skill', 'web_search', 'web_fetch', 'computer_use', 'provider']
          }
        },
        limit: { type: 'number', minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    },
    source: 'application',
    sentWhen: 'Every agent turn; search first when a needed skill or MCP is not directly available'
  },
  {
    name: 'utility_activate',
    description:
      'Activate one installed utility for the current turn and inspect the operations it exposes.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string', description: 'Installed utility identifier.' }
      },
      required: ['utility_id'],
      additionalProperties: false
    },
    source: 'application',
    sentWhen: 'After utility_search selects an installed capability'
  },
  {
    name: 'utility_invoke',
    description: 'Invoke an operation on a utility activated for the current turn.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true }
      },
      required: ['utility_id', 'operation'],
      additionalProperties: false
    },
    source: 'application',
    sentWhen: 'After a utility has been activated for the current turn'
  },
  {
    name: BRAINSTORM_DOCUMENT_TOOL_NAME,
    transportName: 'StructuredOutput',
    description: `Submit a complete structured Brainstorm document for ${APP_NAME}. Every revision replaces the complete document; Additional Info is optional and used only when the core sections do not fit useful context.`,
    inputSchema: BRAINSTORM_DOCUMENT_JSON_SCHEMA,
    source: 'application',
    sentWhen: 'Initial Brainstorm generation and every Brainstorm review turn before finalization'
  },
  {
    name: ENGINEERING_SPEC_TOOL_NAME,
    transportName: 'StructuredOutput',
    description: `Submit a complete engineering specification for ${APP_NAME} to validate and persist. The first submission creates the review draft; later submissions create new versions of the active specification. Refer to this tool as ${ENGINEERING_SPEC_TOOL_NAME}.`,
    inputSchema: SPEC_GENERATION_SCHEMA,
    source: 'application',
    sentWhen: 'Initial specification generation and every later engineering discussion or review'
  },
  {
    name: FEATURE_AUDIT_TOOL_NAME,
    description: `Signal that the primary agent has completed a feature and ask ${APP_NAME} to offer the configured independent audit workflow.`,
    inputSchema: FEATURE_AUDIT_SCHEMA,
    source: 'application',
    sentWhen: 'After the primary implementation agent finishes the feature and reports its evidence'
  },
  {
    name: AUDIT_REPORT_TOOL_NAME,
    transportName: 'StructuredOutput',
    description:
      'Submit the independent audit report with an executive summary, findings and evidence, resolution recommendations, and a conclusion.',
    inputSchema: AUDIT_REPORT_SCHEMA,
    source: 'application',
    sentWhen: 'When the isolated audit agent completes its read-only verification run'
  }
]
