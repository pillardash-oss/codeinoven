import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '$shared/types'

/**
 * The list a Schedule tab shows has to stay current without paying for it: an
 * agent status tick fires `thread:updated` many times per run, and a list that
 * re-read the database on each one would cost a round trip per step. These tests
 * pin the contract: events fold in from their own payload, run threads are
 * dropped before any list work, and the initial read happens once per assistant.
 */
const mock = vi.hoisted(() => {
  const listeners = new Map<string, (...args: never[]) => void>()
  return {
    listeners,
    invoke: vi.fn(),
    subscribe: vi.fn((channel: string, handler: (...args: never[]) => void) => {
      listeners.set(channel, handler)
      return () => {
        listeners.delete(channel)
      }
    }),
    listTasks: vi.fn()
  }
})

vi.mock('$lib/ipc.svelte', () => ({ invoke: mock.invoke, subscribe: mock.subscribe }))
vi.mock('$lib/stores/app-errors.svelte', () => ({ reportError: vi.fn() }))
vi.mock('$lib/stores/assistants.svelte', () => ({
  assistants: { listTasks: mock.listTasks, setTaskScheduled: vi.fn(), setTasksScheduled: vi.fn() }
}))

import { AssistantPanelSchedule } from '$lib/components/assistant/assistant-panel/assistant-panel-schedule.svelte'

function task(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'assistant',
    assistantId: 'a1',
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

function updated(thread: Thread): void {
  mock.listeners.get('thread:updated')?.(thread as never)
}

describe('AssistantPanelSchedule', () => {
  beforeEach(() => {
    mock.listeners.clear()
    mock.invoke.mockReset()
    mock.listTasks.mockReset()
  })

  afterEach(() => {
    mock.listeners.clear()
  })

  it('reads the list once per assistant, newest created first', async () => {
    mock.listTasks.mockResolvedValue([
      task({ id: 'old', createdAt: 10 }),
      task({ id: 'new', createdAt: 30 })
    ])
    const schedule = new AssistantPanelSchedule()

    await schedule.load('a1')
    await schedule.load('a1')

    expect(mock.listTasks).toHaveBeenCalledTimes(1)
    expect(schedule.tasks.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('folds a task scheduled by another surface in from the event, without a read', async () => {
    mock.listTasks.mockResolvedValue([task({ id: 'older', createdAt: 10 })])
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    schedule.watch('a1')

    updated(task({ id: 'from-don', createdAt: 20, title: 'Portfolio watch' }))

    expect(schedule.tasks.map((entry) => entry.id)).toEqual(['from-don', 'older'])
    // The whole row arrived on the event, so the list never asked again.
    expect(mock.listTasks).toHaveBeenCalledTimes(1)
    expect(mock.invoke).not.toHaveBeenCalled()
  })

  it('ignores run threads and other assistants on a status tick', async () => {
    mock.listTasks.mockResolvedValue([task({ id: 'kept', createdAt: 10 })])
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    schedule.watch('a1')

    updated(task({ id: 'run', createdAt: 20, assistantTaskId: 'kept' }))
    updated(task({ id: 'theirs', createdAt: 30, assistantId: 'a2' }))
    updated(task({ id: 'setup', createdAt: 40, assistantGettingStarted: true }))

    expect(schedule.tasks.map((entry) => entry.id)).toEqual(['kept'])
  })

  it('drops a task that was archived, moved away or deleted', async () => {
    mock.listTasks.mockResolvedValue([
      task({ id: 'a', createdAt: 10 }),
      task({ id: 'b', createdAt: 20 }),
      task({ id: 'c', createdAt: 30 })
    ])
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    schedule.watch('a1')

    updated(task({ id: 'a', createdAt: 10, archived: true }))
    updated(task({ id: 'b', createdAt: 20, assistantId: 'a2' }))
    mock.listeners.get('thread:deleted')?.('assistant' as never, 'c' as never)

    expect(schedule.tasks).toEqual([])
  })

  it('replaces one row in place and keeps the age order', async () => {
    mock.listTasks.mockResolvedValue([
      task({ id: 'new', createdAt: 30, title: 'New' }),
      task({ id: 'old', createdAt: 10, title: 'Old' })
    ])
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    schedule.watch('a1')

    updated(task({ id: 'old', createdAt: 10, title: 'Renamed', scheduled: false }))

    expect(schedule.tasks.map((entry) => [entry.id, entry.title])).toEqual([
      ['new', 'New'],
      ['old', 'Renamed']
    ])
    expect(schedule.isScheduled(schedule.tasks[1])).toBe(false)
  })

  it('deletes one task through the thread channel and drops its row', async () => {
    mock.listTasks.mockResolvedValue([
      task({ id: 'keep', createdAt: 30 }),
      task({ id: 'doomed', createdAt: 10, title: 'Old sweep' })
    ])
    mock.invoke.mockResolvedValue(undefined)
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    const doomed = schedule.tasks.find((entry) => entry.id === 'doomed')!

    await schedule.deleteOne(doomed)

    expect(mock.invoke).toHaveBeenCalledWith('thread:delete', 'assistant', 'doomed')
    expect(schedule.tasks.map((entry) => entry.id)).toEqual(['keep'])
  })

  it('stops listening when the panel leaves the assistant', async () => {
    mock.listTasks.mockResolvedValue([])
    const schedule = new AssistantPanelSchedule()
    await schedule.load('a1')
    const stop = schedule.watch('a1')

    stop()

    expect(mock.listeners.size).toBe(0)
  })
})
