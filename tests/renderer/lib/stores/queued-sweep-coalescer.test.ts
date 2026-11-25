import { describe, expect, it } from 'vitest'
import { SweepCoalescer } from '$lib/stores/queued-sweep-coalescer'

/** A scripted clock and scheduler, so a burst costs no real time. */
function harness(intervalMs = 250): {
  coalescer: SweepCoalescer
  runs: number[]
  advance: (ms: number) => void
  pending: () => number
} {
  let now = 1_000
  let nextHandle = 1
  const timers = new Map<number, { at: number; handler: () => void }>()
  const runs: number[] = []

  const coalescer = new SweepCoalescer({
    intervalMs,
    run: () => runs.push(now),
    now: () => now,
    setTimer: (handler, ms) => {
      const handle = nextHandle
      nextHandle += 1
      timers.set(handle, { at: now + ms, handler })
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number)
    }
  })

  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [handle, timer] = due
      timers.delete(handle)
      now = timer.at
      timer.handler()
    }
    now = target
  }

  return { coalescer, runs, advance, pending: () => timers.size }
}

describe('SweepCoalescer', () => {
  it('runs the first notice of a quiet spell immediately', () => {
    const { coalescer, runs } = harness()
    coalescer.request()
    expect(runs).toEqual([1_000])
  })

  it('collapses a burst into the leading run and one trailing run', () => {
    const { coalescer, runs, advance, pending } = harness()
    coalescer.request()
    expect(runs).toHaveLength(1)
    for (let index = 0; index < 20; index += 1) coalescer.request()
    // Everything after the first notice waits for the window to close.
    expect(runs).toHaveLength(1)
    expect(pending()).toBe(1)
    advance(250)
    expect(runs).toEqual([1_000, 1_250])
    expect(pending()).toBe(0)
  })

  it('runs at once again once the window has passed', () => {
    const { coalescer, runs, advance } = harness()
    coalescer.request()
    advance(300)
    coalescer.request()
    expect(runs).toEqual([1_000, 1_300])
  })

  it('does not fire a pending trailing run the caller dropped', () => {
    const { coalescer, runs, advance, pending } = harness()
    coalescer.request()
    coalescer.request()
    expect(pending()).toBe(1)
    coalescer.cancel()
    expect(pending()).toBe(0)
    advance(500)
    expect(runs).toEqual([1_000])
  })

  it('gives a notice that arrives inside the window the rest of it', () => {
    const { coalescer, runs, advance } = harness()
    coalescer.request()
    advance(100)
    coalescer.request()
    advance(149)
    expect(runs).toEqual([1_000])
    advance(1)
    expect(runs).toEqual([1_000, 1_250])
  })
})
