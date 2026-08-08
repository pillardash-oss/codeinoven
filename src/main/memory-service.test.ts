import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MemoryConfig, MemoryEntry } from '../lib/types'
import { StorageEngine } from './storage-engine'
import {
  MEMORY_EXTRACTION_LIMITS,
  MEMORY_LIMITS,
  MemoryService,
  detectMemoryCandidates,
  estimateTokens,
  modelTitlesEnabled,
  validateMemoryConfig
} from './memory-service'

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
        updatedAt: 1,
        category: 'behavioral',
        priority: 'medium',
        scope: 'global',
        source: 'manual',
        frequency: 1,
        lastReinforced: 1
      },
      {
        id: 'disabled',
        label: 'Disabled',
        content: 'This must not be injected.',
        enabled: false,
        updatedAt: 1,
        category: 'preference',
        priority: 'low',
        scope: 'global',
        source: 'manual',
        frequency: 1,
        lastReinforced: 1
      }
    ]
  }
}

describe('MemoryService', () => {
  it('formats only enabled explicit preferences deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-memory-'))
    temporaryRoots.push(root)
    const storage = new StorageEngine(root)
    await storage.initialize()
    // Write memory entries as Markdown to memory.md
    await storage.writeRaw(
      'memory.md',
      '## Formatting\n\nUse the project formatter only on touched files.\n\n## Another\n\nA second entry.'
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
})

const ASSISTANT = 'Done — the change is applied and verified.'

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
        updatedAt: 1,
        category: 'behavioral',
        priority: 'high',
        scope: 'project',
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

    memoryService.recordAuxiliaryUsage('memory', 1_000, 4_000)
    memoryService.recordAuxiliaryUsage('memory', 500, 2_000)
    memoryService.recordAuxiliaryUsage('title', 200, 800)

    const totals = memoryService.auxiliaryUsageByFeature()
    expect(totals.memory.calls).toBe(2)
    expect(totals.memory.inputTokens).toBe(1_500)
    expect(totals.memory.inputChars).toBe(6_000)
    expect(totals.memory.estimatedCost).toBeGreaterThan(0)
    expect(totals.title.calls).toBe(1)
    expect(totals.title.inputTokens).toBe(200)
    expect(totals.memory.estimatedCost).toBeGreaterThan(totals.title.estimatedCost)
  })
})

describe('model titles and token estimation', () => {
  it('keeps heuristic titles the default and honours the opt-in', () => {
    const original = process.env['CODEINOVEN_MODEL_TITLES']
    try {
      delete process.env['CODEINOVEN_MODEL_TITLES']
      delete process.env['MODEL_TITLES']
      expect(modelTitlesEnabled()).toBe(false)
      process.env['CODEINOVEN_MODEL_TITLES'] = 'true'
      expect(modelTitlesEnabled()).toBe(true)
    } finally {
      if (original === undefined) delete process.env['CODEINOVEN_MODEL_TITLES']
      else process.env['CODEINOVEN_MODEL_TITLES'] = original
    }
  })

  it('estimates tokens from characters', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(9))).toBe(3)
  })
})
