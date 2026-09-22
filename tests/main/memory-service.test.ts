import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../../src/lib/types'
import type { MemoryConfig, MemoryEntry } from '../../src/lib/types'
import { modelKey } from '../../src/lib/model-keys'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { parseMemoryMd, serializeMemoryMd } from '../../src/main/chat/memory/memory-markdown'
import {
  MEMORY_EXTRACTION_LIMITS,
  MEMORY_LIMITS,
  MemoryService,
  detectMemoryCandidates,
  estimateTokens,
  validateMemoryConfig
} from '../../src/main/chat/memory-service'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function memory(): MemoryConfig {
  return {
    enabled: true,
    chatEnabled: true,
    entries: [
      {
        id: 'formatting',
        label: 'Formatting',
        content: 'Use the project formatter only on touched files.',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        category: 'behavioral',
        priority: 'medium',
        scopes: ['projects', 'chat'],
        source: 'manual',
        frequency: 1,
        lastReinforced: 1
      },
      {
        id: 'disabled',
        label: 'Disabled',
        content: 'This must not be injected.',
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
        category: 'preference',
        priority: 'low',
        scopes: ['projects', 'chat'],
        source: 'manual',
        frequency: 1,
        lastReinforced: 1
      }
    ]
  }
}

async function openMemoryService(): Promise<{
  storage: StorageEngine
  service: MemoryService
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-memory-scopes-'))
  temporaryRoots.push(root)
  const storage = new StorageEngine(root)
  await storage.initialize()
  return { storage, service: new MemoryService(storage) }
}

function labels(config: MemoryConfig): string[] {
  return config.entries.map((entry) => entry.label)
}

function entryOn(scopes: MemoryEntry['scopes'], overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'memory-scope-fixture',
    label: 'Scope fixture',
    content: 'Scope fixture content.',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    category: 'preference',
    priority: 'medium',
    scopes,
    source: 'manual',
    frequency: 1,
    lastReinforced: 1,
    ...overrides
  }
}

