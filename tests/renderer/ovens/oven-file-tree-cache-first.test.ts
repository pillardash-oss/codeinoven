// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Only the preload bridge is stubbed. The explorer, its state, and the cache are
// the real implementations, so what this exercises is the actual load path a
// remote file tree takes.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

import {
  ProjectFilesExplorer,
  type ProjectFilesExplorerHost
} from '$lib/stores/project-files-explorer.svelte'
import { createProjectFilesState, type ProjectFilesState } from '$lib/stores/project-files-state'
import { ovenSurfaceCacheKey, readOvenSurface, writeOvenSurface } from '$lib/oven-surface-cache'
import type { ProjectFileEntry } from '$shared/types'

const PROJECT = 'project-a'
const THREAD = 'thread-1'
const OVEN = 'oven-1'
const CACHE_KEY = ovenSurfaceCacheKey('files', OVEN, THREAD)

function entry(name: string): ProjectFileEntry {
  return { name, path: name, kind: 'file' } as unknown as ProjectFileEntry
}

function names(entries: ProjectFileEntry[] | undefined): string[] {
  return (entries ?? []).map((item) => item.name)
}

function mount(options: { oven?: boolean } = {}): {
  explorer: ProjectFilesExplorer
  state: ProjectFilesState
} {
  const state = createProjectFilesState(PROJECT)
  if (options.oven !== false) {
    state.ovenId = OVEN
    state.ovenThreadId = THREAD
  }
  const host: ProjectFilesExplorerHost = {
    stateFor: () => state,
    existingState: () => state,
    scopeFor: () => 'oven-scope-key',
    threadArg: () => THREAD,
    mountKeyFor: () => 'oven-mount-key',
    openFile: async () => undefined,
    refresh: async () => undefined
  }
  return { explorer: new ProjectFilesExplorer(host), state }
}

describe('Oven file tree, cache first', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
  })

  it('opens on the last-known listing while the Oven is still being asked', async () => {
    writeOvenSurface(CACHE_KEY, [entry('cached.txt')])
    const { explorer, state } = mount()
    let answer: (entries: ProjectFileEntry[]) => void = () => undefined
    invokeMock.mockImplementation(
      () =>
        new Promise<ProjectFileEntry[]>((resolve) => {
          answer = resolve
        })
    )
    const load = explorer.loadDirectory(PROJECT, '')

    // Read synchronously: this is what the user sees on the first frame.
    expect(names(state.entriesByDirectory[''])).toEqual(['cached.txt'])
    expect(state.listingFromCache).toBe(true)
    expect(state.loadingDirectories['']).toBe(true)

    answer([entry('live.txt')])
    await load
    expect(names(state.entriesByDirectory[''])).toEqual(['live.txt'])
    expect(state.listingFromCache).toBe(false)
  })

  it('keeps the last-known listing and records the reason when the Oven refuses', async () => {
    writeOvenSurface(CACHE_KEY, [entry('cached.txt')])
    const { explorer, state } = mount()
    invokeMock.mockRejectedValue(
      new Error('SSH connection failed (255). Check authentication and trust this host.')
    )
    await explorer.loadDirectory(PROJECT, '')
    expect(names(state.entriesByDirectory[''])).toEqual(['cached.txt'])
    expect(state.listingFromCache).toBe(true)
    expect(state.directoryErrors['']).toContain('SSH connection failed (255)')
    expect(state.loadingDirectories['']).toBeUndefined()
  })

  it('remembers the listing the Oven answered with', async () => {
    const { explorer } = mount()
    invokeMock.mockResolvedValue([entry('live.txt')])
    await explorer.loadDirectory(PROJECT, '')
    expect(names(readOvenSurface<ProjectFileEntry[]>(CACHE_KEY) ?? [])).toEqual(['live.txt'])
  })

  it('neither hydrates nor remembers anything for a local project', async () => {
    const { explorer, state } = mount({ oven: false })
    invokeMock.mockResolvedValue([entry('live.txt')])
    await explorer.loadDirectory(PROJECT, '')
    expect(names(state.entriesByDirectory[''])).toEqual(['live.txt'])
    expect(state.listingFromCache).toBe(false)
    expect(readOvenSurface<ProjectFileEntry[]>(CACHE_KEY)).toBeNull()
  })
})
