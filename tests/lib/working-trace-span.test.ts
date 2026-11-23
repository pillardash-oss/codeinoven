import { describe, expect, it } from 'vitest'
import { traceEndInstant } from '../../src/lib/working-trace-span'

describe('traceEndInstant', () => {
  it('ends a settled turn at its close, not at the last step it wrote', () => {
    // A run that answered in four minutes, then went quiet for forty before it
    // wrote anything again: the rows only reach 17:57:35, the turn closed later.
    const span = { start: 17 * 3_600_000, end: 17 * 3_600_000 + 293_000 }

    expect(traceEndInstant({ span, closedAt: span.start + 2_627_000 })).toBe(span.start + 2_627_000)
  })

  it('falls back to the span when no close was reported', () => {
    const span = { start: 1_000, end: 5_000 }

    expect(traceEndInstant({ span })).toBe(5_000)
  })

  it('never lets a close shorten the rows underneath it', () => {
    const span = { start: 1_000, end: 9_000 }

    expect(traceEndInstant({ span, closedAt: 7_000 })).toBe(9_000)
  })

  it('uses the caller boundary for a trace with no span to measure', () => {
    expect(traceEndInstant({ span: null, endTime: 4_200 })).toBe(4_200)
  })

  it('still prefers a close over the boundary when there is no span', () => {
    expect(traceEndInstant({ span: null, closedAt: 4_000, endTime: 4_200 })).toBe(4_000)
  })

  it('reports nothing when the caller knows neither', () => {
    expect(traceEndInstant({ span: null })).toBeUndefined()
  })
})
