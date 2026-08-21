import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))
vi.mock('$lib/project-icons', () => ({
  getProjectIcon: () => null
}))

import { scopeState } from '$lib/stores/scope.svelte'
import type { ScopeBoard, ScopeBucket, ScopeTarget } from '$shared/types'

const managedBoard: ScopeBoard = {
  version: 2,
  worktreeDefaults: { setupCommands: [], runSetupByDefault: true, environmentMode: 'copy' },
  buckets: [
    {
      id: 'default',
      name: 'Default',
      sortOrder: 0,
      collapsed: false,
      collapsedSlices: [],
      root: { kind: 'project' }
    },
    {
      id: 'feature',
      name: 'Feature',
      sortOrder: 1,
      collapsed: false,
      collapsedSlices: [],
      root: {
        kind: 'worktree',
        directoryName: 'feature',
        branch: 'cio/feature',
        baseBranch: 'main',
        baseCommit: 'abc123',
        createdAt: 1000,
        environmentMode: 'copy',
        setup: { state: 'not_run', commands: [] }
      }
    }
  ]
}

function mockInvokeFor(board: ScopeBoard): void {
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const target = (args[1] ?? {}) as { projectId?: string; scopeBucketId?: string }
    switch (channel) {
      case 'scope:get':
        return board
      case 'scope:worktree:create':
        return managedBoard.buckets.find((bucket) => bucket.id === target.scopeBucketId)?.root
      case 'scope:worktree:health':
        return { category: 'healthy' }
      case 'scope:worktree:preflight':
        return {
          action: args[0],
          projectId: target.projectId ?? 'p1',
          scopeBucketId: target.scopeBucketId ?? 'feature',
          dirtyFiles: [],
          unpushedCommits: 0,
          hasActiveProcesses: false,
          branchOwnedByWorktree: false,
          confirmationId: 'conf-token-123',
          createdAt: Date.now()
        }
      default:
        return undefined
    }
  })
}

describe('ScopeState store (version 2)', () => {
  afterEach(() => {
    invoke.mockReset()
    subscribe.mockReset()
    vi.restoreAllMocks()
    scopeState.activeProjectId = null
    scopeState.projectRecords = []
    scopeState.boards = new Map()
  })

  it('loads a version 2 board and keeps lifecycle metadata on layout updates', async () => {
    scopeState.activeProjectId = 'p1'
    mockInvokeFor(managedBoard)
    await scopeState.loadBoard('p1')
    const loaded = scopeState.boards.get('p1')
    expect(loaded?.version).toBe(2)
    const managed = loaded?.buckets.find((entry) => entry.id === 'feature')
    expect(managed?.root.kind).toBe('worktree')
  })

  it('creates an isolated worktree through main-owned lifecycle IPC', async () => {
    scopeState.activeProjectId = 'p1'
    mockInvokeFor(managedBoard)
    const target: ScopeTarget = { projectId: 'p1', scopeBucketId: 'feature' }
    await scopeState.createWorktree(target.projectId, target.scopeBucketId, {
      title: 'Feature',
      runSetup: true,
      environmentMode: 'copy'
    })
    expect(invoke).toHaveBeenCalledWith(
      'scope:worktree:create',
      target,
      expect.objectContaining({ title: 'Feature', runSetup: true, environmentMode: 'copy' })
    )
  })

  it('derives health and preflights through main-owned IPC', async () => {
    mockInvokeFor(managedBoard)
    const health = await scopeState.worktreeHealth({ projectId: 'p1', scopeBucketId: 'feature' })
    expect(health.category).toBe('healthy')

    const preflight = await scopeState.preflightWorktree('p1', 'feature', 'remove-worktree')
    expect(preflight.confirmationId).toBe('conf-token-123')
    expect(invoke).toHaveBeenCalledWith('scope:worktree:preflight', 'remove-worktree', {
      projectId: 'p1',
      scopeBucketId: 'feature'
    })
  })

  it('keeps the Default scope project-rooted and non-archivable', () => {
    const defaultBucket = managedBoard.buckets.find(
      (entry) => entry.id === 'default'
    ) as ScopeBucket
    expect(defaultBucket.root).toEqual({ kind: 'project' })
    expect(defaultBucket.archivedAt).toBeUndefined()
  })
})
