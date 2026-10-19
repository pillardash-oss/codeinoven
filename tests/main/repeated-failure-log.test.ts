import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/main/system/logger'
import {
  clearRepeatedFailure,
  reportRepeatedFailure
} from '../../src/main/system/repeated-failure-log'

/**
 * The policy a polled condition reports under: one durable error per incident,
 * dev-level repeats, one escalation per interval for a condition that never
 * clears, and one informational line when it is over.
 *
 * Each case uses its own label: incidents are process-wide by label, exactly as
 * the production callers rely on when several of them watch the same condition.
 */
let errorSpy: ReturnType<typeof vi.spyOn>
let devSpy: ReturnType<typeof vi.spyOn>
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {})
  devSpy = vi.spyOn(Logger, 'dev').mockImplementation(() => {})
  infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reportRepeatedFailure', () => {
  it('reports the first failure at error level and the repeats at dev level', () => {
    const label = 'poll test: first then repeats'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      reportRepeatedFailure(label, new Error('the service is unreachable'))
    }

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe(label)
    expect(devSpy).toHaveBeenCalledTimes(3)
    expect(String(devSpy.mock.calls[0]?.[0])).toContain('repeat 1')
    expect(String(devSpy.mock.calls[2]?.[0])).toContain('repeat 3')
  })

  it('keeps one incident per label', () => {
    reportRepeatedFailure('poll test: label one', new Error('first fault'))
    reportRepeatedFailure('poll test: label two', new Error('second fault'))
    reportRepeatedFailure('poll test: label one', new Error('first fault'))
    reportRepeatedFailure('poll test: label two', new Error('second fault'))

    // Two labels means two incidents, so two errors and one dev repeat each.
    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(devSpy).toHaveBeenCalledTimes(2)
  })

  it('treats a changed cause under one label as a new incident', () => {
    const label = 'poll test: changed cause'
    reportRepeatedFailure(label, new Error('offline'))
    reportRepeatedFailure(label, new Error('offline'))
    reportRepeatedFailure(label, new Error('certificate expired'))

    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(String(errorSpy.mock.calls[1]?.[1])).toContain('certificate expired')
    expect(devSpy).toHaveBeenCalledTimes(1)
  })

  it('escalates a condition that never clears once per interval', () => {
    const label = 'poll test: escalation'
    for (let attempt = 0; attempt < 4; attempt += 1) {
      reportRepeatedFailure(label, new Error('still down'), { reEscalateAfterMs: 0 })
    }

    expect(errorSpy).toHaveBeenCalledTimes(4)
    expect(String(errorSpy.mock.calls[1]?.[0])).toContain('still failing')
    expect(devSpy).not.toHaveBeenCalled()
  })

  it('closes an incident with one informational line, then reports the next failure at error level', () => {
    const label = 'poll test: recovery'
    reportRepeatedFailure(label, new Error('breaking'))
    reportRepeatedFailure(label, new Error('breaking'))

    clearRepeatedFailure(label)

    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(String(infoSpy.mock.calls[0]?.[0])).toBe(`${label} recovered`)
    expect(infoSpy.mock.calls[0]?.[1]).toMatchObject({ failures: 2 })

    reportRepeatedFailure(label, new Error('breaking again'))
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })

  it('says nothing when a condition that never failed succeeds', () => {
    clearRepeatedFailure('poll test: never failed')

    expect(infoSpy).not.toHaveBeenCalled()
  })
})
