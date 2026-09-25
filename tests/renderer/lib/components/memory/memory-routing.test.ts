import { describe, expect, it } from 'vitest'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '$shared/types'
import type { MemoryEntry, MemoryProposal } from '$shared/types'
import {
  defaultScopesForSurface,
  entryVisibleOnSurface,
  locationForScopeChange,
  memoryDestinationFor,
  memoryLocationKey,
  normalizeMemoryEntryForLocation,
  planMemorySaveGroups,
  proposalVisibleOnSurface,
  surfaceContextAudience,
  MEMORY_SCOPE_OPTIONS,
  type MemorySurfaceContext
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
    scopes: [],
    source: 'manual',
    frequency: 1,
    lastReinforced: now,
    ...overrides
  }
}

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  const now = Date.now()
  return {
    id: 'proposal-test',
    label: 'Proposed memory',
    content: 'Maybe remember this.',
    category: 'preference',
    priority: 'medium',
    scopes: [],
    createdAt: now,
    expiresAt: now + 60_000,
    status: 'pending',
    ...overrides
  }
}

describe('defaultScopesForSurface', () => {
  it('starts every surface in its audience-wide set', () => {
    expect(defaultScopesForSurface('settings')).toEqual(['projects'])
    expect(defaultScopesForSurface('sidebar-projects')).toEqual(['projects'])
    expect(defaultScopesForSurface('sidebar-chats')).toEqual(['chat'])
    expect(defaultScopesForSurface('sidebar-assistant')).toEqual(['assistant'])
  })
})

describe('surfaceContextAudience', () => {
  it('maps each sidebar to the audience it loads memory for', () => {
    expect(surfaceContextAudience('sidebar-projects')).toBe('projects')
    expect(surfaceContextAudience('sidebar-chats')).toBe('chat')
    expect(surfaceContextAudience('sidebar-assistant')).toBe('assistant')
  })

  it('falls back to projects for settings, which never context-checks', () => {
    expect(surfaceContextAudience('settings')).toBe('projects')
  })
})

describe('entryVisibleOnSurface', () => {
  const settings: MemorySurfaceContext = { surface: 'settings' }

  it('shows audience-level entries (including the empty set) in settings', () => {
    expect(entryVisibleOnSurface(entry({ scopes: [] }), settings)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: ['projects'] }), settings)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: ['chat', 'assistant'] }), settings)).toBe(true)
  })

  it('hides located entries in settings', () => {
    expect(entryVisibleOnSurface(entry({ scopes: ['project'], projectId: 'p' }), settings)).toBe(
      false
    )
    expect(entryVisibleOnSurface(entry({ scopes: ['routine'], routineId: 'r' }), settings)).toBe(
      false
    )
  })

  it('shows only what reaches a project sidebar', () => {
    const context: MemorySurfaceContext = {
      surface: 'sidebar-projects',
      projectId: 'proj-1',
      threadId: 'thr-1'
    }
    expect(entryVisibleOnSurface(entry({ scopes: ['projects'] }), context)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: [] }), context)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: ['chat'] }), context)).toBe(false)
    expect(entryVisibleOnSurface(entry({ scopes: ['assistant'] }), context)).toBe(false)
    expect(
      entryVisibleOnSurface(entry({ scopes: ['project'], projectId: 'proj-1' }), context)
    ).toBe(true)
    expect(
      entryVisibleOnSurface(entry({ scopes: ['project'], projectId: 'proj-2' }), context)
    ).toBe(false)
    expect(
      entryVisibleOnSurface(
        entry({ scopes: ['thread'], projectId: 'proj-1', threadId: 'thr-1' }),
        context
      )
    ).toBe(true)
  })

  it('shows chat and thread memory in a chat sidebar', () => {
    const context: MemorySurfaceContext = {
      surface: 'sidebar-chats',
      projectId: INBOX_PROJECT_ID,
      threadId: 'chat-1'
    }
    expect(entryVisibleOnSurface(entry({ scopes: ['chat'] }), context)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: ['projects'] }), context)).toBe(false)
    expect(
      entryVisibleOnSurface(
        entry({ scopes: ['thread'], projectId: INBOX_PROJECT_ID, threadId: 'chat-1' }),
        context
      )
    ).toBe(true)
  })

  it('drops other routines and other tasks from an assistant sidebar', () => {
    const context: MemorySurfaceContext = {
      surface: 'sidebar-assistant',
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'task-1',
      routineId: 'routine-1'
    }
    expect(entryVisibleOnSurface(entry({ scopes: ['assistant'] }), context)).toBe(true)
    expect(entryVisibleOnSurface(entry({ scopes: ['projects'] }), context)).toBe(false)
    expect(
      entryVisibleOnSurface(entry({ scopes: ['routine'], routineId: 'routine-1' }), context)
    ).toBe(true)
    expect(
      entryVisibleOnSurface(entry({ scopes: ['routine'], routineId: 'routine-2' }), context)
    ).toBe(false)
    expect(entryVisibleOnSurface(entry({ scopes: ['task'], threadId: 'task-1' }), context)).toBe(
      true
    )
    expect(entryVisibleOnSurface(entry({ scopes: ['task'], threadId: 'task-2' }), context)).toBe(
      false
    )
  })
})