describe('MemoryService', () => {
  it('formats only enabled explicit preferences deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-memory-'))
    temporaryRoots.push(root)
    const storage = new StorageEngine(root)
    await storage.initialize()
    // Write memory entries as Markdown to the global memory file
    await storage.writeRaw(
      join('memory', 'memory.md'),
      '<!-- codeinoven-memory-entry -->\n## Formatting\n\nUse the project formatter only on touched files.\n\n<!-- codeinoven-memory-entry -->\n## Another\n\nA second entry.'
    )
    const service = new MemoryService(storage)
    const projectId = 'project-1'

    await expect(service.formatCurrent(projectId)).resolves.toContain(
      '- Formatting: Use the project formatter only on touched files.'
    )
    await expect(service.formatCurrent(projectId)).resolves.toContain('- Another: A second entry.')
    await expect(service.snapshotCurrent(projectId)).resolves.toContainEqual(
      expect.objectContaining({
        type: 'memory',
        label: 'Formatting',
        content: 'Use the project formatter only on touched files.',
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
      })
    )
  })

  it.each([
    'api_key=super-secret-value',
    'Authorization: Bearer abcdefghijklmnop',
    '-----BEGIN PRIVATE KEY-----'
  ])('rejects credential-shaped memory: %s', (content) => {
    const config = memory()
    config.entries[0].content = content
    expect(() => validateMemoryConfig(config)).toThrow('credential or private key')
  })

  it('enforces entry and aggregate bounds', () => {
    const config = memory()
    config.entries[0].content = 'x'.repeat(MEMORY_LIMITS.maxEntryCharacters + 1)
    expect(() => validateMemoryConfig(config)).toThrow('safe characters')

    expect(() =>
      validateMemoryConfig({
        enabled: true,
        entries: Array.from({ length: MEMORY_LIMITS.maxEntries + 1 }, (_, index) => ({
          id: `entry-${index}`,
          label: `Entry ${index}`,
          content: 'Preference',
          enabled: true,
          updatedAt: 1
        }))
      })
    ).toThrow('at most')
  })

  it('injects model memories only for a selected harness-scoped model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-model-memory-'))
    temporaryRoots.push(root)
    const storage = new StorageEngine(root)
    await storage.initialize()
    const service = new MemoryService(storage)
    const selected = modelKey('codex', 'openai', 'gpt-5.6')

    await service.addEntry('Avoid model jargon', 'Keep interface copy plain.', {
      category: 'models',
      modelKeys: [selected, modelKey('opencode', 'openai', 'gpt-5.6')]
    })

    await expect(service.formatCurrent('project-1', undefined, selected)).resolves.toContain(
      'Keep interface copy plain.'
    )
    await expect(
      service.formatCurrent('project-1', undefined, modelKey('codex', 'anthropic', 'claude-sonnet'))
    ).resolves.not.toContain('Keep interface copy plain.')
    await expect(service.formatCurrent('project-1')).resolves.not.toContain(
      'Keep interface copy plain.'
    )
  })

  it('requires at least one selected model for model memories', () => {
    const config = memory()
    config.entries[0] = { ...config.entries[0], category: 'models' }
    expect(() => validateMemoryConfig(config)).toThrow('requires at least one model')
  })

  it('loads each audience set only in its own context', async () => {
    const { service } = await openMemoryService()
    await service.addEntry('Projects rule', 'Applies to project threads.', {
      scopes: ['projects']
    })
    await service.addEntry('Chat rule', 'Applies to chats.', { scopes: ['chat'] })
    await service.addEntry('Assistant rule', 'Applies to assistant tasks.', {
      scopes: ['assistant']
    })

    const projectThread = await service.current('project-1', 'thread-1')
    expect(labels(projectThread)).toContain('Projects rule')
    expect(labels(projectThread)).not.toContain('Chat rule')
    expect(labels(projectThread)).not.toContain('Assistant rule')
    await expect(service.formatCurrent('project-1', 'thread-1')).resolves.toContain('Projects rule')

    const chat = await service.current(INBOX_PROJECT_ID, 'chat-thread-1')
    expect(labels(chat)).toContain('Chat rule')
    expect(labels(chat)).not.toContain('Projects rule')
    expect(labels(chat)).not.toContain('Assistant rule')

    const assistantTask = await service.current(ASSISTANT_SPACE_ID, 'task-1')
    expect(labels(assistantTask)).toContain('Assistant rule')
    expect(labels(assistantTask)).not.toContain('Projects rule')
    expect(labels(assistantTask)).not.toContain('Chat rule')
  })

  it('loads an empty scope set in every context', async () => {
    const { service } = await openMemoryService()
    await service.addEntry('All audiences', 'Applies everywhere.', { scopes: [] })

    expect(labels(await service.current('project-1', 'thread-1'))).toContain('All audiences')
    expect(labels(await service.current(INBOX_PROJECT_ID, 'chat-thread-1'))).toContain(
      'All audiences'
    )
    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-1'))).toContain('All audiences')
  })

  it('loads routine memory only for tasks of that routine', async () => {
    const { service } = await openMemoryService()
    await service.addEntry('Routine A rule', 'Applies to routine A tasks.', {
      scopes: ['routine'],
      routineId: 'routine-a'
    })

    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-1', 'routine-a'))).toContain(
      'Routine A rule'
    )
    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-2', 'routine-b'))).not.toContain(
      'Routine A rule'
    )
    // A task whose routine is unknown never receives another routine's memory.
    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-3'))).not.toContain(
      'Routine A rule'
    )
    // Routine memory never leaks into a project context, even with a matching id.
    expect(labels(await service.current('project-1', 'thread-1', 'routine-a'))).not.toContain(
      'Routine A rule'
    )
  })

  it('loads task memory only for its own assistant task thread', async () => {
    const { service } = await openMemoryService()
    await service.addEntry('Task one rule', 'Applies to task one.', {
      scopes: ['task'],
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'task-1'
    })

    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-1'))).toContain('Task one rule')
    expect(labels(await service.current(ASSISTANT_SPACE_ID, 'task-2'))).not.toContain(
      'Task one rule'
    )
    expect(labels(await service.current('project-1', 'task-1'))).not.toContain('Task one rule')
  })

  it('keeps scope sets across a markdown read/write round trip', () => {
    const audienceEntry = entryOn(['projects', 'chat'], {
      id: 'memory-round-trip',
      label: 'Round trip entry',
      content: 'Keeps its audience set.'
    })
    const everywhereEntry = entryOn([], {
      id: 'memory-everywhere',
      label: 'Everywhere entry',
      content: 'Keeps the empty set.'
    })

    const reparsed = parseMemoryMd(serializeMemoryMd([audienceEntry, everywhereEntry]))
    expect(reparsed).toHaveLength(2)
    expect(reparsed[0].scopes).toEqual(['projects', 'chat'])
    expect(reparsed[1].scopes).toEqual([])
  })

  it('reads the legacy single scope, mapping global to projects and chats', async () => {
    const { storage, service } = await openMemoryService()
    await storage.writeRaw(
      join('memory', 'memory.md'),
      [
        '<!-- codeinoven-memory-entry -->',
        '## Legacy global',
        '',
        'id: legacy-global',
        'category: behavioral',
        'priority: high',
        'scope: global',
        '',
        'Was written before scope sets existed.'
      ].join('\n')
    )

    const [entry] = await service.getEntries()
    expect(entry.scopes).toEqual(['projects', 'chat'])
  })
})

