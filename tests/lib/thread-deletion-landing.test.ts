import { describe, expect, it } from 'vitest'
import { deletedThreadLanding } from '../../src/lib/thread-deletion-landing'

/**
 * Both `thread:deleted` subscribers ask this, and they must agree: the workspace's
 * subscriber clears the selection when there is nowhere to land, and the app-level
 * one navigates when there is. If they ever disagree, the first one to run wins by
 * clearing, and the reader falls through to the empty shell while the thread that
 * should have replaced theirs was still reachable.
 */
describe('deletedThreadLanding', () => {
  it('lands an auditor on the Sr. Engineer thread it audits', () => {
    expect(
      deletedThreadLanding({
        achievementRole: 'auditor',
        coordinatorThreadId: 'sr-engineer',
        assistantId: 'pildash'
      })
    ).toEqual({ kind: 'coordinator', threadId: 'sr-engineer' })
  })

  it('lands an assistant task on its assistant, in every state it is read in', () => {
    expect(deletedThreadLanding({ assistantId: 'pildash' })).toEqual({
      kind: 'assistant',
      assistantId: 'pildash'
    })
  })

  it('lands an assistant run on the same assistant as its task', () => {
    // A run carries its task's assistant, so a swept run lands exactly where the
    // task it belonged to would have.
    expect(deletedThreadLanding({ assistantId: 'pildash' })).toEqual({
      kind: 'assistant',
      assistantId: 'pildash'
    })
  })

  it('reports nowhere to go for a plain project thread', () => {
    expect(deletedThreadLanding({})).toEqual({ kind: 'none' })
  })

  it('does not treat an auditor without a coordinator as a landing place', () => {
    expect(deletedThreadLanding({ achievementRole: 'auditor' })).toEqual({ kind: 'none' })
  })
})
