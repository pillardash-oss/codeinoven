import { describe, expect, it, vi } from 'vitest'
import { DEADLINE_EXCEEDED, withDeadline } from '../../src/lib/with-deadline'

/** A promise a test decides when (or whether) to settle. */
function controllable<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('withDeadline', () => {
  it('answers with the work when it lands in time', async () => {
    await expect(withDeadline(Promise.resolve('done'), 50)).resolves.toBe('done')
  })

  it('answers DEADLINE_EXCEEDED when the work never settles', async () => {
    vi.useFakeTimers()
    try {
      const pending = withDeadline(new Promise<string>(() => undefined), 100)
      await vi.advanceTimersByTimeAsync(101)
      await expect(pending).resolves.toBe(DEADLINE_EXCEEDED)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a rejection visible instead of turning it into a timeout', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom')
  })

  it('does not surface a rejection that lands after the deadline', async () => {
    vi.useFakeTimers()
    try {
      const late = controllable<string>()
      const result = withDeadline(late.promise, 100)
      await vi.advanceTimersByTimeAsync(101)
      await expect(result).resolves.toBe(DEADLINE_EXCEEDED)
      // Settling late must not produce an unhandled rejection.
      late.resolve('too late')
      await vi.advanceTimersByTimeAsync(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a non-positive deadline as already expired', async () => {
    await expect(withDeadline(Promise.resolve('done'), 0)).resolves.toBe(DEADLINE_EXCEEDED)
  })
})
