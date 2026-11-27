import { describe, expect, it } from 'vitest'
import {
  HEAP_SNAPSHOT_COOLDOWN_MS,
  HEAP_SNAPSHOT_MAX_PER_SESSION,
  mayCaptureHeapSnapshot
} from '../../src/main/system/perf-heap-snapshot'

describe('heap snapshot budget', () => {
  it('allows the first capture', () => {
    expect(mayCaptureHeapSnapshot({ captures: 0, lastCaptureAt: null, now: 1_000 })).toBe(true)
  })

  it('refuses another capture inside the cooldown', () => {
    expect(
      mayCaptureHeapSnapshot({
        captures: 1,
        lastCaptureAt: 1_000,
        now: 1_000 + HEAP_SNAPSHOT_COOLDOWN_MS - 1
      })
    ).toBe(false)
  })

  it('allows another capture once the cooldown has passed', () => {
    expect(
      mayCaptureHeapSnapshot({
        captures: 1,
        lastCaptureAt: 1_000,
        now: 1_000 + HEAP_SNAPSHOT_COOLDOWN_MS
      })
    ).toBe(true)
  })

  it('stops for the session once the cap is reached, whatever the clock says', () => {
    expect(
      mayCaptureHeapSnapshot({
        captures: HEAP_SNAPSHOT_MAX_PER_SESSION,
        lastCaptureAt: 0,
        now: Number.MAX_SAFE_INTEGER
      })
    ).toBe(false)
  })
})
