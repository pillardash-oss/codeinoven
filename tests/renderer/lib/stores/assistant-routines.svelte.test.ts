import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))

import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
import type { MissedRun, Routine, Thread } from '$shared/types'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    name: 'Triage',
    howTo: 'Check PRs.',
    connections: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function task(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'assistant',
    providerId: 'pi',
    title: 'Task',
    titleSource: 'default',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '',
    ...overrides
  }
}

function missed(overrides: Partial<MissedRun> = {}): MissedRun {
  return {
    id: 't1:100',
    threadId: 't1',
    routineId: 'r1',
    dueAt: 100,
    detectedAt: 200,
    title: 'Task',
    status: 'pending',
    ...overrides
  }
}

describe('assistantRoutines store', () => {
  beforeEach(() => {
    invoke.mockReset()
    subscribe.mockReset()
    subscribe.mockReturnValue(() => {})
    assistantRoutines.routines = []
    assistantRoutines.missedRuns = []
  })

  it('resolves a task schedule from its routine and prefers the override', () => {
    assistantRoutines.routines = [
      routine({ schedule: { cadence: 'daily', times: ['09:00'] } })
    ]
    expect(assistantRoutines.scheduleForTask(task({ routineId: 'r1' }))).toEqual({
      cadence: 'daily',
      times: ['09:00']
    })
    expect(
      assistantRoutines.scheduleForTask(
        task({ routineId: 'r1', scheduleOverride: { cadence: 'hourly', times: [] } })
      )
    ).toEqual({ cadence: 'hourly', times: [] })
    expect(assistantRoutines.scheduleForTask(task())).toBeNull()
  })

  it('filters missed runs by task and by routine', () => {
    assistantRoutines.missedRuns = [
      missed({ id: 't1:100', threadId: 't1', routineId: 'r1' }),
      missed({ id: 't2:100', threadId: 't2', routineId: 'r2' })
    ]
    expect(assistantRoutines.missedForTask('t1')).toHaveLength(1)
    expect(assistantRoutines.missedForRoutine('r1')).toHaveLength(1)
    expect(assistantRoutines.hasMissedForRoutine('r2')).toBe(true)
    expect(assistantRoutines.hasMissedForRoutine('r3')).toBe(false)
  })

  it('dismisses and runs a missed run through the assistant channels', async () => {
    invoke.mockResolvedValue(undefined)
    await assistantRoutines.dismissMissedRun('t1:100')
    expect(invoke).toHaveBeenCalledWith('assistant:dismissMissedRun', 't1:100')
    await assistantRoutines.runMissedRunNow('t1:100')
    expect(invoke).toHaveBeenCalledWith('assistant:runMissedRunNow', 't1:100')
  })

  it('replaces the routine and missed-run lists from pushed events', () => {
    let routinesHandler: ((routines: Routine[]) => void) | undefined
    let missedHandler: ((runs: MissedRun[]) => void) | undefined
    subscribe.mockImplementation((channel: string, callback: (payload: unknown) => void) => {
      if (channel === 'routine:changed') routinesHandler = callback as typeof routinesHandler
      if (channel === 'assistant:missedRunsChanged')
        missedHandler = callback as typeof missedHandler
      return () => {}
    })
    invoke.mockResolvedValue([])
    assistantRoutines.initialize()

    const pushed = [routine({ id: 'r9', name: 'Pushed' })]
    routinesHandler?.(pushed)
    expect(assistantRoutines.routines).toEqual(pushed)

    const runs = [missed({ id: 't9:1', routineId: 'r9' })]
    missedHandler?.(runs)
    expect(assistantRoutines.missedRuns).toEqual(runs)
  })
})
