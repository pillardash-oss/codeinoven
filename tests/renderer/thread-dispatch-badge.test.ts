import { describe, expect, it } from 'vitest'
import { dispatchBadgeFor } from '../../src/renderer/lib/components/threads/thread-dispatch-badge'
import type { Thread, ThreadDispatchOrigin } from '../../src/lib/types'

/**
 * The badge states origin, and only origin.
 *
 * It reads a fact written once at dispatch creation, so it cannot disagree with
 * the ledger or with the run that later happens on the same thread.
 */

function thread(origin?: ThreadDispatchOrigin, extra: Partial<Thread> = {}): Thread {
  return {
    id: 'thread1',
    projectId: 'project1',
    providerId: 'pi',
    title: 'A dispatched thread',
    titleSource: 'manual',
    status: 'working',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project',
    ...(origin ? { dispatchOrigin: origin } : {}),
    ...extra
  }
}

const origin: ThreadDispatchOrigin = {
  assistantId: 'assistant1',
  assistantName: 'Scout',
  initiatorProjectId: 'assistant',
  initiatorThreadId: 'initiator1',
  at: 1
}

describe('dispatchBadgeFor', () => {
  it('names the assistant that dispatched the thread', () => {
    const badge = dispatchBadgeFor(thread(origin))
    expect(badge?.label).toBe('Dispatched by Scout')
    expect(badge?.title).toContain('Scout')
  })

  it('states origin without a name when the dispatch recorded none', () => {
    const badge = dispatchBadgeFor(
      thread({ initiatorProjectId: 'assistant', initiatorThreadId: 'i', at: 1 })
    )
    expect(badge?.label).toBe('Dispatched')
    expect(badge?.title).toBe('This thread was dispatched by an assistant.')
  })

  it('is absent for an ordinary project thread', () => {
    expect(dispatchBadgeFor(thread())).toBeNull()
  })

  it('does not restate what the thread is doing', () => {
    const badge = dispatchBadgeFor(thread(origin, { status: 'executing' }))
    expect(badge?.label).not.toMatch(/running|working|failed/iu)
  })

  it('carries both a visible label and a fuller accessible title', () => {
    const badge = dispatchBadgeFor(thread(origin))
    expect(badge?.label.length).toBeGreaterThan(0)
    expect(badge?.title.length).toBeGreaterThan(badge?.label.length ?? 0)
  })
})
