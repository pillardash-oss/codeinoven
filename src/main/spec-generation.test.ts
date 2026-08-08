import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn() }
}))

vi.mock('./memory-service', () => ({
  MemoryService: class {
    async formatCurrent(): Promise<string> {
      return 'Test memory layer content.'
    }
  }
}))

import {
  DEPLOYMENT_URL_SYSTEM_INSTRUCTION,
  DEPLOYMENT_URL_SPEC_INSTRUCTION,
  SPEC_BRAINSTORM_SYSTEM_PROMPT,
  SPEC_IMPLEMENT_SYSTEM_PROMPT,
  composeBrainstormSystemPrompt,
  composeTurnSystemPrompt,
  parseGeneratedSpecContent,
  mergeProviderCatalogs,
  mergeAgentMessages,
  assertHarnessRequestCapabilities
} from './chat-engine'
import { PromptAssembler, layerDevHash, layerSize, normalizeLayerContent } from './prompt-assembler'
import { MemoryService } from './memory-service'

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

describe('prompt assembly owns planning and implementation layers', () => {
  const constants = {
    SPEC_BRAINSTORM_SYSTEM_PROMPT,
    SPEC_IMPLEMENT_SYSTEM_PROMPT
  }
  const assembler = new PromptAssembler(new MemoryService())
  // A path with no AGENTS.md keeps the assembled layers deterministic.
  const projectPath = '/nonexistent-prompt-assembler-test-project'

  it('normalizes content so structurally identical layers hash equally', () => {
    expect(normalizeLayerContent('a  \n b\t')).toBe('a b')
    expect(layerDevHash('a  \n b\t')).toBe(layerDevHash('a b'))
    expect(layerDevHash('a b')).not.toBe(layerDevHash('a c'))
  })

  it('accounts per-layer characters and estimated tokens without content', () => {
    const report = layerSize('hello world')
    expect(report.characters).toBe(11)
    expect(report.estimatedTokens).toBe(3)
    expect(report).not.toHaveProperty('content')
  })

  it('keeps every brainstorm layer distinct and the planning prompt single', async () => {
    const layers = await assembler.getLayers(
      'project',
      'thread',
      projectPath,
      null,
      constants,
      'brainstorm'
    )
    const hashes = layers.map((layer) => layerDevHash(layer.content))
    expect(new Set(hashes).size).toBe(hashes.length)
    const planningLayers = layers.filter((layer) =>
      normalizeLayerContent(layer.content).includes(
        normalizeLayerContent(SPEC_BRAINSTORM_SYSTEM_PROMPT)
      )
    )
    expect(planningLayers).toHaveLength(1)
  })

  it('keeps every implement layer distinct and the implementation prompt single', async () => {
    const layers = await assembler.getLayers(
      'project',
      'thread',
      projectPath,
      null,
      constants,
      'implement'
    )
    const hashes = layers.map((layer) => layerDevHash(layer.content))
    expect(new Set(hashes).size).toBe(hashes.length)
    const implementLayers = layers.filter((layer) =>
      normalizeLayerContent(layer.content).includes(
        normalizeLayerContent(SPEC_IMPLEMENT_SYSTEM_PROMPT)
      )
    )
    expect(implementLayers).toHaveLength(1)
  })

  it('excludes planning and implementation prompts from chat-mode layers', async () => {
    const layers = await assembler.getLayers(
      'project',
      'thread',
      projectPath,
      null,
      constants,
      'chat'
    )
    const appLayer = layers.find((layer) => layer.title.startsWith('Application: CodeInOven'))
    expect(appLayer?.content).toBe('No application prompts configured.')
  })

  it('attaches normalized-hash and character/token accounting to every layer', async () => {
    const layers = await assembler.getLayers(
      'project',
      'thread',
      projectPath,
      null,
      constants,
      'implement'
    )
    expect(layers.length).toBeGreaterThan(0)
    for (const layer of layers) {
      expect(layer.devHash).toBe(layerDevHash(layer.content))
      expect(layer.characters).toBe(layer.content.length)
      expect(layer.estimatedTokens).toBe(Math.ceil(layer.content.length / 4))
    }
  })
})

