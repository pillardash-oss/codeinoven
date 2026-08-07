import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MemoryConfig } from '../lib/types'
import { StorageEngine } from './storage-engine'
import { MEMORY_LIMITS, MemoryService, validateMemoryConfig } from './memory-service'

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
