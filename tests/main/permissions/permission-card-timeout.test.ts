import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatEnginePermissions } from '../../../src/main/chat/chat-engine/chat-engine-permissions'
import type { PendingPermissionInfo } from '../../../src/main/chat/chat-engine/chat-engine-types'

/**
 * A permission card is the one gate nothing can approve on the user's behalf,
 * and an unanswered one used to park the turn forever. It now closes on the same
 * configurable timeout the question and secret cards use, refuses the request,
 * and hands the agent an instruction to find another way. These lock in the
 * three properties that make that safe: the countdown holds while the user is
 * working, the deadline is the shared one, and the refusal is the corrective
 * rejection (never a plain reject that would abort the turn).
 */

const QUESTION_TIMEOUT_MS = 300_000

interface AutoAnswerRecord {
  kind: string
  outcome: string
  threadId: string
}

function pending(overrides: Partial<PendingPermissionInfo> = {}): PendingPermissionInfo {
  return {
    driverId: 'pi',
    session: {
      sessionId: 'session-1',
      projectId: 'project-1',
      threadId: 'thread-1',
      projectPath: '/project',
      driverId: 'pi',
      permissionLevel: 'auto_review'
    },
    request: {
      id: 'request-1',
      sessionId: 'session-1',
      permission: 'write',
      patterns: ['/project/.env'],
      metadata: {},
      policy: { risk: 'critical', reason: 'Protected file', scopedPaths: [] }
    },
    policy: {
      decision: 'ask',
      approved: false,
      reason: 'Protected file',
      risk: 'critical',
      scope: { projectRoot: '/project', paths: [] },
      approval: { required: true },
      ledger: {
        permission: 'write',
        risk: 'critical',
        decision: 'ask',
        reason: 'Protected file',
        scope: { projectRoot: '/project', paths: [] }
      }
    },
    resumeStatus: 'executing',
    ...overrides
  } as PendingPermissionInfo
}

function makeUnit(options: { userActive: boolean }) {
  const pendingPermissions = new Map<string, PendingPermissionInfo>()
  const autoAnswers: AutoAnswerRecord[] = []
  const host = {
    state: { pendingPermissions },
    storage: { getConfig: async () => ({ questionTimeoutMs: QUESTION_TIMEOUT_MS }) },
    units: {
      turns: { isUserActive: () => options.userActive },
      misc: { reportAutoAnswer: (record: AutoAnswerRecord) => autoAnswers.push(record) }
    },
    threadManager: { setStatus: async () => undefined },
    broadcast: () => undefined
  }
  const unit = new ChatEnginePermissions(host as never)
  const settled: Array<{ reply: string; decidedBy: string; alternative?: string }> = []
  // The settle path reaches the harness through a driver; this test is about the
  // deadline that decides to call it, so it stands in for the delivery.
  ;(
    unit as unknown as {
      settlePermissionReply: (
        entry: PendingPermissionInfo,
        reply: string,
        decidedBy: string,
        alternative?: string
      ) => Promise<void>
    }
  ).settlePermissionReply = async (entry, reply, decidedBy, alternative) => {
    settled.push({ reply, decidedBy, alternative })
    pendingPermissions.delete(entry.request.id)
  }
  return { unit, pendingPermissions, autoAnswers, settled }
}

describe('permission card deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the countdown on the shared card timeout and refuses at the deadline', async () => {
    const { unit, pendingPermissions, autoAnswers, settled } = makeUnit({ userActive: false })
    const entry = pending()
    pendingPermissions.set(entry.request.id, entry)

    await unit.schedulePermissionTimeout(entry)
    expect(entry.expiresAt).toBe(Date.now() + QUESTION_TIMEOUT_MS)
    expect(entry.request.policy?.expiresAt).toBe(entry.expiresAt)

    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS - 1)
    expect(settled).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.reply).toBe('reject')
    expect(settled[0]?.decidedBy).toBe('policy:timeout')
    expect(settled[0]?.alternative).toContain('automatically rejected')
    expect(autoAnswers).toMatchObject([
      { kind: 'permission', outcome: 'expired', threadId: 'thread-1' }
    ])
  })

  it('holds the countdown while the user is active and never expires under them', async () => {
    const { unit, pendingPermissions, settled } = makeUnit({ userActive: true })
    const entry = pending()
    pendingPermissions.set(entry.request.id, entry)

    await unit.schedulePermissionTimeout(entry)
    expect(entry.expiresAt).toBeUndefined()

    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS * 3)
    expect(settled).toHaveLength(0)
  })

  it('does nothing once the card has been answered', async () => {
    const { unit, pendingPermissions, settled } = makeUnit({ userActive: false })
    const entry = pending()
    pendingPermissions.set(entry.request.id, entry)

    await unit.schedulePermissionTimeout(entry)
    pendingPermissions.delete(entry.request.id)
    await vi.advanceTimersByTimeAsync(QUESTION_TIMEOUT_MS)
    expect(settled).toHaveLength(0)
  })
})
