import { describe, expect, it, vi } from 'vitest'
import {
  RunScopeGate,
  RunScopeParkedError,
  type RunScopeGateResult
} from '../../src/main/chat/run-scope-gate'
import { ScopeRootUnavailableError } from '../../src/main/workspaces/scope-root-resolver'
import { scopeWorktreeUnavailableMessage } from '../../src/lib/scope-worktree-health'
import type { Thread, ScopeWorktreeHealthCategory } from '../../src/lib/types'
import { ASSISTANT_SPACE_ID } from '../../src/lib/types'

/**
 * The park gate, one case per health category the resolver can report.
 *
 * A bound assistant run may only start when its checkout is provably usable.
 * Every unhealthy category has to park the run with that category, the app's
 * own guidance string, and the refused turn, because the alternative is a run
 * that writes into assistant storage while the user believes it worked in their
 * project.
 */

const TASK_ID = 'task1'
const RUN_ID = 'run1'
const PROJECT_ID = 'project1'
const SCOPE_ID = 'worktree-1'

function boundTask(overrides: Partial<Thread> = {}): Thread {
  return {
    id: TASK_ID,
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Weekly digest',
    titleSource: 'default',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    assistantId: 'assistant1',
    boundScope: { projectId: PROJECT_ID, scopeBucketId: SCOPE_ID },
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '',
    ...overrides
  }
}

/** Every category the resolver can put on an unhealthy resolution. */
const UNHEALTHY_CATEGORIES: ScopeWorktreeHealthCategory[] = [
  'missing',
  'unregistered',
  'locked',
  'prunable',
  'branch-mismatch',
  'path-mismatch',
  'not-managed',
  'repository-unavailable'
]

describe('RunScopeGate', () => {
  it('proceeds on a healthy scope and resolves the checkout', async () => {
    const gate = new RunScopeGate({
      resolveCompatibilityRoot: vi.fn(async () => '/tmp/project')
    })
    const park = vi.fn()
    await expect(gate.guard(boundTask(), park)).resolves.toBeUndefined()
    expect(park).not.toHaveBeenCalled()
    const result = await gate.inspect(boundTask())
    expect(result).toEqual({ action: 'proceed', root: '/tmp/project' })
  })

  it('proceeds for an unbound task, which has no checkout to prove', async () => {
    const resolveCompatibilityRoot = vi.fn(async () => '/tmp/assistant')
    const gate = new RunScopeGate({ resolveCompatibilityRoot })
    const park = vi.fn()
    await gate.guard(boundTask({ boundScope: undefined }), park)
    expect(resolveCompatibilityRoot).not.toHaveBeenCalled()
    expect(park).not.toHaveBeenCalled()
  })

  for (const category of UNHEALTHY_CATEGORIES) {
    it(`parks a ${category} scope with that category and the app's guidance`, async () => {
      const health = { category, detail: `detail for ${category}` }
      const gate = new RunScopeGate({
        resolveCompatibilityRoot: vi.fn(async () => {
          throw new ScopeRootUnavailableError(health)
        })
      })
      const park = vi.fn(async () => undefined)

      await expect(gate.guard(boundTask(), park)).rejects.toBeInstanceOf(RunScopeParkedError)

      expect(park).toHaveBeenCalledTimes(1)
      expect(park).toHaveBeenCalledWith({
        category,
        message: scopeWorktreeUnavailableMessage(health),
        projectId: PROJECT_ID,
        scopeBucketId: SCOPE_ID
      })
    })
  }

  it('parks rather than starting when the bound project has no usable path', async () => {
    const gate = new RunScopeGate({ resolveCompatibilityRoot: vi.fn(async () => null) })
    const park = vi.fn(async () => undefined)
    await expect(gate.guard(boundTask(), park)).rejects.toBeInstanceOf(RunScopeParkedError)
    expect(park).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'repository-unavailable', projectId: PROJECT_ID })
    )
  })

  it('parks when no resolver is wired at all, instead of assuming a checkout', async () => {
    const gate = new RunScopeGate(undefined)
    const park = vi.fn(async () => undefined)
    await expect(gate.guard(boundTask(), park)).rejects.toBeInstanceOf(RunScopeParkedError)
    expect(park).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'repository-unavailable' })
    )
  })

  it('rethrows an unexpected resolver failure instead of parking on it', async () => {
    const gate = new RunScopeGate({
      resolveCompatibilityRoot: vi.fn(async () => {
        throw new Error('disk on fire')
      })
    })
    await expect(gate.guard(boundTask(), vi.fn())).rejects.toThrow('disk on fire')
  })

  it('states a proceed result for a project thread without a binding', async () => {
    const gate = new RunScopeGate(undefined)
    const result: RunScopeGateResult = await gate.inspect(boundTask({ boundScope: undefined }))
    expect(result).toEqual({ action: 'proceed', root: null })
  })
})
