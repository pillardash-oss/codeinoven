import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))

import { gitState } from '$lib/stores/git.svelte'
import type { GitStatus } from '$shared/types'

const fixtureStatus: GitStatus = {
  repositoryRoot: '/tmp/repo',
  branch: 'feature/x',
  detached: false,
  upstream: 'origin/feature/x',
  conflictState: 'none',
  clean: false,
  changes: [
    { path: 'src/a.ts', status: 'modified', staged: false },
    { path: 'src/b.ts', status: 'untracked', staged: false },
    { path: 'src/c.ts', status: 'added', staged: true }
  ],
  stagedChanges: 1,
  unstagedChanges: 1,
  untrackedChanges: 1,
  conflicted: [],
  ahead: 2,
  behind: 1
}

function mockInvokeForRefresh(): void {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'git:status') return fixtureStatus
    if (channel === 'git:branches') {
      return [
        { name: 'main', current: false, remote: null, ahead: 0, behind: 0 },
        { name: 'feature/x', current: true, remote: 'origin/feature/x', ahead: 2, behind: 1 }
      ]
    }
    if (channel === 'git:getIdentity')
      return { name: 'User', email: 'u@example.com', configured: true }
    return undefined
  })
}

describe('GitState store', () => {
  afterEach(() => {
    invoke.mockReset()
    subscribe.mockReset()
  })

  it('refresh resolves a typed GitStatus shape and derived accessors', async () => {
    mockInvokeForRefresh()
    gitState.activate('project-1')
    await gitState.refresh('project-1')

    expect(invoke).toHaveBeenCalledWith('git:status', 'project-1')
    expect(gitState.status?.branch).toBe('feature/x')
    expect(gitState.status?.ahead).toBe(2)
    expect(gitState.status?.behind).toBe(1)
    expect(gitState.status?.stagedChanges).toBe(1)
    expect(gitState.status?.changes).toHaveLength(3)
    expect(gitState.branch).toBe('feature/x')
    expect(gitState.clean).toBe(false)
    expect(gitState.conflicted).toEqual([])
    expect(gitState.conflictState).toBe('none')
    expect(gitState.branches.map((branch) => branch.name)).toEqual(['main', 'feature/x'])
    expect(gitState.identity?.configured).toBe(true)
  })

  it('tracks busy state per operation', () => {
    expect(gitState.isBusy('commit')).toBe(false)
    expect(gitState.isBusy(['stage', 'commit'])).toBe(false)
    gitState.markBusy('commit', true)
    expect(gitState.isBusy('commit')).toBe(true)
    expect(gitState.isBusy(['stage', 'commit'])).toBe(true)
    gitState.markBusy('commit', false)
    expect(gitState.isBusy('commit')).toBe(false)
  })

  it('records a sanitized error and clears status when refresh fails', async () => {
    invoke.mockRejectedValue(
      new Error("Error invoking remote method 'git:status': Error: repository is locked")
    )
    gitState.activate('project-1')
    await gitState.refresh('project-1')
    expect(gitState.error).toBe('repository is locked')
    expect(gitState.status).toBeNull()
  })

  it('applies a commit through git:commit and reflects the fresh status', async () => {
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'git:commit') {
        expect(args[1]).toBe('feat: thing')
        return { ...fixtureStatus, clean: true, changes: [], stagedChanges: 0 }
      }
      return undefined
    })
    await gitState.commit('project-1', 'feat: thing')
    expect(invoke).toHaveBeenCalledWith('git:commit', 'project-1', 'feat: thing')
    expect(gitState.status?.clean).toBe(true)
    expect(gitState.status?.stagedChanges).toBe(0)
  })

  it('exposes conflict state getters from the loaded status', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:status') {
        return {
          ...fixtureStatus,
          conflictState: 'merge',
          conflicted: ['src/a.ts'],
          changes: [{ path: 'src/a.ts', status: 'conflicted', staged: false }]
        }
      }
      return undefined
    })
    gitState.activate('project-2')
    await gitState.refresh('project-2')
    expect(gitState.conflictState).toBe('merge')
    expect(gitState.conflicted).toEqual(['src/a.ts'])
  })

  it('never writes a stale refresh from a project that is no longer active', async () => {
    mockInvokeForRefresh()
    gitState.activate('project-1')
    await gitState.refresh('project-1')
    expect(gitState.status?.branch).toBe('feature/x')

    // A refresh for the previous project starts, then the user switches.
    let resolveStale: (status: GitStatus) => void
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:status') {
        return new Promise<GitStatus>((resolve) => {
          resolveStale = resolve
        })
      }
      return undefined
    })
    const stale = gitState.refresh('project-1')
    gitState.activate('project-2')
    resolveStale!({ ...fixtureStatus, branch: 'stale/project-1' })
    await stale

    expect(gitState.status).toBeNull()
    expect(gitState.branch).toBeNull()
  })
})
