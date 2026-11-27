import { describe, expect, it } from 'vitest'
import { coordinatorHasUnreadWorkers, threadTracksReadStatus, type Thread } from '$shared/types'

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

/** A worker the user works with directly: it hands nothing back. */
const directWorker = worker({
  settings: {
    harnessId: 'pi',
    providerId: 'p',
    modelId: 'm',
    thinkingLevel: 'medium',
    permissionLevel: 'auto_review',
    reportToCoordinator: false
  }
})

describe('orchestration children and read state', () => {
  it('never lets a reporting worker carry a read state', () => {
    expect(threadTracksReadStatus(worker())).toBe(false)
  })

  it('lets the worker the user works with directly carry one', () => {
    expect(threadTracksReadStatus(directWorker)).toBe(true)
  })

  it('keeps auditors and pawns silent', () => {
    expect(threadTracksReadStatus(thread({ achievementRole: 'auditor' }))).toBe(false)
    expect(threadTracksReadStatus(thread({ assignmentId: 'assignment-1' }))).toBe(false)
    expect(threadTracksReadStatus(thread())).toBe(true)
  })

  it('puts a direct worker unread on the Sr. Engineer row, not just the rail', () => {
    // The coordinator row is read in its own right, but the worker the user
    // works with directly holds it open: the row wears the dot and the rail
    // counts it.
    expect(coordinatorHasUnreadWorkers(coordinator, [coordinator, directWorker])).toBe(true)
  })

  it('never holds the coordinator open for a reporting worker', () => {
    expect(coordinatorHasUnreadWorkers(coordinator, [coordinator, worker()])).toBe(false)
  })
})
