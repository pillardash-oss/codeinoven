// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The store's module graph reaches the preload bridge at load, so IPC is the one
// thing stubbed: everything under test (the cache, hydration, the live
// replacement) is the real implementation.
const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/ipc.svelte', () => ({
  invoke: invokeMock,
  subscribe: vi.fn(() => () => {})
}))

import { gitState } from '$lib/stores/git.svelte'
import { ovenSurfaceCacheKey, readOvenSurface, writeOvenSurface } from '$lib/oven-surface-cache'
import { ovenRootKeyFor } from '$shared/oven-root-routing'
import type { GitStatus } from '$shared/types'

const PROJECT = 'project-a'
const THREAD = 'thread-1'
const OVEN = 'oven-1'

function status(branch: string, dirty: number): GitStatus {
  return {
    branch,
    clean: dirty === 0,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    conflictState: 'none'
  } as unknown as GitStatus
}

const CACHED = status('cached-branch', 2)
const LIVE = status('live-branch', 0)

function seedCache(thread: string, cached: GitStatus): void {
  writeOvenSurface(ovenSurfaceCacheKey('git', OVEN, thread), {
    status: cached,
    branches: [],
    remotes: [],
    stashes: []
  })
}

function installInvoke(liveStatus: () => Promise<unknown>): void {
  invokeMock.mockImplementation(async (channel: string) => {
    if (channel === 'git:status') return liveStatus()
    if (channel === 'git:getIdentity') return { name: 'Dev', email: 'dev@example.com' }
    return []
  })
}

describe('Oven Git surface, cache first', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
    gitState.deactivate()
  })

  it('paints the last-known working tree before the Oven answers', () => {
    seedCache(THREAD, CACHED)
    gitState.activate(PROJECT, ovenRootKeyFor(THREAD, OVEN))
    expect(gitState.remoteTarget).toEqual({ threadId: THREAD, ovenId: OVEN })
    expect(gitState.status?.branch).toBe('cached-branch')
    expect(gitState.showingCachedStatus).toBe(true)
  })

  it('replaces the cached tree with the live read and keeps the new one', async () => {
    seedCache(THREAD, CACHED)
    gitState.activate(PROJECT, ovenRootKeyFor(THREAD, OVEN))
    installInvoke(async () => LIVE)
    await gitState.refresh(PROJECT)
    expect(gitState.status?.branch).toBe('live-branch')
    expect(gitState.showingCachedStatus).toBe(false)
    expect(gitState.workingTreeError).toBeNull()
    const kept = readOvenSurface<{ status: GitStatus }>(ovenSurfaceCacheKey('git', OVEN, THREAD))
    expect(kept?.status.branch).toBe('live-branch')
  })

  it('keeps the cached tree and names the reason when the Oven does not answer', async () => {
    seedCache(THREAD, CACHED)
    gitState.activate(PROJECT, ovenRootKeyFor(THREAD, OVEN))
    installInvoke(async () => {
      throw new Error('SSH connection failed (255). Check authentication and trust this host.')
    })
    await gitState.refresh(PROJECT)
    expect(gitState.status?.branch).toBe('cached-branch')
    expect(gitState.showingCachedStatus).toBe(true)
    expect(gitState.workingTreeError).toContain('SSH connection failed (255)')
  })

  it('does not cache or hydrate a local project', async () => {
    gitState.activate(PROJECT, 'local-scope-bucket')
    expect(gitState.remoteTarget).toBeNull()
    expect(gitState.showingCachedStatus).toBe(false)
    installInvoke(async () => LIVE)
    await gitState.refresh(PROJECT)
    expect(gitState.status?.branch).toBe('live-branch')
    expect(readOvenSurface(ovenSurfaceCacheKey('git', OVEN, THREAD))).toBeNull()
  })
})
