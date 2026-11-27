import { describe, expect, it } from 'vitest'
import { assignmentDelegationRole } from '$shared/types'

/**
 * The coordinator panel and the conversation's working trace both ask
 * `delegatedWorkBusy` "is this plan producing work right now?". It answered for
 * the coordinator's own row only, so an audit thread — the surface the user
 * opens to watch the audit — reported no work while its auditor was busy, and
 * its trace read as a settled conversation until the window was reloaded.
 */
describe('assignmentDelegationRole', () => {
  const plan = { coordinatorThreadId: 'coordinator', auditorThreadId: 'auditor' }

  it('answers for the coordinator that owns the plan', () => {
    expect(assignmentDelegationRole(plan, 'coordinator')).toBe('coordinator')
  })

  it('answers for the Assignment auditor', () => {
    expect(assignmentDelegationRole(plan, 'auditor')).toBe('auditor')
  })

  it('never answers for a worker, which owns only its own turn', () => {
    expect(assignmentDelegationRole(plan, 'worker-1')).toBeNull()
  })

  it('answers for the coordinator before any auditor exists', () => {
    expect(assignmentDelegationRole({ coordinatorThreadId: 'coordinator' }, 'coordinator')).toBe(
      'coordinator'
    )
  })

  it('answers for nothing without a plan, or with no thread id', () => {
    expect(assignmentDelegationRole(null, 'coordinator')).toBeNull()
    expect(assignmentDelegationRole(undefined, 'coordinator')).toBeNull()
    expect(assignmentDelegationRole(plan, '')).toBeNull()
  })
})
