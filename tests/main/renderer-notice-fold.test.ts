import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { Logger } from '../../src/main/system/logger'
import {
  NOTICE_BURST_QUIET_MS,
  flushEngineNoticeBursts,
  logEngineNotice
} from '../../src/main/ipc/renderer-notice-fold'

/**
 * A layout loop emits one identical notice per frame, and one real burst wrote
 * 1,293 durable records in 34 seconds. The fold keeps the first line, counts the
 * rest, and states the total once the burst is over.
 */
const MESSAGE = 'ResizeObserver loop completed with undelivered notifications.'
let devSpy: MockInstance<typeof Logger.dev>

beforeEach(() => {
  vi.useFakeTimers()
  devSpy = vi.spyOn(Logger, 'dev').mockImplementation(() => {})
})

afterEach(() => {
  flushEngineNoticeBursts()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function lines(): string[] {
  return devSpy.mock.calls.map((call) => call.map(String).join(' '))
}

describe('logEngineNotice', () => {
  it('writes a lone notice once and closes it without a summary', () => {
    logEngineNotice('[renderer:error]', MESSAGE)
    vi.advanceTimersByTime(NOTICE_BURST_QUIET_MS)

    expect(lines()).toEqual([`[renderer:error] ${MESSAGE}`])
  })

  it('folds a burst into its first line and one count', () => {
    for (let index = 0; index < 1200; index += 1) {
      logEngineNotice('[renderer:error]', MESSAGE)
      vi.advanceTimersByTime(8)
    }
    expect(lines()).toHaveLength(1)

    vi.advanceTimersByTime(NOTICE_BURST_QUIET_MS)

    const written = lines()
    expect(written).toHaveLength(2)
    expect(written[0]).toBe(`[renderer:error] ${MESSAGE}`)
    expect(written[1]).toContain('1200 identical notices over')
    expect(written[1]).toContain('10s')
  })

  it('keeps two different notices apart, each with its own count', () => {
    logEngineNotice('[renderer:error]', MESSAGE)
    logEngineNotice('[renderer:error]', 'ResizeObserver loop limit exceeded')
    logEngineNotice('[renderer:error]', MESSAGE)
    vi.advanceTimersByTime(NOTICE_BURST_QUIET_MS)

    const written = lines()
    expect(written).toHaveLength(3)
    expect(
      written.filter((line) => line.includes(MESSAGE) && line.includes('2 identical'))
    ).toHaveLength(1)
    expect(written).toContain('[renderer:error] ResizeObserver loop limit exceeded')
  })

  it('reports the total immediately when the burst is flushed', () => {
    logEngineNotice('[renderer:error]', MESSAGE)
    logEngineNotice('[renderer:error]', MESSAGE)
    flushEngineNoticeBursts()

    expect(lines()[1]).toContain('2 identical notices over')
    // The burst is closed, so its timer cannot report the same count twice.
    vi.advanceTimersByTime(NOTICE_BURST_QUIET_MS)
    expect(lines()).toHaveLength(2)
  })
})