describe('proposalVisibleOnSurface', () => {
  it('uses the same rule as entries', () => {
    expect(proposalVisibleOnSurface(proposal({ scopes: ['chat'] }), { surface: 'settings' })).toBe(
      true
    )
    expect(
      proposalVisibleOnSurface(proposal({ scopes: ['thread'], projectId: 'p', threadId: 't' }), {
        surface: 'settings'
      })
    ).toBe(false)
    expect(
      proposalVisibleOnSurface(proposal({ scopes: ['chat'] }), {
        surface: 'sidebar-chats',
        projectId: INBOX_PROJECT_ID
      })
    ).toBe(true)
  })
})

describe('locationForScopeChange', () => {
  it('routes audience-level sets to their audience file', () => {
    expect(locationForScopeChange([])).toEqual({})
    expect(locationForScopeChange(['projects'])).toEqual({})
    expect(locationForScopeChange(['projects', 'chat'])).toEqual({})
    expect(locationForScopeChange(['chat'])).toEqual({ projectId: INBOX_PROJECT_ID })
    expect(locationForScopeChange(['assistant'])).toEqual({ projectId: ASSISTANT_SPACE_ID })
  })

  it('seeds a specific project from the panel context', () => {
    expect(
      locationForScopeChange(['project'], {}, { projectId: 'proj-2', threadId: 'thr-2' })
    ).toEqual({ projectId: 'proj-2' })
  })

  it('keeps an entry project when narrowing to a thread', () => {
    expect(
      locationForScopeChange(
        ['thread'],
        { projectId: 'proj-1' },
        { projectId: 'proj-2', threadId: 'thr-2' }
      )
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-2' })
  })

  it('pins routine and task memory to the assistant space', () => {
    expect(locationForScopeChange(['routine'], {}, { routineId: 'routine-1' })).toEqual({
      projectId: ASSISTANT_SPACE_ID,
      routineId: 'routine-1'
    })
    expect(locationForScopeChange(['task'], {}, { threadId: 'task-1' })).toEqual({
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'task-1'
    })
  })
})

describe('memoryDestinationFor', () => {
  it('routes audience-level entries to their audience file', () => {
    expect(memoryDestinationFor(entry())).toEqual({})
    expect(memoryDestinationFor(entry({ scopes: ['projects'] }))).toEqual({})
    expect(memoryDestinationFor(entry({ scopes: ['projects', 'chat'] }))).toEqual({})
  })

  it('routes chat entries to the standalone chat file', () => {
    expect(memoryDestinationFor(entry({ scopes: ['chat'] }))).toEqual({
      projectId: INBOX_PROJECT_ID
    })
  })

  it('routes assistant entries to the assistant container file', () => {
    expect(memoryDestinationFor(entry({ scopes: ['assistant'] }))).toEqual({
      projectId: ASSISTANT_SPACE_ID
    })
  })

  it('routes project entries by their own projectId', () => {
    expect(memoryDestinationFor(entry({ scopes: ['project'], projectId: 'proj-1' }))).toEqual({
      projectId: 'proj-1'
    })
  })

  it('routes thread entries by their own projectId and threadId', () => {
    expect(
      memoryDestinationFor(entry({ scopes: ['thread'], projectId: 'proj-1', threadId: 'thr-1' }))
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-1' })
  })

  it('routes routine entries to the assistant container file', () => {
    expect(memoryDestinationFor(entry({ scopes: ['routine'], routineId: 'routine-1' }))).toEqual({
      projectId: ASSISTANT_SPACE_ID
    })
  })

  it('routes task entries to the assistant task file', () => {
    expect(memoryDestinationFor(entry({ scopes: ['task'], threadId: 'task-1' }))).toEqual({
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'task-1'
    })
  })

  it('falls back to the panel context for staged entries', () => {
    expect(
      memoryDestinationFor(entry({ scopes: ['project'] }), {
        projectId: 'proj-1',
        threadId: 'thr-1'
      })
    ).toEqual({ projectId: 'proj-1' })
    expect(
      memoryDestinationFor(entry({ scopes: ['thread'] }), {
        projectId: 'proj-1',
        threadId: 'thr-1'
      })
    ).toEqual({ projectId: 'proj-1', threadId: 'thr-1' })
    expect(
      memoryDestinationFor(entry({ scopes: ['routine'] }), { routineId: 'routine-1' })
    ).toEqual({
      projectId: ASSISTANT_SPACE_ID
    })
  })

  it('rejects located entries without a place', () => {
    expect(() => memoryDestinationFor(entry({ scopes: ['project'] }))).toThrow(/needs a project/)
    expect(() => memoryDestinationFor(entry({ scopes: ['thread'] }))).toThrow(/needs a thread/)
    expect(() => memoryDestinationFor(entry({ scopes: ['routine'] }))).toThrow(/needs a routine/)
    expect(() => memoryDestinationFor(entry({ scopes: ['task'] }))).toThrow(/needs a task/)
  })

  it('names the entry in the error', () => {
    expect(() =>
      memoryDestinationFor(entry({ label: 'Preferred language', scopes: ['project'] }))
    ).toThrow(/"Preferred language"/)
  })
})

describe('normalizeMemoryEntryForLocation', () => {
  it('strips ids from audience-level entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scopes: ['projects'], projectId: 'proj-1', threadId: 'thr-1', routineId: 'r-1' }),
      {}
    )
    expect(normalized.projectId).toBeUndefined()
    expect(normalized.threadId).toBeUndefined()
    expect(normalized.routineId).toBeUndefined()
  })

  it('stamps the inbox as the chat entry project', () => {
    const normalized = normalizeMemoryEntryForLocation(entry({ scopes: ['chat'] }), {})
    expect(normalized).toMatchObject({
      projectId: INBOX_PROJECT_ID,
      threadId: undefined,
      routineId: undefined
    })
  })

  it('stamps the assistant space for assistant entries', () => {
    const normalized = normalizeMemoryEntryForLocation(entry({ scopes: ['assistant'] }), {})
    expect(normalized.projectId).toBe(ASSISTANT_SPACE_ID)
    expect(normalized.threadId).toBeUndefined()
    expect(normalized.routineId).toBeUndefined()
  })

  it('keeps only the project id for project entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scopes: ['project'], projectId: 'proj-1', threadId: 'thr-1', routineId: 'r-1' }),
      { projectId: 'proj-1' }
    )
    expect(normalized).toMatchObject({ projectId: 'proj-1', threadId: undefined })
    expect(normalized.routineId).toBeUndefined()
  })

  it('keeps both ids for thread entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scopes: ['thread'], projectId: 'proj-1', threadId: 'thr-1' }),
      { projectId: 'proj-1', threadId: 'thr-1' }
    )
    expect(normalized).toMatchObject({ projectId: 'proj-1', threadId: 'thr-1' })
  })

  it('stamps the assistant space and routine for routine entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scopes: ['routine'], projectId: 'proj-1', threadId: 'thr-1', routineId: 'r-1' }),
      { routineId: 'r-1' }
    )
    expect(normalized).toMatchObject({
      projectId: ASSISTANT_SPACE_ID,
      threadId: undefined,
      routineId: 'r-1'
    })
  })

  it('stamps the assistant space and task for task entries', () => {
    const normalized = normalizeMemoryEntryForLocation(
      entry({ scopes: ['task'], threadId: 'task-1', routineId: 'r-1' }),
      { threadId: 'task-1' }
    )
    expect(normalized).toMatchObject({
      projectId: ASSISTANT_SPACE_ID,
      threadId: 'task-1',
      routineId: undefined
    })
  })
})

