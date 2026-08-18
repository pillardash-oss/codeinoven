import { describe, expect, it } from 'vitest'
import type { MemoryService } from '../../src/main/chat/memory-service'
import { PromptAssembler } from '../../src/main/chat/prompt-assembler'

function assembler(): PromptAssembler {
  const memoryService = { formatCurrent: async () => '' } as unknown as MemoryService
  return new PromptAssembler(memoryService)
}

describe('PromptAssembler application behavior', () => {
  it('uses the application behavior layer for project turns without reading AGENTS.md', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/nonexistent-project',
      null,
      undefined,
      'chat',
      'Custom implementation behavior.'
    )
    const behaviorLayer = layers.find((layer) =>
      layer.title.startsWith('Agent behavior (Project thread)')
    )
    expect(behaviorLayer?.content).toBe('Custom implementation behavior.')
    expect(layers.some((layer) => layer.title.includes('AGENTS.md'))).toBe(false)
  })

  it('omits the application behavior layer from standalone chat threads', async () => {
    const layers = await assembler().getLayers(
      'inbox',
      'thread-1',
      '',
      null,
      undefined,
      'chat',
      'Custom implementation behavior.',
      undefined,
      'chat'
    )
    expect(layers.some((layer) => layer.title.startsWith('Agent behavior'))).toBe(false)
  })
})
