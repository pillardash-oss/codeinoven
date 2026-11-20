import { describe, expect, it } from 'vitest'
import {
  INDEPENDENT_AUDIT_STOPPED_MESSAGE,
  auditStopAppliesToRun
} from '../../src/lib/audit/audit-stop-request'

describe('independent audit stop request', () => {
  it('cancels the run that was already going when the user pressed Stop', () => {
    expect(auditStopAppliesToRun(1_000, 1_000)).toBe(true)
    expect(auditStopAppliesToRun(1_500, 1_000)).toBe(true)
  })

  it('never cancels a run that started after an older request', () => {
    expect(auditStopAppliesToRun(999, 1_000)).toBe(false)
  })

  it('does nothing when no stop was requested', () => {
    expect(auditStopAppliesToRun(undefined, 1_000)).toBe(false)
  })

  it('carries a message the renderer can tell apart from a failure', () => {
    expect(INDEPENDENT_AUDIT_STOPPED_MESSAGE).toMatch(/stopped/iu)
  })
})
