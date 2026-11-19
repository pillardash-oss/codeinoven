import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IdleSignalParking,
  PARKED_IDLE_RECHECKS_MS,
  type ParkedIdle
} from '../../src/main/chat/chat-engine/chat-engine-turns-idle-parking'

const SESSION = 'session-1'
const IDLE: ParkedIdle = {
  sessionId: SESSION,
  event: { type: 'session.idle', sessionId: SESSION },
  driverId: 'pi'
}

interface Harness {
  parking: IdleSignalParking
  settle: ReturnType<typeof vi.fn>
  held: { value: boolean }
  busy: { value: boolean }
  /** Let the pending probe answer. */
  flush: () => Promise<void>
}

function makeHarness(): Harness {
  const settle = vi.fn()
  const held = { value: true }
  const busy = { value: false }
  const parking = new IdleSignalParking({
    driverHoldsTurn: () => held.value,
    harnessBusy: async () => busy.value,
    settle
  })
  return {
    parking,
    settle,
    held,
    busy,
    // The re-check is async: resolve its probe before the next assertion.
    flush: async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    }
  }
}

describe('IdleSignalParking   an idle the driver still holds', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds the signal while the driver still registers the turn', async () => {
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).not.toHaveBeenCalled()
    expect(harness.parking.has(SESSION)).toBe(true)
  })

  it('settles once the driver releases the turn, without waiting for a second idle', async () => {
    // The live defect: the release and the idle crossed, so the only idle this
    // turn ever produced had already arrived and been parked.
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)
    harness.held.value = false

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).toHaveBeenCalledTimes(1)
    expect(harness.settle).toHaveBeenCalledWith(IDLE)
    expect(harness.parking.has(SESSION)).toBe(false)
  })

  it('settles a disposed harness that has no registration and is not busy', async () => {
    // A disposed harness cannot resume the turn: it has no registration, and a
    // probe that throws counts as not busy, exactly like a dead process.
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)
    harness.held.value = false
    harness.busy.value = false

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).toHaveBeenCalledTimes(1)
  })

  it('waits through a compaction gap that released the registration', async () => {
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)
    harness.held.value = false
    harness.busy.value = true

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).not.toHaveBeenCalled()
    expect(harness.parking.has(SESSION)).toBe(true)
  })

  it('drops the signal when the turn shows any other life', async () => {
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)
    harness.parking.cancel(SESSION)
    harness.held.value = false

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).not.toHaveBeenCalled()
    expect(harness.parking.has(SESSION)).toBe(false)
  })

  it('never settles the same turn twice when a later idle is honoured', async () => {
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)
    // The honoured idle path cancels the parked copy before finalizing.
    harness.parking.cancel(SESSION)
    harness.held.value = false

    await vi.advanceTimersByTimeAsync(PARKED_IDLE_RECHECKS_MS[0] ?? 0)
    await harness.flush()

    expect(harness.settle).not.toHaveBeenCalled()
  })

  it('gives up on a registration that is never released', async () => {
    const harness = makeHarness()
    harness.parking.park(SESSION, IDLE)

    for (const delay of PARKED_IDLE_RECHECKS_MS) await vi.advanceTimersByTimeAsync(delay)
    await harness.flush()
    await vi.advanceTimersByTimeAsync(60_000)
    await harness.flush()

    expect(harness.settle).not.toHaveBeenCalled()
    expect(harness.parking.has(SESSION)).toBe(false)
  })
})