const ASSISTANT = 'Done   the change is applied and verified.'

/** Representative completed turns for the ≥80% skip-rate acceptance check. */
const REPRESENTATIVE_TURNS: Array<{ user: string; durable: boolean }> = [
  { user: 'Can you explain how the relay timeout works?', durable: false },
  { user: 'Implement the login form with validation.', durable: false },
  { user: 'Thanks!', durable: false },
  { user: 'Please continue.', durable: false },
  { user: 'Fix the parser bug and run the tests.', durable: false },
  { user: 'Review the PR before merging it.', durable: false },
  { user: 'What is the current status of the thread?', durable: false },
  { user: 'ok', durable: false },
  { user: 'got it, thanks a lot', durable: false },
  { user: 'Use Tailwind for the new settings page.', durable: false },
  { user: 'Refactor the chat engine to reduce latency.', durable: false },
  { user: 'Add a tooltip to the icon button.', durable: false },
  { user: 'Check the app audit document for A-06.', durable: false },
  { user: 'Reply with a short summary.', durable: false },
  { user: 'Go ahead and merge when ready.', durable: false },
  { user: 'Look into why the relay drops messages.', durable: false },
  { user: 'Rename the variable and update call sites.', durable: false },
  { user: 'Always use bun instead of npm from now on.', durable: true },
  { user: 'Never use checkbox inputs in this project going forward.', durable: true },
  { user: 'Please remember that I prefer tabs over spaces for this codebase.', durable: true }
]

describe('detectMemoryCandidates', () => {
  it('skips at least 80% of representative turns without a model call', () => {
    const results = REPRESENTATIVE_TURNS.map((turn) =>
      detectMemoryCandidates({
        userMessage: turn.user,
        assistantResponse: ASSISTANT,
        existingEntries: []
      })
    )

    const durable = results.filter((candidates) => candidates.length > 0)
    const skipped = results.length - durable.length
    expect(skipped / results.length).toBeGreaterThanOrEqual(0.8)
    for (const [index, turn] of REPRESENTATIVE_TURNS.entries()) {
      const hasCandidate = results[index].length > 0
      expect(hasCandidate).toBe(turn.durable)
    }
  })

  it('extracts only standing preferences, never one-off instructions', () => {
    const durable = detectMemoryCandidates({
      userMessage: 'Always run the focused tests before committing from now on.',
      assistantResponse: ASSISTANT,
      existingEntries: []
    })
    expect(durable).toHaveLength(1)
    expect(durable[0].content).toContain('Always run the focused tests')
    expect(durable[0].priority).toBe('high')

    expect(
      detectMemoryCandidates({
        userMessage: 'Run the focused tests before committing.',
        assistantResponse: ASSISTANT,
        existingEntries: []
      })
    ).toEqual([])
  })

  it('deduplicates a candidate that already exists in memory', () => {
    const existing: MemoryEntry[] = [
      {
        id: 'existing',
        label: 'Checkboxes',
        content: 'Never use checkbox inputs in this project going forward.',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        category: 'behavioral',
        priority: 'high',
        scopes: ['project'],
        projectId: 'project-1',
        source: 'manual',
        frequency: 1,
        lastReinforced: 1
      }
    ]
    expect(
      detectMemoryCandidates({
        userMessage: 'Never use checkbox inputs in this project going forward.',
        assistantResponse: ASSISTANT,
        existingEntries: existing,
        projectId: 'project-1'
      })
    ).toEqual([])
  })

  it('caps candidate material to local limits', () => {
    const longResponse = 'x'.repeat(MEMORY_EXTRACTION_LIMITS.maxAssistantCandidateCharacters + 500)
    const candidates = detectMemoryCandidates({
      userMessage: 'Always prefer vector icons from now on.',
      assistantResponse: longResponse,
      existingEntries: []
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].content.length).toBeLessThanOrEqual(
      MEMORY_EXTRACTION_LIMITS.maxUserCandidateCharacters
    )
  })
})

