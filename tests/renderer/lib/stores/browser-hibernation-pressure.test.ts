import { describe, expect, it } from 'vitest'
import {
  PRESSURE_HIBERNATION_WINDOW_MS,
  effectiveHibernationWindowMs
} from '$lib/stores/browser-hibernation-pressure'

/**
 * A parked browser page keeps producing frames, which is what makes it
 * capturable for an agent and what makes it cost a share of a core while nobody
 * is looking at it. Electron's `setFrameRate` does not throttle a view parked in
 * a shown window (measured), so the idle sweep is the only lever: these are the
 * rules for how much of the user's window survives on a machine that is short.
 */
describe('effectiveHibernationWindowMs', () => {
  it('uses the configured window exactly while the machine has room', () => {
    expect(effectiveHibernationWindowMs(30 * 60_000, false)).toBe(30 * 60_000)
    expect(effectiveHibernationWindowMs(5 * 60_000, false)).toBe(5 * 60_000)
  })

  it('shortens to the pressure window when the device reports itself short', () => {
    expect(effectiveHibernationWindowMs(30 * 60_000, true)).toBe(PRESSURE_HIBERNATION_WINDOW_MS)
    expect(effectiveHibernationWindowMs(120 * 60_000, true)).toBe(PRESSURE_HIBERNATION_WINDOW_MS)
  })

  it('never lengthens a window the user chose to be shorter than the pressure one', () => {
    const shorterThanPressure = 60_000
    expect(effectiveHibernationWindowMs(shorterThanPressure, true)).toBe(shorterThanPressure)
  })

  it('never returns a nonsense window for a nonsense setting', () => {
    expect(effectiveHibernationWindowMs(Number.NaN, false)).toBe(0)
    expect(effectiveHibernationWindowMs(-5, false)).toBe(0)
  })
})
