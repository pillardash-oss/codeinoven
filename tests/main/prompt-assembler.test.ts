import { describe, expect, it } from 'vitest'
import type { MemoryService } from '../../src/main/chat/memory-service'
import {
  abbreviatedWorkspaceGuard,
  PromptAssembler
} from '../../src/main/chat/prompt-assembler'

function assembler(): PromptAssembler {
  const memoryService = { formatCurrent: async () => '' } as unknown as MemoryService
  return new PromptAssembler(memoryService)
}

describe('PromptAssembler application behavior', () => {
  it('uses the application behavior layer for Engineering project threads', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/nonexistent-project',
      null,
      undefined,
      'brainstorm',
      'Custom implementation behavior.'
    )
    const behaviorLayer = layers.find((layer) =>
      layer.title.startsWith('Agent behavior (Project thread)')
    )
    expect(behaviorLayer?.content).toBe('Custom implementation behavior.')
    expect(layers.some((layer) => layer.title.includes('AGENTS.md'))).toBe(false)
  })

  it('omits the application behavior layer from chat and ephemeral sessions', async () => {
    const scopes = ['standalone-chat', 'ephemeral'] as const
    const scopedLayers = await Promise.all(
      scopes.map((scope) =>
        assembler().getLayers(
          scope === 'standalone-chat' ? 'inbox' : 'project-1',
          'thread-1',
          '',
          null,
          undefined,
          'chat',
          'Custom implementation behavior.',
          undefined,
          scope
        )
      )
    )
    for (const layers of scopedLayers) {
      expect(layers.some((layer) => layer.title.startsWith('Agent behavior'))).toBe(false)
    }
  })

  it('omits the workspace-scope guard layer for pure inbox chat', async () => {
    const layers = await assembler().getLayers(
      'inbox',
      'thread-1',
      '',
      null,
      undefined,
      'chat',
      'Custom.',
      undefined,
      'standalone-chat',
      'omitted'
    )
    const harness = layers.find((layer) => layer.title.startsWith('Harness:'))
    expect(harness).toBeUndefined()
  })

  it('sends only an abbreviated scope guard for scoped modes running in a real project', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/project',
      { id: 'opencode', name: 'OpenCode' },
      undefined,
      'chat',
      'Custom.',
      undefined,
      'ephemeral',
      'abbreviated'
    )
    const harness = layers.find((layer) => layer.title.startsWith('Harness:'))
    expect(harness).toBeDefined()
    expect(harness?.title).toContain('scope guard')
    expect(harness?.content).toContain('You are working inside')
    expect(harness?.content.length).toBeLessThan(1_200)
  })

  it('produces the full workspace context by default (engineering modes)', async () => {
    const layers = await assembler().getLayers(
      'project-1',
      'thread-1',
      '/project',
      { id: 'opencode', name: 'OpenCode' },
      undefined,
      'implement',
      'Custom.',
      undefined,
      'project-thread',
      'full'
    )
    const harness = layers.find((layer) => layer.title.startsWith('Harness:'))
    expect(harness).toBeDefined()
    expect(harness?.title).not.toContain('scope guard')
    expect(harness?.content).toContain('WORKING SCOPE')
  })

  it('exported abbreviated guard is compact and keeps the core scope guarantees', () => {
    const guard = abbreviatedWorkspaceGuard({ id: 'opencode', name: 'OpenCode' }, '/project')
    expect(guard.length).toBeLessThan(1_200)
    expect(guard).toContain('project')
    expect(guard).toContain('.cio/')
    expect(guard).not.toContain('WORKING SCOPE')
  })
})
