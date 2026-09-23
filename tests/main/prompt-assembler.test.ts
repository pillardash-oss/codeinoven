import { describe, expect, it } from 'vitest'
import type { MemoryService } from '../../src/main/chat/memory-service'
import {
  abbreviatedWorkspaceGuard,
  assistantWorkspaceGuard,
  PromptAssembler
} from '../../src/main/chat/prompt-assembler'
import { defaultCioPrompt } from '../../src/lib/cio-prompts'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT, SKILLS_SECTION_BODY } from '../../src/lib/agent-behavior'

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

  it('gives the assistant scope its own behavior layer and workspace guard', async () => {
    const layers = await assembler().getLayers(
      'assistant',
      'thread-1',
      '/assistant-cwd/routine-1',
      { id: 'opencode', name: 'OpenCode' },
      undefined,
      'assistant',
      defaultCioPrompt('assistant'),
      undefined,
      'assistant',
      'assistant'
    )
    const behavior = layers.find((layer) => layer.title === 'Agent behavior (Assistant)')
    expect(behavior?.content).toContain('## Skills')
    expect(behavior?.content).not.toContain('Agent behavior for implementation work')
    // The guard names the routine's own workspace and keeps the citation rule;
    // it never claims a project the user opened.
    const workspace = layers.find((layer) => layer.title === 'Assistant workspace')
    expect(workspace).toBeDefined()
    expect(workspace?.content).toContain('/assistant-cwd/routine-1')
    expect(workspace?.content).toContain('Markdown link')
    expect(workspace?.content).not.toContain('WORKING SCOPE')
    const app = layers.find((layer) => layer.title.startsWith('Application:'))
    expect(app?.title).toContain('Assistant')
  })

  it('exported assistant guard is compact and keeps the citation rule', () => {
    const guard = assistantWorkspaceGuard(
      { id: 'opencode', name: 'OpenCode' },
      '/assistant-cwd/routine-1'
    )
    expect(guard.length).toBeLessThan(900)
    expect(guard).toContain('/assistant-cwd/routine-1')
    expect(guard).toContain('Markdown link')
    expect(guard).not.toContain('WORKING SCOPE')
    expect(guard).not.toContain("the user's project")
  })

  it('keeps the shared skills discipline identical in both behavior prompts', () => {
    // The work-ethics prompt indents the section into its numbered list; the
    // assistant prompt appends it whole. Both must carry the same rules.
    for (const line of SKILLS_SECTION_BODY.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      expect(DEFAULT_AGENT_BEHAVIOR_PROMPT).toContain(trimmed)
      expect(defaultCioPrompt('assistant')).toContain(trimmed)
    }
  })
})
