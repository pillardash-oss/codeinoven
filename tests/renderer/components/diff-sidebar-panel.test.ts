import { beforeEach, describe, expect, it, vi } from 'vitest'

// DiffSidebarPanel's dependency graph (stores, IPC) assumes a browser
// `window.api` bridge at module load. This focused test only exercises the
// module-level cache lifecycle, so stub the IPC module before importing the
// component to keep it DOM-free and deterministic.
vi.mock('$lib/ipc.svelte', () => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => {})
}))

import { cacheKeyFor, getOrCreateCache } from '$lib/components/files/diff-sidebar-cache.svelte'
import type { TurnCheckpointSummary } from '$shared/types'

function checkpoint(id: string): TurnCheckpointSummary {
  return {
    id,
    projectId: 'project-a',
    threadId: 'thread-1',
    label: `Run ${id}`,
    status: 'completed',
    changes: [],
    createdAt: 1_000
  }
}

describe('DiffSidebarPanel cache state lifecycle (REL-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keys each thread cache independently so switching threads never shares state', () => {
    const first = getOrCreateCache('project-a', 'thread-1')
    const second = getOrCreateCache('project-a', 'thread-2')

    first.checkpoints = [checkpoint('cp-1')]
    first.selectedCheckpointId = 'cp-1'

    // A different thread must resolve to its own untouched entry.
    expect(second.checkpoints).toEqual([])
    expect(second.selectedCheckpointId).toBeNull()
  })

  it('returns the same cache entry for the same thread (survives remount)', () => {
    const a = getOrCreateCache('project-b', 'thread-7')
    const b = getOrCreateCache('project-b', 'thread-7')
    expect(a).toBe(b)
  })

  it('discriminates on the project id too, not just the thread id', () => {
    const projectA = getOrCreateCache('project-a', 'thread-1')
    const projectC = getOrCreateCache('project-c', 'thread-1')
    expect(projectA).not.toBe(projectC)
  })

  it('builds a stable, project-qualified key for the seeded identity', () => {
    expect(cacheKeyFor('project-a', 'thread-1')).toBe('project-a:thread-1')
  })
})