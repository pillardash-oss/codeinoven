import { describe, expect, it } from 'vitest'
import type { MemoryService } from '../../src/main/chat/memory-service'
import { PromptAssembler } from '../../src/main/chat/prompt-assembler'

function assembler(): PromptAssembler {
  const memoryService = { formatCurrent: async () => '' } as unknown as MemoryService
  return new PromptAssembler(memoryService)
}

describe('PromptAssembler application behavior', () => {
  it('uses the application behavior layer for implementation turns without reading AGENTS.md', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/nonexistent-project',
      null,
      undefined,
      'implement',
      'Custom implementation behavior.'
    )
    const behaviorLayer = layers.find((layer) =>
      layer.title.startsWith('Agent behavior (Engineering implementation)')
    )
    expect(behaviorLayer?.content).toBe('Custom implementation behavior.')
    expect(layers.some((layer) => layer.title.includes('AGENTS.md'))).toBe(false)
  })

  it('omits the application behavior layer from chat turns', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/nonexistent-project',
      null,
      undefined,
      'chat',
      'Custom implementation behavior.'
    )
    expect(layers.some((layer) => layer.title.startsWith('Agent behavior'))).toBe(false)
  })
})
