import { describe, expect, it } from 'vitest'
import {
  MIN_CAPTURE_GAP_MS,
  PRESSURE_INTERVAL_MS,
  nextCaptureDelayMs
} from '../../../src/main/display/display-cadence'

/**
 * Real numbers from this workstation, taken from the app's own log while nine
 * threads ran: an iOS simulator screenshot started at 422 ms and degraded to
 * 1429, 2632, 3931 and 6987 ms as the machine filled up, while the capture loop
 * kept re-arming 250 ms later. These tests are the loop's behaviour on those
 * numbers.
 */
const IOS_TARGET_MS = 450

describe('nextCaptureDelayMs', () => {
  it('keeps a source that meets its target on its target cadence', () => {
    // A 300 ms capture of a 450 ms target: wait the remaining 150 ms, but never
    // less than the floor.
    expect(
      nextCaptureDelayMs({
        targetIntervalMs: IOS_TARGET_MS,
        captureMs: 300,
        elapsedMs: 300,
        deviceShort: false
      })
    ).toBe(MIN_CAPTURE_GAP_MS)
  })

  it('waits its own cost after a capture that outran its target', () => {
    // 6987 ms was measured. Before this rule the loop waited 250 ms and started
    // another seven-second capture, so the panel spent most of the wall clock
    // inside the simulator and starved everything else.
    const delay = nextCaptureDelayMs({
      targetIntervalMs: IOS_TARGET_MS,
      captureMs: 6987,
      elapsedMs: 6987,
      deviceShort: false
    })
    expect(delay).toBe(6987)
    // Cost plus gap is at least twice the cost: a slow source can never hold more
    // than half the wall clock.
    expect(6987 / (6987 + delay)).toBeLessThanOrEqual(0.5)
  })

  it('stretches the cadence while the device is short', () => {
    const busyMachine = nextCaptureDelayMs({
      targetIntervalMs: IOS_TARGET_MS,
      captureMs: 700,
      elapsedMs: 700,
      deviceShort: true
    })
    expect(busyMachine).toBe(PRESSURE_INTERVAL_MS - 700)
    // …and a source slower than even the pressure interval still settles at half
    // the wall clock rather than at the pressure interval.
    expect(
      nextCaptureDelayMs({
        targetIntervalMs: IOS_TARGET_MS,
        captureMs: 5000,
        elapsedMs: 5000,
        deviceShort: true
      })
    ).toBe(5000)
  })

  it('never returns less than the floor', () => {
    expect(
      nextCaptureDelayMs({
        targetIntervalMs: 100,
        captureMs: 10,
        elapsedMs: 500,
        deviceShort: false
      })
    ).toBe(MIN_CAPTURE_GAP_MS)
  })
})
