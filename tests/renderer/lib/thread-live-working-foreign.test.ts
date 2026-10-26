// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForeignRunNotice, Thread } from '$shared/types'

/**
 * A thread another instance owns is the one case this window cannot settle from
 * its own run state: it holds no harness for that turn, so the entry it keeps is
 * only a projection of the sibling's stream. These lock in the two promises the
 * rail depends on:
 *
 *  1. the shared row decides for a foreign turn, in both directions, so a
 *     finished run never keeps counting as work and a live one is never hidden;
 *  2. a locally owned run keeps exactly the precedence it had before, where a
 *     settled run state outranks a stale persisted status.
 */

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>()
}))

vi.mock('$lib/ipc.svelte', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/ipc.svelte')>()
  return {
    ...actual,
    invoke: vi.fn(async () => []),
    subscribe: (channel: string, handler: (...args: unknown[]) => void) => {
      ipc.handlers.set(channel, handler)
      return () => ipc.handlers.delete(channel)
    },
    subscribeGuarded: (channel: string, handler: (...args: unknown[]) => void) => {
      ipc.handlers.set(channel, handler)
      return () => ipc.handlers.delete(channel)
    }
  }
})

// The foreign-run store reports transfer failures through this module, which
// pulls the workspace store in with it. A transfer is not what these tests
// exercise, so the toast is stubbed and the chain stays small.
vi.mock('$lib/stores/app-errors.svelte', () => ({ showToastError: () => undefined }))

const { agentRuns } = await import('$lib/stores/agent-runs.svelte')
const { foreignRuns } = await import('$lib/stores/foreign-runs.svelte')
const { isThreadLiveWorking } = await import('$lib/thread-status-badge')
const { threadWorkingForIndicator } = await import(
  '$lib/components/layout/app-header-thread-status'
)

function pushForeign(notices: Array<Pick<ForeignRunNotice, 'projectId' | 'threadId'>>): void {
  const payload: ForeignRunNotice[] = notices.map((notice) => ({ ...notice, workflow: false }))
  ipc.handlers.get('thread:foreignRuns')?.(payload)
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Keep two instances in one room',
    status: 'completed',
    read: true,
    pinned: false,
    sessionId: 's1',
    lastActivity: Date.now(),
    settings: { harnessId: 'claude-code', providerId: 'anthropic', modelId: 'sonnet' },
    usedHarnessIds: ['claude-code'],
    branch: 'fix/foreign-runs',
    ...over
  } as unknown as Thread
}

beforeEach(() => {
  pushForeign([])
  agentRuns.clear('p1', 't1')
})

describe('a thread another instance owns', () => {
  it('counts as working from the shared row even after this window settled it idle', () => {
    // An earlier run here left a settled entry behind, so the local run state
    // says idle while the sibling is genuinely running the thread.
    agentRuns.setIdle('p1', 't1')
    pushForeign([{ projectId: 'p1', threadId: 't1' }])

    const row = thread({ status: 'executing' })

    expect(foreignRuns.isForeign('p1', 't1')).toBe(true)
    expect(isThreadLiveWorking(row)).toBe(true)
    // The rail counts a thread through this one predicate.
    expect(threadWorkingForIndicator(row)).toBe(true)
  })

  it('stops counting as working the moment the shared row settles', () => {
    pushForeign([{ projectId: 'p1', threadId: 't1' }])
    // The stream from the sibling established a busy run, and its terminal
    // frame never arrived: the row is the only truth left.
    agentRuns.setBusy('p1', 't1', true)

    expect(isThreadLiveWorking(thread({ status: 'executing' }))).toBe(true)
    expect(isThreadLiveWorking(thread({ status: 'completed' }))).toBe(false)
    expect(threadWorkingForIndicator(thread({ status: 'completed' }))).toBe(false)
  })

  it('drops the run state it projected once the turn stops being foreign', () => {
    pushForeign([{ projectId: 'p1', threadId: 't1' }])
    agentRuns.setBusy('p1', 't1', true)

    // The sibling released the turn, and the main process already re-read and
    // pushed the settled row, so nothing here may keep the run alive.
    pushForeign([])

    expect(foreignRuns.isForeign('p1', 't1')).toBe(false)
    expect(agentRuns.isBusy('p1', 't1')).toBe(false)
    expect(threadWorkingForIndicator(thread({ status: 'completed' }))).toBe(false)
  })

  it('stays out of the working count while it is parked on the user', () => {
    pushForeign([{ projectId: 'p1', threadId: 't1' }])
    agentRuns.setBusy('p1', 't1', true)

    expect(isThreadLiveWorking(thread({ status: 'awaiting_approval' }))).toBe(false)
    expect(isThreadLiveWorking(thread({ status: 'working-paused' }))).toBe(false)
  })
})

describe('a thread this instance owns', () => {
  it('never revives a stale persisted status after the run settled', () => {
    agentRuns.setIdle('p1', 't1')

    expect(isThreadLiveWorking(thread({ status: 'executing' }))).toBe(false)
  })

  it('keeps a live run in front of a row that already reads settled', () => {
    agentRuns.setBusy('p1', 't1', true)

    expect(isThreadLiveWorking(thread({ status: 'completed' }))).toBe(true)
  })

  it('reads the persisted status before anything settles here', () => {
    expect(isThreadLiveWorking(thread({ status: 'planning' }))).toBe(true)
    expect(isThreadLiveWorking(thread({ status: 'completed' }))).toBe(false)
  })
})