describe('MEMORY_SCOPE_OPTIONS', () => {
  it('names the three audiences plainly in settings', () => {
    expect(MEMORY_SCOPE_OPTIONS.settings.map((option) => option.label)).toEqual([
      'Projects',
      'Chats',
      'Assistants'
    ])
    expect(MEMORY_SCOPE_OPTIONS.settings.every((option) => !option.located)).toBe(true)
  })

  it('maps the project sidebar Global option to the projects audience', () => {
    const global = MEMORY_SCOPE_OPTIONS['sidebar-projects'][0]
    expect(global.label).toBe('Global')
    expect(global.value).toBe('projects')
    expect(global.located).toBe(false)
  })

  it('maps the chat sidebar Global option to the chat audience', () => {
    const global = MEMORY_SCOPE_OPTIONS['sidebar-chats'][0]
    expect(global.label).toBe('Global')
    expect(global.value).toBe('chat')
    expect(global.located).toBe(false)
  })

  it('offers assistant, routine, and task on the assistant sidebar', () => {
    expect(MEMORY_SCOPE_OPTIONS['sidebar-assistant'].map((option) => option.value)).toEqual([
      'assistant',
      'routine',
      'task'
    ])
    expect(MEMORY_SCOPE_OPTIONS['sidebar-assistant'].map((option) => option.located)).toEqual([
      false,
      true,
      true
    ])
  })

  it('marks located options with the pickers they need', () => {
    const project = MEMORY_SCOPE_OPTIONS['sidebar-projects'].find(
      (option) => option.value === 'project'
    )
    const thread = MEMORY_SCOPE_OPTIONS['sidebar-projects'].find(
      (option) => option.value === 'thread'
    )
    expect(project).toMatchObject({ located: true, needsProject: true, needsThread: false })
    expect(thread).toMatchObject({ located: true, needsProject: true, needsThread: true })
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

describe('planMemorySaveGroups', () => {
  it('groups entries by destination file and keeps empty loaded locations', () => {
    const loaded = [
      entry({ id: 'root-entry', scopes: ['projects'] }),
      entry({ id: 'chat-entry', scopes: ['chat'] }),
      entry({ id: 'thread-entry', scopes: ['thread'], projectId: 'proj-1', threadId: 'thr-1' })
    ]
    const groups = planMemorySaveGroups([], loaded)
    const keys = groups.map((group) => memoryLocationKey(group.location)).sort()
    expect(keys).toEqual(
      [
        memoryLocationKey({}),
        memoryLocationKey({ projectId: INBOX_PROJECT_ID }),
        memoryLocationKey({ projectId: 'proj-1', threadId: 'thr-1' })
      ].sort()
    )
    expect(groups.every((group) => group.managedEntries.length === 0)).toBe(true)
  })

  it('normalizes each managed entry to its destination', () => {
    const groups = planMemorySaveGroups(
      [entry({ id: 'chat-entry', scopes: ['chat'], projectId: 'stale' })],
      []
    )
    const chatGroup = groups.find(
      (group) => group.location.projectId === INBOX_PROJECT_ID && !group.location.threadId
    )
    expect(chatGroup?.managedEntries[0]).toMatchObject({ projectId: INBOX_PROJECT_ID })
  })

  it('keeps a routine id while grouping into the assistant container file', () => {
    const groups = planMemorySaveGroups(
      [entry({ id: 'routine-entry', scopes: ['routine'], routineId: 'routine-1' })],
      []
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].location).toEqual({ projectId: ASSISTANT_SPACE_ID })
    expect(groups[0].managedEntries[0]).toMatchObject({
      projectId: ASSISTANT_SPACE_ID,
      routineId: 'routine-1'
    })
  })
})
