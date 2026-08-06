import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

import {
  DEPLOYMENT_URL_SYSTEM_INSTRUCTION,
  DEPLOYMENT_URL_SPEC_INSTRUCTION,
  SPEC_BRAINSTORM_SYSTEM_PROMPT,
  SPEC_IMPLEMENT_SYSTEM_PROMPT,
  parseGeneratedSpecContent,
  mergeProviderCatalogs,
  mergeAgentMessages,
  assertHarnessRequestCapabilities
} from './chat-engine'

const validContent = {
  problem: 'Users need a reliable specification workflow.',
  resolutionSummary: 'Persist and validate versioned specifications.',
  phases: [
    {
      id: 'phase-1',
      title: 'Foundation',
      objective: 'Create the engine.',
      checkpoints: [
        {
          id: 'checkpoint-1',
          description: 'Engine persists a draft.',
          evidence: 'Focused persistence test passes.'
        }
      ],
      fileOperations: [
        {
          path: 'src/lib/spec-engine.ts',
          operation: 'create',
          reason: 'Own specification persistence.'
        }
      ],
      commit: '(Agent) feat(spec): add engine'
    }
  ],
  successCriteria: ['Drafts survive restart.'],
  testStrategy: 'Run focused engine and validation tests.',
  documentationRequirements: ['Document the schema.'],
  additionalInfo: 'Recommended direction: keep the workflow deterministic.',
  commitPattern: '(Agent) type(spec): summary',
  constraints: ['No silent approval.'],
  risks: ['Corrupt imported data.']
}

describe('parseGeneratedSpecContent', () => {
  it('parses a fenced structured response', () => {
    const result = parseGeneratedSpecContent(`\`\`\`json\n${JSON.stringify(validContent)}\n\`\`\``)

    expect(result).toEqual(validContent)
  })

  it('extracts a JSON object from a short explanation', () => {
    const additionalInfo = '```mermaid\nflowchart LR\nA --> B\n```'
    const result = parseGeneratedSpecContent(
      `Draft follows: ${JSON.stringify({ ...validContent, additionalInfo })} Done.`
    )

    expect(result.problem).toBe(validContent.problem)
    expect(result.additionalInfo).toBe(additionalInfo)
  })

  it('rejects malformed or incomplete output', () => {
    expect(() => parseGeneratedSpecContent('not json')).toThrow('invalid JSON')
    expect(() => parseGeneratedSpecContent('{}')).toThrow('problem is missing')
  })
})

describe('deployment URL planning contract', () => {
  it('requires discovery before asking for deployment URLs', () => {
    expect(DEPLOYMENT_URL_SYSTEM_INSTRUCTION).toContain(
      'inspect the project for existing URL configuration'
    )
    expect(DEPLOYMENT_URL_SYSTEM_INSTRUCTION).toContain('ask one concise question')
    expect(SPEC_BRAINSTORM_SYSTEM_PROMPT).toContain(DEPLOYMENT_URL_SYSTEM_INSTRUCTION)
    expect(SPEC_BRAINSTORM_SYSTEM_PROMPT).toContain(
      'Treat requests phrased as questions as planning requests too'
    )
  })

  it('requires explicit production values and safe development fallbacks', () => {
    expect(DEPLOYMENT_URL_SYSTEM_INSTRUCTION).toContain('documented localhost development fallback')
    expect(DEPLOYMENT_URL_SYSTEM_INSTRUCTION).toContain(
      'require an explicit production value for release'
    )
    expect(DEPLOYMENT_URL_SYSTEM_INSTRUCTION).toContain(
      'Never infer a production domain from `NODE_ENV`'
    )
    expect(SPEC_IMPLEMENT_SYSTEM_PROMPT).toContain(DEPLOYMENT_URL_SYSTEM_INSTRUCTION)
  })

  it('keeps no-tools serialization grounded in discovered context', () => {
    expect(DEPLOYMENT_URL_SPEC_INSTRUCTION).toContain('this serialization stage has no tools')
    expect(DEPLOYMENT_URL_SPEC_INSTRUCTION).toContain('must not claim to inspect files')
    expect(DEPLOYMENT_URL_SPEC_INSTRUCTION).toContain('Never invent a production domain')
  })
})

