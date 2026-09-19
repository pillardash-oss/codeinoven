import { describe, expect, it } from 'vitest'
import { INBOX_PROJECT_ID } from '$shared/types'
import type { MemoryEntry } from '$shared/types'
import {
  managedScopesFor,
  memoryDestinationFor,
  memoryLocationKey,
  normalizeMemoryEntryForLocation,
  scopeIdsForChange,
  MEMORY_SCOPE_OPTIONS
} from '$lib/components/memory/memory-routing'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  const now = Date.now()
  return {
    id: 'memory-test',
    label: 'Test memory',
    content: 'Remember this.',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    category: 'preference',
    priority: 'medium',
    scope: 'global',
    source: 'manual',
    frequency: 1,
    lastReinforced: now,
    ...overrides
  }
}

describe('memoryDestinationFor', () => {
  it('routes global entries to the root file', () => {
    expect(memoryDestinationFor(entry())).toEqual({})
  })

  it('routes projects entries to the root file', () => {
    expect(memoryDestinationFor(entry({ scope: 'projects' }))).toEqual({})
  })

  it('routes chat entries to the standalone chat file', () => {
    expect(memoryDestinationFor(entry({ scope: 'chat' }))).toEqual({
      projectId: INBOX_PROJECT_ID
    })
  })

  it('routes project entries by their own projectId', () => {
    expect(memoryDestinationFor(entry({ scope: 'project', projectId: 'proj-1' }))).toEqual({
      projectId: 'proj-1'
    })
  })

  it('routes thread entries by their own projectId and threadId', () => {
    expect(
      memoryDestinationFor(entry({ scope: 'thread', projectId: 'proj-1', threadId: 'thr-1' }))
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-1' })
  })

  it('falls back to the panel context for staged project entries', () => {
    expect(
      memoryDestinationFor(entry({ scope: 'project' }), { projectId: 'proj-1', threadId: 'thr-1' })
    ).toEqual({ projectId: 'proj-1' })
  })

  it('falls back to the panel context for staged thread entries', () => {
    expect(
      memoryDestinationFor(entry({ scope: 'thread' }), { projectId: 'proj-1', threadId: 'thr-1' })
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-1' })
  })

  it('rejects a project entry without any project', () => {
    expect(() => memoryDestinationFor(entry({ scope: 'project' }))).toThrow(/needs a project/)
  })

  it('rejects a thread entry without any thread', () => {
    expect(() => memoryDestinationFor(entry({ scope: 'thread' }))).toThrow(/needs a thread/)
  })
})

describe('normalizeMemoryEntryForLocation', () => {
  it('strips ids from global entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scope: 'global', projectId: 'proj-1', threadId: 'thr-1' }),
      {}
    )
    expect(normalized.projectId).toBeUndefined()
    expect(normalized.threadId).toBeUndefined()
  })

  it('strips ids from projects entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scope: 'projects', projectId: 'proj-1' }),
      {}
    )
    expect(normalized.projectId).toBeUndefined()
    expect(normalized.threadId).toBeUndefined()
  })

  it('assigns the inbox as the chat entry project', () => {
    const normalized = normalizeMemoryEntryForLocation(entry({ scope: 'chat' }), {
      projectId: INBOX_PROJECT_ID
    })
    expect(normalized).toMatchObject({
      scope: 'chat',
      projectId: INBOX_PROJECT_ID,
      threadId: undefined
    })
  })

  it('keeps only the project id for project entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scope: 'project', projectId: 'proj-1', threadId: 'thr-1' }),
      { projectId: 'proj-1' }
    )
    expect(normalized).toMatchObject({ scope: 'project', projectId: 'proj-1', threadId: undefined })
  })

  it('keeps both ids for thread entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scope: 'thread', projectId: 'proj-1', threadId: 'thr-1' }),
      { projectId: 'proj-1', threadId: 'thr-1' }
    )
    expect(normalized).toMatchObject({
      scope: 'thread',
      projectId: 'proj-1',
      threadId: 'thr-1'
    })
  })
})

describe('managedScopesFor', () => {
  it('manages every global audience on the settings surface', () => {
    expect(managedScopesFor('settings')).toEqual(['global', 'projects', 'chat'])
  })

  it('never manages cross-audience global memory from a project sidebar', () => {
    const scopes = managedScopesFor('sidebar-projects')
    expect(scopes).toEqual(['projects', 'project', 'thread'])
    expect(scopes).not.toContain('global')
  })

  it('manages chat and thread scopes from a chat sidebar', () => {
    expect(managedScopesFor('sidebar-chats')).toEqual(['chat', 'thread'])
  })
})

describe('MEMORY_SCOPE_OPTIONS', () => {
  it('names the three global audiences plainly in settings', () => {
    expect(MEMORY_SCOPE_OPTIONS.settings.map((option) => option.label)).toEqual([
      'Projects',
      'Chats',
      'Both'
    ])
  })

  it('maps the project sidebar Global option to the projects-wide scope', () => {
    const global = MEMORY_SCOPE_OPTIONS['sidebar-projects'][0]
    expect(global.label).toBe('Global')
    expect(global.value).toBe('projects')
  })

  it('maps the chat sidebar Global option to the chat scope', () => {
    const global = MEMORY_SCOPE_OPTIONS['sidebar-chats'][0]
    expect(global.label).toBe('Global')
    expect(global.value).toBe('chat')
  })
})

describe('scopeIdsForChange', () => {
  it('clears ids when a memory becomes global, projects, or chat scoped', () => {
    const current = { projectId: 'proj-1', threadId: 'thr-1' }
    const cleared = { projectId: undefined, threadId: undefined }
    expect(scopeIdsForChange('global', current)).toEqual(cleared)
    expect(scopeIdsForChange('projects', current)).toEqual(cleared)
    expect(scopeIdsForChange('chat', current)).toEqual(cleared)
  })

  it('seeds a specific project from the panel context and drops the thread', () => {
    expect(scopeIdsForChange('project', {}, { projectId: 'proj-2', threadId: 'thr-2' })).toEqual({
      projectId: 'proj-2',
      threadId: undefined
    })
  })

  it('keeps an entry project when narrowing to a thread', () => {
    expect(
      scopeIdsForChange(
        'thread',
        { projectId: 'proj-1' },
        { projectId: 'proj-2', threadId: 'thr-2' }
      )
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-2' })
  })
})

describe('memoryLocationKey', () => {
  it('distinguishes root, project, and thread homes', () => {
    const root = memoryLocationKey({})
    const project = memoryLocationKey({ projectId: 'proj-1' })
    const thread = memoryLocationKey({ projectId: 'proj-1', threadId: 'thr-1' })
    expect(new Set([root, project, thread]).size).toBe(3)
  })
})