describe('ChatEngine final prompt composition', () => {
  const constants = {
    SPEC_BRAINSTORM_SYSTEM_PROMPT,
    SPEC_IMPLEMENT_SYSTEM_PROMPT
  }
  const assembler = new PromptAssembler(new MemoryService())
  const projectPath = '/nonexistent-prompt-assembler-test-project'

  function normalizedOccurrences(haystack: string, needle: string): number {
    const text = normalizeLayerContent(haystack)
    const target = normalizeLayerContent(needle)
    let count = 0
    let index = 0
    while ((index = text.indexOf(target, index)) !== -1) {
      count += 1
      index += target.length
    }
    return count
  }

  async function behaviorFor(mode: 'brainstorm' | 'implement' | 'chat'): Promise<string> {
    return assembler.getAssembledPrompt('project', 'thread', projectPath, null, '', constants, mode)
  }

  it('composes the implementation turn with the implementation prompt exactly once', async () => {
    const behaviorPrompt = await behaviorFor('implement')
    const composed = composeTurnSystemPrompt({
      chatPrompt: '',
      memoryInstruction: 'Memory instruction.',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt,
      utilityInstructions: '',
      behaviorMode: 'implement',
      historyRecap: ''
    })
    expect(normalizedOccurrences(composed, SPEC_IMPLEMENT_SYSTEM_PROMPT)).toBe(1)
    expect(normalizedOccurrences(composed, SPEC_BRAINSTORM_SYSTEM_PROMPT)).toBe(0)
    // Mermaid and question instructions are embedded once inside the
    // implementation prompt and must not be injected again by the composer.
    expect(normalizedOccurrences(composed, 'mermaid')).toBe(1)
    expect(normalizedOccurrences(composed, '`question` tool')).toBe(1)
  })

  it('composes the planning turn without re-inserting the brainstorming prompt', async () => {
    const behaviorPrompt = await behaviorFor('brainstorm')
    const composed = composeTurnSystemPrompt({
      chatPrompt: '',
      memoryInstruction: 'Memory instruction.',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt,
      utilityInstructions: '',
      behaviorMode: 'brainstorm',
      historyRecap: ''
    })
    expect(normalizedOccurrences(composed, SPEC_BRAINSTORM_SYSTEM_PROMPT)).toBe(1)
    expect(normalizedOccurrences(composed, SPEC_IMPLEMENT_SYSTEM_PROMPT)).toBe(0)
  })

  it('injects mermaid and question instructions exactly once for chat turns', async () => {
    const behaviorPrompt = await behaviorFor('chat')
    const composed = composeTurnSystemPrompt({
      chatPrompt: 'You are a general-purpose chat assistant.',
      memoryInstruction: 'Memory instruction.',
      imageDescriptorNote: '',
      assignmentCoordinatorSystemPrompt: '',
      behaviorPrompt,
      utilityInstructions: '',
      behaviorMode: 'chat',
      historyRecap: ''
    })
    expect(normalizedOccurrences(composed, SPEC_BRAINSTORM_SYSTEM_PROMPT)).toBe(0)
    expect(normalizedOccurrences(composed, SPEC_IMPLEMENT_SYSTEM_PROMPT)).toBe(0)
    expect(normalizedOccurrences(composed, 'mermaid')).toBe(1)
    expect(normalizedOccurrences(composed, '`question` tool')).toBe(1)
  })

  it('composes the spec-generation turn with the planning prompt exactly once', async () => {
    const behaviorPrompt = await behaviorFor('brainstorm')
    const composed = composeBrainstormSystemPrompt({
      activeBrainstormTurn: false,
      assignmentMode: false,
      revisionPrompt: '',
      memoryInstruction: 'Memory instruction.',
      imageDescriptorNote: '',
      behaviorPrompt,
      utilityInstructions: '',
      historyRecap: ''
    })
    expect(normalizedOccurrences(composed, SPEC_BRAINSTORM_SYSTEM_PROMPT)).toBe(1)
    expect(normalizedOccurrences(composed, SPEC_IMPLEMENT_SYSTEM_PROMPT)).toBe(0)
    expect(normalizedOccurrences(composed, 'implementation-ready engineering specifications')).toBe(
      1
    )
  })

  it('keeps a brainstorm discussion turn free of the spec-generation contract', async () => {
    const behaviorPrompt = await behaviorFor('brainstorm')
    const composed = composeBrainstormSystemPrompt({
      activeBrainstormTurn: true,
      assignmentMode: false,
      revisionPrompt: '',
      memoryInstruction: 'Memory instruction.',
      imageDescriptorNote: '',
      behaviorPrompt,
      utilityInstructions: '',
      historyRecap: ''
    })
    expect(normalizedOccurrences(composed, SPEC_BRAINSTORM_SYSTEM_PROMPT)).toBe(1)
    expect(normalizedOccurrences(composed, 'Brainstorm session before specification')).toBe(1)
    expect(normalizedOccurrences(composed, 'implementation-ready engineering specifications')).toBe(
      0
    )
  })
})