describe('mergeProviderCatalogs', () => {
  it('keeps each harness provider catalog distinct', () => {
    expect(
      mergeProviderCatalogs([
        {
          id: 'openai',
          name: 'OpenAI',
          harnessId: 'opencode',
          models: [
            {
              id: 'shared',
              providerId: 'openai',
              name: 'Shared',
              reasoning: true,
              attachment: false,
              toolcall: true
            }
          ]
        },
        {
          id: 'openai',
          name: 'OpenAI',
          harnessId: 'codex',
          models: [
            {
              id: 'shared',
              providerId: 'openai',
              name: 'Shared',
              reasoning: true,
              attachment: true,
              toolcall: true
            },
            {
              id: 'codex',
              providerId: 'openai',
              name: 'Codex',
              reasoning: true,
              attachment: true,
              toolcall: true
            }
          ]
        }
      ])
    ).toEqual([
      {
        id: 'openai',
        name: 'OpenAI',
        harnessId: 'opencode',
        models: [expect.objectContaining({ id: 'shared', attachment: false })]
      },
      {
        id: 'openai',
        name: 'OpenAI',
        harnessId: 'codex',
        models: [
          expect.objectContaining({ id: 'shared', attachment: true }),
          expect.objectContaining({ id: 'codex' })
        ]
      }
    ])
  })
})

describe('provider-neutral session helpers', () => {
  it('preserves mirrored history when a thread changes harness', () => {
    expect(
      mergeAgentMessages(
        [{ id: 'old', role: 'user', parts: [], createdAt: 1 }],
        [{ id: 'new', role: 'assistant', parts: [], createdAt: 2 }]
      ).map((message) => message.id)
    ).toEqual(['old', 'new'])
  })

  it('fails before dispatch when a harness lacks attachment support', () => {
    expect(() =>
      assertHarnessRequestCapabilities(
        {
          id: 'fixture',
          name: 'Fixture',
          capabilities: {
            streaming: true,
            nativeResume: true,
            messageHistory: 'mirrored',
            interactivePermissions: false,
            attachments: false,
            commands: false,
            providerCatalog: true,
            sessionStatus: false,
            contextUsage: false,
            compaction: false,
            subagents: false,
            steering: false
          },
          ensureReady: async () => {},
          createSession: async () => 'session',
          generateTitle: async () => 'fixture title',
          sendPrompt: async () => {},
          loadMessages: async () => [],
          abort: async () => {},
          listProviders: async () => [],
          listCommands: async () => [],
          runCommand: async () => {},
          replyPermission: async () => {},
          replyToQuestion: async () => {},
          rejectQuestion: async () => {},
          listPendingQuestions: async () => [],
          onEvent: () => {},
          dispose: () => {}
        },
        [{ mime: 'image/png', url: '/tmp/image.png' }]
      )
    ).toThrow('does not support prompt attachments')
  })

  it('does not require interactive permissions for any permission level', () => {
    expect(() =>
      assertHarnessRequestCapabilities(
        {
          id: 'headless',
          name: 'Headless',
          capabilities: {
            streaming: true,
            nativeResume: false,
            messageHistory: 'mirrored',
            interactivePermissions: false,
            attachments: false,
            commands: false,
            providerCatalog: false,
            sessionStatus: false,
            contextUsage: false,
            compaction: false,
            subagents: false,
            steering: false
          },
          ensureReady: async () => {},
          createSession: async () => '',
          generateTitle: async () => 'headless title',
          sendPrompt: async () => {},
          loadMessages: async () => [],
          abort: async () => {},
          listProviders: async () => [],
          listCommands: async () => [],
          runCommand: async () => {},
          replyPermission: async () => {},
          replyToQuestion: async () => {},
          rejectQuestion: async () => {},
          listPendingQuestions: async () => [],
          onEvent: () => {},
          dispose: () => {}
        },
        [],
        'auto_review'
      )
    ).not.toThrow()
  })
})
