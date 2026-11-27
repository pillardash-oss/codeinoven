import { describe, expect, it } from 'vitest'
import { retryResumesOwnThread } from '../../../src/main/chat/chat-engine/chat-engine-retry-eligibility'

describe('retryResumesOwnThread', () => {
  it('schedules a normal session that is not a child of anything', () => {
    expect(retryResumesOwnThread(undefined, 'thread-1')).toBe(true)
  })

  it('schedules a pawn, which is a child session that owns its own thread', () => {
    expect(
      retryResumesOwnThread({ threadId: 'pawn-thread', parentSessionId: undefined }, 'pawn-thread')
    ).toBe(true)
  })

  it('refuses a nested sub-agent, whose session belongs to the parent thread', () => {
    expect(
      retryResumesOwnThread(
        { threadId: 'parent-thread', parentSessionId: 'parent-session' },
        'parent-thread'
      )
    ).toBe(false)
  })

  it('refuses a child session that names a different thread even without a parent session', () => {
    expect(retryResumesOwnThread({ threadId: 'other-thread' }, 'thread-1')).toBe(false)
  })
})
