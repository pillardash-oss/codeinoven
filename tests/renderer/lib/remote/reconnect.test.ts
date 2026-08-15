import { describe, expect, it } from 'vitest'
import {
  ReconnectController,
  canTakeover,
  nextBackoffDelay,
  type Scheduler
} from '../../../../src/renderer/lib/remote/reconnect'

class FakeScheduler implements Scheduler {
  tasks: Array<{ callback: () => void; delayMs: number }> = []

  schedule(callback: () => void, delayMs: number): { cancel(): void } {
    this.tasks.push({ callback, delayMs })
    return {
      cancel: () => undefined
    }
  }

  runNext(): void {
    const task = this.tasks.shift()
    if (task) task.callback()
  }

  get firstDelay(): number | null {
    return this.tasks[0]?.delayMs ?? null
  }

  get pending(): number {
    return this.tasks.length
  }
}

describe('nextBackoffDelay', () => {
  it('grows exponentially from the initial delay', () => {
    const options = { initialDelayMs: 100, maxDelayMs: 10_000, factor: 3 }
    expect(nextBackoffDelay(1, options)).toBe(100)
    expect(nextBackoffDelay(2, options)).toBe(300)
    expect(nextBackoffDelay(3, options)).toBe(900)
  })

  it('caps the delay at the maximum', () => {
    const options = { initialDelayMs: 100, maxDelayMs: 1_000, factor: 10 }
    expect(nextBackoffDelay(3, options)).toBe(1_000)
  })
})

describe('ReconnectController', () => {
  it('schedules attempts with growing delays and gives up at the limit', () => {
    const scheduler = new FakeScheduler()
    const attempts: number[] = []
    let giveUp = 0

    const controller = new ReconnectController({
      backoff: { initialDelayMs: 100, maxDelayMs: 1_000, factor: 3, maxAttempts: 3 },
      onAttempt: (attempt) => attempts.push(attempt),
      onGiveUp: () => {
        giveUp += 1
      },
      scheduler
    })

    controller.start()
    expect(attempts).toEqual([1])
    expect(scheduler.firstDelay).toBe(100)

    scheduler.runNext()
    expect(attempts).toEqual([1, 2])
    expect(scheduler.firstDelay).toBe(300)

    scheduler.runNext()
    expect(attempts).toEqual([1, 2, 3])
    expect(scheduler.firstDelay).toBe(900)

    scheduler.runNext()
    expect(giveUp).toBe(1)
    expect(controller.isActive).toBe(false)
  })

  it('stops the loop and prevents further attempts', () => {
    const scheduler = new FakeScheduler()
    const attempts: number[] = []

    const controller = new ReconnectController({
      backoff: { initialDelayMs: 50, maxDelayMs: 500, factor: 2 },
      onAttempt: (attempt) => attempts.push(attempt),
      onGiveUp: () => undefined,
      scheduler
    })

    controller.start()
    controller.stop()
    expect(controller.isActive).toBe(false)

    scheduler.runNext()
    expect(attempts).toEqual([1])
  })

  it('resets the backoff after a successful connection', () => {
    const scheduler = new FakeScheduler()
    const attempts: number[] = []

    const controller = new ReconnectController({
      backoff: { initialDelayMs: 50, maxDelayMs: 500, factor: 2 },
      onAttempt: (attempt) => attempts.push(attempt),
      onGiveUp: () => undefined,
      scheduler
    })

    controller.start()
    expect(controller.attemptCount).toBe(1)
    controller.reset()
    expect(controller.attemptCount).toBe(0)
    expect(controller.isActive).toBe(false)

    // A stale scheduled task must not fire further attempts after reset.
    scheduler.runNext()
    expect(attempts).toEqual([1])
    expect(scheduler.pending).toBe(0)
  })
})

describe('canTakeover', () => {
  it('rejects takeover while another peer is live', () => {
    expect(canTakeover({ live: true, peerId: 'peer-a' }, 'peer-b')).toEqual({
      allowed: false,
      reason: 'another-peer-live'
    })
  })

  it('allows the owning peer to resume a live (stale) session', () => {
    expect(canTakeover({ live: true, peerId: 'peer-a' }, 'peer-a')).toEqual({ allowed: true })
  })

  it('allows takeover when nothing is live', () => {
    expect(canTakeover({ live: false, peerId: null }, 'peer-b')).toEqual({ allowed: true })
  })

  it('refuses when a session is live but its owner is unknown', () => {
    expect(canTakeover({ live: true, peerId: null }, 'peer-b')).toEqual({
      allowed: false,
      reason: 'another-peer-live'
    })
  })
})