describe('evaluateMemoryExtraction', () => {
  async function service(): Promise<{ service: MemoryService; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-memory-extract-'))
    temporaryRoots.push(root)
    const storage = new StorageEngine(root)
    await storage.initialize()
    return { service: new MemoryService(storage), root }
  }

  it('returns run=false without candidates for a one-off turn', async () => {
    const { service: memoryService } = await service()
    const decision = await memoryService.evaluateMemoryExtraction({
      userMessage: 'Implement the login form.',
      assistantResponse: ASSISTANT,
      projectId: 'project-1',
      threadId: 'thread-1'
    })
    expect(decision.run).toBe(false)
    expect(decision.reason).toBe('no-candidate')
    expect(decision.inputTokens).toBe(0)
  })

  it('debounces repeated extractions for the same conversation', async () => {
    const { service: memoryService } = await service()
    const base = {
      userMessage: 'Always run the focused tests before committing from now on.',
      assistantResponse: ASSISTANT,
      projectId: 'project-1',
      threadId: 'thread-1'
    }
    const first = await memoryService.evaluateMemoryExtraction({ ...base, now: 1_000 })
    expect(first.run).toBe(true)
    const debounced = await memoryService.evaluateMemoryExtraction({ ...base, now: 1_001 })
    expect(debounced.run).toBe(false)
    expect(debounced.reason).toBe('debounced')
  })

  it('enforces the separately configurable cheap-model token budget', async () => {
    const { service: memoryService } = await service()
    process.env['CODEINOVEN_MEMORY_DEBOUNCE_MS'] = '100000'
    try {
      const base = {
        userMessage: 'Always use bun from now on.',
        assistantResponse: 'y'.repeat(2_000),
        projectId: 'project-1',
        threadId: 'thread-2',
        now: 1_000
      }
      process.env['CODEINOVEN_MEMORY_TOKEN_BUDGET'] = '8'
      const decision = await memoryService.evaluateMemoryExtraction(base)
      expect(decision.run).toBe(true)
      expect(decision.inputTokens).toBeLessThanOrEqual(8)
      // The assistant material is truncated to the remaining headroom.
      expect(decision.assistantInput.length).toBeLessThanOrEqual(2_000)

      process.env['CODEINOVEN_MEMORY_TOKEN_BUDGET'] = '4'
      const over = await memoryService.evaluateMemoryExtraction({
        ...base,
        threadId: 'thread-3',
        now: 2_000
      })
      expect(over.run).toBe(false)
      expect(over.reason).toBe('over-budget')
    } finally {
      delete process.env['CODEINOVEN_MEMORY_TOKEN_BUDGET']
      delete process.env['CODEINOVEN_MEMORY_DEBOUNCE_MS']
    }
  })

  it('caps the auxiliary model input to the extraction limits', async () => {
    const { service: memoryService } = await service()
    const decision = await memoryService.evaluateMemoryExtraction({
      userMessage: 'Always use the shared Switch component from now on.',
      assistantResponse: 'z'.repeat(20_000),
      projectId: 'project-1',
      threadId: 'thread-4'
    })
    expect(decision.run).toBe(true)
    expect(decision.assistantInput.length).toBeLessThanOrEqual(
      MEMORY_EXTRACTION_LIMITS.maxAssistantCandidateCharacters
    )
    expect(decision.userInput.length).toBeLessThanOrEqual(
      MEMORY_EXTRACTION_LIMITS.maxUserCandidateCharacters
    )
  })
})

describe('auxiliary usage accounting', () => {
  it('reports token input and cost separately by feature', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-memory-usage-'))
    temporaryRoots.push(root)
    const storage = new StorageEngine(root)
    await storage.initialize()
    const memoryService = new MemoryService(storage)

    memoryService.recordAuxiliaryUsage('memory', 1_000, 4_000, {
      outputTokens: 100,
      costUsd: null,
      costStatus: 'unavailable'
    })
    memoryService.recordAuxiliaryUsage('memory', 500, 2_000, {
      outputTokens: 50,
      costUsd: 0.0002,
      costStatus: 'estimated'
    })
    memoryService.recordAuxiliaryUsage('title', 200, 800, {
      outputTokens: 20,
      costUsd: 0,
      costStatus: 'known'
    })

    const totals = memoryService.auxiliaryUsageByFeature()
    expect(totals.memory.calls).toBe(2)
    expect(totals.memory.inputTokens).toBe(1_500)
    expect(totals.memory.inputChars).toBe(6_000)
    expect(totals.memory.outputTokens).toBe(150)
    expect(totals.memory.estimatedCost).toBe(0.0002)
    expect(totals.memory.unavailableCalls).toBe(1)
    expect(totals.title.calls).toBe(1)
    expect(totals.title.inputTokens).toBe(200)
    expect(totals.title.outputTokens).toBe(20)
    expect(totals.title.estimatedCost).toBe(0)
    expect(totals.title.unavailableCalls).toBe(0)
  })
})

describe('model titles and token estimation', () => {
  it('estimates tokens from characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(9))).toBe(3)
  })
})
