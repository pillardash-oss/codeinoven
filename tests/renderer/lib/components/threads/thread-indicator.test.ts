import { describe, expect, it } from 'vitest'
import { threadHydratesEngineeringState } from '../../../../../src/renderer/lib/components/threads/thread-indicator'

describe('threadHydratesEngineeringState', () => {
  it('hydrates an ordinary thread that engaged the Engineering lifecycle', () => {
    expect(threadHydratesEngineeringState({ engineering: true })).toBe(true)
  })

  it('hydrates the independent audit that shares the same tooling', () => {
    expect(threadHydratesEngineeringState({ independentAudit: true })).toBe(true)
    expect(threadHydratesEngineeringState({ independentAuditInitialized: true })).toBe(true)
  })

  it('hydrates a thread that still carries audit state from either audit path', () => {
    // The independent audit runs on a thread that is not an Engineering thread,
    // so its own flags plus the durable audit gate and auditor pointer are what
    // keep it hydrated.
    expect(threadHydratesEngineeringState({ auditState: 'report_ready' })).toBe(true)
    expect(threadHydratesEngineeringState({ auditState: 'running' })).toBe(true)
    expect(threadHydratesEngineeringState({ auditorThreadId: 'auditor-1' })).toBe(true)
  })

  it('hydrates orchestration children, which never set the marker themselves', () => {
    expect(threadHydratesEngineeringState({ coordinatorThreadId: 'coordinator-1' })).toBe(true)
    expect(threadHydratesEngineeringState({ assignmentId: 'assignment-1' })).toBe(true)
    expect(threadHydratesEngineeringState({ assignmentRole: 'worker' })).toBe(true)
    expect(threadHydratesEngineeringState({ achievementRole: 'auditor' })).toBe(true)
  })

  it('leaves an ordinary conversation alone', () => {
    // Regression: the gate used to be "not a chat thread", so every plain
    // conversation loaded lifecycle, Spec, Brainstorm, PRD, Assignment and audit
    // state on mount and on every turn boundary, for state that cannot exist on
    // it.
    expect(threadHydratesEngineeringState({})).toBe(false)
    expect(threadHydratesEngineeringState({ auditState: undefined })).toBe(false)
    expect(threadHydratesEngineeringState({ auditorThreadId: undefined })).toBe(false)
  })

  it('does not hydrate an Achievement coordinator twice as a child', () => {
    expect(threadHydratesEngineeringState({ achievementRole: 'coordinator' })).toBe(false)
    expect(threadHydratesEngineeringState({ assignmentRole: 'coordinator' })).toBe(false)
  })
})
