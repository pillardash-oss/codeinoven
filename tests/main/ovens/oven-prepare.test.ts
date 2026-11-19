import { describe, expect, it, vi } from 'vitest'
import {
  planOvenPrepare,
  runOvenPrepare,
  type OvenPrepareActions,
  type OvenPrepareFacts
} from '../../../src/main/ovens/oven-prepare'
import type { OvenPrepareStep } from '../../../src/lib/types'

const facts: OvenPrepareFacts = {
  harnessInstalled: true,
  gitInstalled: true,
  checkoutPresent: true,
  cloneExpected: true,
  ovenLabel: 'hetzner-1',
  harnessName: 'Claude Code',
  projectName: 'codeinoven'
}

/** A promise plus the two handles a test needs to observe and settle it. */
function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve: () => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function actions(overrides: Partial<OvenPrepareActions> = {}): OvenPrepareActions {
  return {
    harness: async () => undefined,
    git: async () => undefined,
    checkout: async () => undefined,
    ...overrides
  }
}

/** Let already-scheduled continuations run before asserting on them. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('oven prepare planner', () => {
  it('plans nothing when the Oven already has everything', () => {
    expect(planOvenPrepare(facts)).toEqual([])
  })

  it('plans only the missing pieces, in id order', () => {
    const steps = planOvenPrepare({
      ...facts,
      harnessInstalled: false,
      checkoutPresent: false
    })
    expect(steps.map((step) => step.id)).toEqual(['harness', 'checkout'])
    expect(steps.every((step) => step.status === 'waiting')).toBe(true)
  })

  it('names the Oven, the harness, and the project in its labels', () => {
    const steps = planOvenPrepare({
      ...facts,
      harnessInstalled: false,
      gitInstalled: false,
      checkoutPresent: false
    })
    expect(steps.map((step) => step.id)).toEqual(['harness', 'git', 'checkout'])
    expect(steps[0].label).toBe('Install Claude Code on hetzner-1')
    expect(steps[1].label).toBe('Install git on hetzner-1')
    expect(steps[2].label).toBe('Clone codeinoven onto hetzner-1')
  })

  it('plans git alone when only git is missing', () => {
    const steps = planOvenPrepare({ ...facts, gitInstalled: false })
    expect(steps.map((step) => step.id)).toEqual(['git'])
  })

  it('never plans a project clone for a chat that has no repository', () => {
    // A chat's directory is created quietly: there is nothing to clone, so a
    // "Clone the project" step would be a lie the reader cannot act on.
    expect(planOvenPrepare({ ...facts, cloneExpected: false, checkoutPresent: false })).toEqual([])
  })

  it('still plans the harness for a chat when that is all that is missing', () => {
    const steps = planOvenPrepare({
      ...facts,
      cloneExpected: false,
      checkoutPresent: false,
      harnessInstalled: false
    })
    expect(steps.map((step) => step.id)).toEqual(['harness'])
  })
})

describe('oven prepare runner', () => {
  it('starts every planned action before any of them finishes', async () => {
    const gates = { harness: deferred(), git: deferred(), checkout: deferred() }
    const started: string[] = []
    const steps = planOvenPrepare({
      ...facts,
      harnessInstalled: false,
      gitInstalled: false,
      checkoutPresent: false
    })
    const run = runOvenPrepare({
      steps,
      actions: actions({
        harness: () => {
          started.push('harness')
          return gates.harness.promise
        },
        git: () => {
          started.push('git')
          return gates.git.promise
        },
        checkout: () => {
          started.push('checkout')
          return gates.checkout.promise
        }
      }),
      publish: () => undefined
    })
    await settle()
    // All three are in flight, so none of them can be waiting for another.
    expect(started).toEqual(['harness', 'git', 'checkout'])
    for (const gate of Object.values(gates)) gate.resolve()
    const outcome = await run
    expect(outcome.failures).toEqual([])
    expect(outcome.steps.every((step) => step.status === 'done')).toBe(true)
  })

  it('does not cancel the other steps when one fails, and names the failure', async () => {
    const completed: string[] = []
    const outcome = await runOvenPrepare({
      steps: planOvenPrepare({
        ...facts,
        harnessInstalled: false,
        gitInstalled: false,
        checkoutPresent: false
      }),
      actions: actions({
        harness: async () => {
          throw new Error('npm exited with 127')
        },
        git: async () => {
          completed.push('git')
        },
        checkout: async () => {
          completed.push('checkout')
        }
      }),
      publish: () => undefined
    })
    expect(completed.sort()).toEqual(['checkout', 'git'])
    expect(outcome.failures).toEqual([{ id: 'harness', message: 'npm exited with 127' }])
    expect(outcome.steps.map((step) => step.status)).toEqual(['failed', 'done', 'done'])
    expect(outcome.steps[0].detail).toBe('npm exited with 127')
  })

  it('only runs the steps that were planned', async () => {
    const harness = vi.fn(async () => undefined)
    const outcome = await runOvenPrepare({
      steps: planOvenPrepare({ ...facts, checkoutPresent: false }),
      actions: actions({ harness }),
      publish: () => undefined
    })
    expect(harness).not.toHaveBeenCalled()
    expect(outcome.steps.map((step) => step.id)).toEqual(['checkout'])
  })
})

describe('oven prepare snapshots', () => {
  it('publishes running then done with both timestamps', async () => {
    let clock = 1_000
    const snapshots: OvenPrepareStep[][] = []
    const outcome = await runOvenPrepare({
      steps: planOvenPrepare({ ...facts, gitInstalled: false }),
      actions: actions(),
      publish: (next) => snapshots.push(next),
      now: () => (clock += 100)
    })
    expect(snapshots.map((snapshot) => snapshot[0].status)).toEqual(['running', 'done'])
    expect(snapshots[0][0].startedAt).toBe(1_100)
    expect(snapshots[0][0].endedAt).toBeUndefined()
    expect(snapshots[1][0].startedAt).toBe(1_100)
    expect(snapshots[1][0].endedAt).toBe(1_200)
    expect(outcome.steps[0]).toMatchObject({ id: 'git', status: 'done' })
  })

  it('publishes a failure snapshot for a step that threw', async () => {
    const snapshots: OvenPrepareStep[][] = []
    let clock = 1_000
    await runOvenPrepare({
      steps: planOvenPrepare({ ...facts, harnessInstalled: false }),
      actions: actions({
        harness: async () => {
          throw new Error('no install channel')
        }
      }),
      publish: (next) => snapshots.push(next),
      now: () => (clock += 100)
    })
    const last = snapshots[snapshots.length - 1]
    expect(last[0]).toMatchObject({
      id: 'harness',
      status: 'failed',
      detail: 'no install channel',
      startedAt: 1_100,
      endedAt: 1_200
    })
  })

  it('hands out snapshots the runner keeps mutating nothing behind', async () => {
    const snapshots: OvenPrepareStep[][] = []
    const outcome = await runOvenPrepare({
      steps: planOvenPrepare({ ...facts, gitInstalled: false }),
      actions: actions(),
      publish: (next) => snapshots.push(next)
    })
    snapshots[0][0].status = 'done'
    expect(outcome.steps[0].status).toBe('done')
    expect(snapshots[0]).not.toBe(snapshots[1])
    expect(snapshots[0][0]).not.toBe(snapshots[1][0])
  })
})
