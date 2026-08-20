import { describe, expect, it } from 'vitest'
import {
  decideModelSwitchCompaction,
  MODEL_SWITCH_COMPACT_THRESHOLD_RATIO
} from '../../src/lib/model-switch-compaction'

describe('decideModelSwitchCompaction', () => {
  it('compacts when native usage already fills 80% or more of the new model window', () => {
    expect(decideModelSwitchCompaction({ contextWindow: 128_000, contextUsed: 102_400 })).toEqual({
      shouldCompact: true,
      reason: expect.stringContaining('fills >=80%')
    })
    expect(decideModelSwitchCompaction({ contextWindow: 128_000, contextUsed: 200_000 })).toEqual({
      shouldCompact: true,
      reason: expect.stringContaining('fills >=80%')
    })
  })

  it('does not compact when the new model window is larger than the native usage', () => {
    expect(
      decideModelSwitchCompaction({ contextWindow: 128_000, contextUsed: 32_000 })
    ).toEqual({ shouldCompact: false })
  })

  it('does not compact when usage is just under the 80% threshold', () => {
    const threshold = Math.round(128_000 * MODEL_SWITCH_COMPACT_THRESHOLD_RATIO)
    expect(
      decideModelSwitchCompaction({ contextWindow: 128_000, contextUsed: threshold - 1 })
    ).toEqual({ shouldCompact: false })
  })

  it('never triggers a compaction when either signal is missing', () => {
    expect(decideModelSwitchCompaction({ contextUsed: 100_000 })).toEqual({
      shouldCompact: false
    })
    expect(decideModelSwitchCompaction({ contextWindow: 128_000 })).toEqual({
      shouldCompact: false
    })
    expect(decideModelSwitchCompaction({})).toEqual({ shouldCompact: false })
  })

  it('rejects non-finite and non-positive signals without compacting', () => {
    expect(
      decideModelSwitchCompaction({ contextWindow: Number.NaN, contextUsed: 100 })
    ).toEqual({ shouldCompact: false })
    expect(
      decideModelSwitchCompaction({ contextWindow: 128_000, contextUsed: -1 })
    ).toEqual({ shouldCompact: false })
    expect(
      decideModelSwitchCompaction({ contextWindow: 0, contextUsed: 100 })
    ).toEqual({ shouldCompact: false })
  })
})
