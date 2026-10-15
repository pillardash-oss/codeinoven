import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
const subscribe = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke, subscribe }))

import { assistants } from '$lib/stores/assistants.svelte'
import type { MissedRun, Assistant, Thread } from '$shared/types'

function assistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: 'r1',
    name: 'Triage',
    knowledge: 'Check PRs.',
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
    assistantId: 'r1',
    dueAt: 100,
    detectedAt: 200,
    title: 'Task',
    status: 'pending',
    ...overrides
  }
}

describe('assistants store', () => {
  beforeEach(() => {
    invoke.mockReset()
    subscribe.mockReset()
    subscribe.mockReturnValue(() => {})
    assistants.assistants = []
    assistants.missedRuns = []
  })

  it('resolves a task schedule from its assistant and prefers the override', () => {
    assistants.assistants = [assistant({ schedule: { cadence: 'daily', times: ['09:00'] } })]
    expect(assistants.scheduleForTask(task({ assistantId: 'r1' }))).toEqual({
      cadence: 'daily',
      times: ['09:00']
    })
    expect(
      assistants.scheduleForTask(
        task({ assistantId: 'r1', scheduleOverride: { cadence: 'hourly', times: [] } })
      )
    ).toEqual({ cadence: 'hourly', times: [] })
    expect(assistants.scheduleForTask(task())).toBeNull()
  })

  it('filters missed runs by task and by assistant', () => {
    assistants.missedRuns = [
      missed({ id: 't1:100', threadId: 't1', assistantId: 'r1' }),
      missed({ id: 't2:100', threadId: 't2', assistantId: 'r2' })
    ]
    expect(assistants.missedForTask('t1')).toHaveLength(1)
    expect(assistants.missedForAssistant('r1')).toHaveLength(1)
    expect(assistants.hasMissedForAssistant('r2')).toBe(true)
    expect(assistants.hasMissedForAssistant('r3')).toBe(false)
  })

  it('dismisses and runs a missed run through the assistant channels', async () => {
    invoke.mockResolvedValue(undefined)
    await assistants.dismissMissedRun('t1:100')
    expect(invoke).toHaveBeenCalledWith('assistant:dismissMissedRun', 't1:100')
    await assistants.runMissedRunNow('t1:100')
    expect(invoke).toHaveBeenCalledWith('assistant:runMissedRunNow', 't1:100')
  })

  it('replaces the assistant and missed-run lists from pushed events', () => {
    let assistantsHandler: ((assistants: Assistant[]) => void) | undefined
    let missedHandler: ((runs: MissedRun[]) => void) | undefined
    subscribe.mockImplementation((channel: string, callback: (payload: unknown) => void) => {
      if (channel === 'assistant:changed') assistantsHandler = callback as typeof assistantsHandler
      if (channel === 'assistant:missedRunsChanged')
        missedHandler = callback as typeof missedHandler
      return () => {}
    })
    invoke.mockResolvedValue([])
    assistants.initialize()

    const pushed = [assistant({ id: 'r9', name: 'Pushed' })]
    assistantsHandler?.(pushed)
    expect(assistants.assistants).toEqual(pushed)

    const runs = [missed({ id: 't9:1', assistantId: 'r9' })]
    missedHandler?.(runs)
    expect(assistants.missedRuns).toEqual(runs)
  })
})
