import { describe, expect, it } from 'vitest'
import { isGroupDispatchedRun, type Thread } from '$shared/types'
import { settledThreadReadsUnread } from '$shared/thread-status-policy'

const delegation = {
  at: 0,
  initiatorProjectId: 'assistant',
  initiatorThreadId: 'don',
  author: { assistantId: 'ola', name: 'Ola' }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'run-1',
    projectId: 'assistant',
    title: 'YouTube video ideas',
    status: 'completed',
    read: false,
    createdAt: 0,
    updatedAt: 0,
    settings: { harnessId: 'pi', providerId: 'cio-opendesign', modelId: 'm' },
    ...overrides
  } as Thread
}

describe('a run dispatched by a group conversation', () => {
  it('is recognised by the speaker snapshot on its dispatch origin', () => {
    expect(isGroupDispatchedRun({ dispatchOrigin: delegation })).toBe(true)
    expect(isGroupDispatchedRun({ dispatchOrigin: undefined })).toBe(false)
    expect(
      isGroupDispatchedRun({
        dispatchOrigin: { at: 0, initiatorProjectId: 'p', initiatorThreadId: 't' }
      })
    ).toBe(false)
  })

  it('never reads as unread, because the group carries the answer', () => {
    // The settled run's own row would otherwise show the unread dot next to a
    // reply the user just read in the group.
    expect(settledThreadReadsUnread(thread({ dispatchOrigin: delegation }), false)).toBe(false)
    expect(settledThreadReadsUnread(thread(), false)).toBe(true)
    expect(settledThreadReadsUnread(thread(), true)).toBe(false)
  })
})
