import { describe, expect, it } from 'vitest'
import { coordinatorHasActiveDelegates, type Thread } from '../../src/lib/types'
import { delegatesWorking } from '../../src/renderer/lib/thread-delegate-activity'

/**
 * The indexed rule answers exactly what the scan answers.
 *
 * `delegatesWorking` replaced a per-row scan of the scope's thread list with one
 * pass over it, because every row of every sidebar asks the question on every
 * render. Same question, same answer: this test holds the index to the reference
 * implementation over randomized thread trees, so an optimization can never
 * quietly change which rows read as working.
 */

function thread(id: string, extra: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'project1',
    providerId: 'pi',
    title: id,
    titleSource: 'manual',
    status: 'completed',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/project',
    ...extra
  }
}

/** A small deterministic generator, so a failure is reproducible by seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items]
  let state = seed
  for (let index = copy.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648
    const swap = state % (index + 1)
    const held = copy[index]
    copy[index] = copy[swap]
    copy[swap] = held
  }
  return copy
}

describe('delegatesWorking', () => {
  it('agrees with the reference scan on a coordinator with a working worker', () => {
    const threads = [
      thread('coordinator', { assignmentRole: 'coordinator', assignmentId: 'a1' }),
      thread('worker', { assignmentRole: 'worker', assignmentId: 'a1', status: 'executing' }),
      thread('other', {})
    ]
    const coordinator = threads[0]
    expect(delegatesWorking(coordinator, threads)).toBe(true)
    expect(delegatesWorking(coordinator, threads)).toBe(
      coordinatorHasActiveDelegates(coordinator, threads)
    )
  })

  it('agrees with the reference scan on a settled coordinator', () => {
    const threads = [
      thread('coordinator', { assignmentRole: 'coordinator', assignmentId: 'a1' }),
      thread('worker', { assignmentRole: 'worker', assignmentId: 'a1', status: 'completed' })
    ]
    expect(delegatesWorking(threads[0], threads)).toBe(false)
    expect(delegatesWorking(threads[0], threads)).toBe(
      coordinatorHasActiveDelegates(threads[0], threads)
    )
  })

  it('agrees with the reference scan on a pawn, an auditor and an audit parent', () => {
    const pawns = [
      thread('owner'),
      thread('pawn', { coordinatorThreadId: 'owner', userInputLocked: true, status: 'executing' })
    ]
    expect(delegatesWorking(pawns[0], pawns)).toBe(true)
    expect(delegatesWorking(pawns[0], pawns)).toBe(coordinatorHasActiveDelegates(pawns[0], pawns))

    const audits = [
      thread('parent', { independentAudit: true, auditorThreadId: 'auditor' }),
      thread('auditor', { achievementRole: 'auditor', status: 'executing' })
    ]
    expect(delegatesWorking(audits[0], audits)).toBe(true)
    expect(delegatesWorking(audits[0], audits)).toBe(
      coordinatorHasActiveDelegates(audits[0], audits)
    )

    const running = [
      thread('parent', { independentAudit: true, auditState: 'running' }),
      thread('x')
    ]
    expect(delegatesWorking(running[0], running)).toBe(true)
    expect(delegatesWorking(running[0], running)).toBe(
      coordinatorHasActiveDelegates(running[0], running)
    )
  })

  it('agrees with the reference scan over randomized trees', () => {
    const statuses: Thread['status'][] = [
      'completed',
      'executing',
      'awaiting_approval',
      'failed',
      'spec',
      'working-paused'
    ]
    for (let seed = 1; seed <= 120; seed++) {
      const size = 2 + (seed % 7)
      const threads: Thread[] = []
      for (let index = 0; index < size; index++) {
        const extra: Partial<Thread> = {
          status: statuses[(seed * (index + 3)) % statuses.length],
          assignmentRole: undefined,
          achievementRole: undefined,
          coordinatorThreadId: undefined,
          assignmentId: undefined,
          userInputLocked: false,
          independentAudit: undefined,
          auditorThreadId: undefined,
          auditState: undefined
        }
        const roll = (seed * 31 + index * 17) % 11
        if (roll === 0) {
          extra.assignmentRole = 'coordinator'
          extra.assignmentId = `a${(seed + index) % 4}`
        } else if (roll === 1) {
          extra.assignmentRole = 'worker'
          extra.assignmentId = `a${(seed + index) % 4}`
        } else if (roll === 2) {
          extra.achievementRole = 'auditor'
        } else if (roll === 3) {
          extra.coordinatorThreadId = `t${(seed + index) % size}`
          extra.userInputLocked = true
        } else if (roll === 4) {
          extra.coordinatorThreadId = `t${(seed * 3 + index) % size}`
        } else if (roll === 5) {
          extra.independentAudit = true
          extra.auditorThreadId = `t${(seed * 5 + index) % size}`
          extra.auditState = seed % 2 === 0 ? 'running' : 'report_ready'
        }
        threads.push(thread(`t${index}`, extra))
      }
      const list = shuffled(threads, seed)
      for (const candidate of list) {
        expect(delegatesWorking(candidate, list)).toBe(
          coordinatorHasActiveDelegates(candidate, list)
        )
      }
    }
  })
})
