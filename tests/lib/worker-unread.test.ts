import { describe, expect, it } from 'vitest'
import { coordinatorHasUnreadWorkers, threadTracksReadStatus, type Thread } from '$shared/types'
import { settledThreadReadsUnread } from '$shared/thread-status-policy'

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Payroll completeness',
    status: 'completed',
    read: false,
    createdAt: 0,
    updatedAt: 0,
    settings: { harnessId: 'pi', providerId: 'p', modelId: 'm' },
    ...overrides
  } as Thread
}

const coordinator = thread({
  id: 'coordinator-1',
  read: true,
  assignmentRole: 'coordinator',
  assignmentId: 'assignment-1'
})

function worker(overrides: Partial<Thread> = {}): Thread {
  return thread({
    id: 'worker-1',
    title: 'wrk-payroll: split the money rules',
    assignmentRole: 'worker',
    assignmentId: 'assignment-1',
    coordinatorThreadId: 'coordinator-1',
    ...overrides
  })
}

describe('orchestration children and read state', () => {
  it('never track a read state, reporting or not', () => {
    expect(threadTracksReadStatus(thread())).toBe(true)
    expect(threadTracksReadStatus(worker())).toBe(false)
    expect(threadTracksReadStatus(thread({ achievementRole: 'auditor' }))).toBe(false)
    expect(threadTracksReadStatus(thread({ assignmentId: 'assignment-1' }))).toBe(false)
  })

  it('keep a finished worker out of the unread rule', () => {
    // A worker settles its run like any thread, but the Assignment already
    // carries that news: the row must never read as unread.
    expect(settledThreadReadsUnread(worker(), false)).toBe(true) // the status rule
    expect(threadTracksReadStatus(worker())).toBe(false) // but the child gate refuses it
  })

  it('never hold the coordinator row open, so no unread dot and no rail mark', () => {
    expect(coordinatorHasUnreadWorkers(coordinator, [coordinator, worker()])).toBe(false)
    // A regular thread with an unread child is still counted: only children that
    // track read state can ever hold a done.
    expect(coordinatorHasUnreadWorkers(thread({ id: 'coordinator-1' }), [worker()])).toBe(false)
  })
})
