import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConnectivityService,
  probeDeviceConnectivity
} from '../../src/main/system/connectivity-service'

/**
 * Device connectivity is the gate every connection wait resumes on, so these
 * lock in the properties that promise depends on: an announcement never
 * decides the state, a real round trip does, a burst of announcements costs one
 * probe, an offline device keeps looking so a silent reconnection is found, and
 * a stopped service is silent.
 */
const dns = vi.hoisted(() => ({ resolve4: vi.fn<(host: string) => Promise<string[]>>() }))
vi.mock('node:dns/promises', () => dns)

interface Harness {
  service: ConnectivityService
  probe: ReturnType<typeof vi.fn<(timeoutMs: number) => Promise<boolean>>>
  clock: { now: number }
}

/** A service whose verdicts come from the supplied probe results, in order. */
function harness(results: boolean[]): Harness {
  const clock = { now: 1_000_000 }
  const probe = vi.fn(async () => results.shift() ?? false)
  const service = new ConnectivityService({ probe, now: () => clock.now })
  return { service, probe, clock }
}

/** Let a settled probe's continuations run under fake timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  dns.resolve4.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ConnectivityService', () => {
  it('verifies the link at startup instead of trusting a hint', async () => {
    const { service, probe } = harness([true])
    service.start()
    // Nothing is claimed before a round trip actually answered.
    expect(service.isOnline()).toBe(false)
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(service.isOnline()).toBe(true)
    expect(service.isOffline()).toBe(false)
  })

  it('coalesces a burst of announcements into one probe', async () => {
    const { service, probe } = harness([true, true])
    service.start()
    await settle()
    probe.mockClear()
    // The renderer's event, a wake from sleep and a second event from the same
    // moment all describe one instant; together they cost one round trip.
    service.signal('renderer online event')
    service.signal('device wake')
    service.signal('renderer online event')
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(service.isOnline()).toBe(true)
  })

  it('reports a restored link only on the transition, never on a repeat', async () => {
    const { service, probe, clock } = harness([true, true, false, true])
    const restored = vi.fn()
    service.onRestored(restored)
    service.start()
    await settle()
    expect(restored).toHaveBeenCalledTimes(1)

    clock.now += 5_000
    service.signal('renderer online event')
    await settle()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(restored).toHaveBeenCalledTimes(1)

    clock.now += 5_000
    service.signal('renderer offline event')
    await settle()
    expect(service.isOffline()).toBe(true)
    expect(restored).toHaveBeenCalledTimes(1)

    clock.now += 5_000
    service.signal('renderer online event')
    await settle()
    expect(restored).toHaveBeenCalledTimes(2)
  })

  it('keeps looking while offline so a reconnection nothing announced is found', async () => {
    const { service, probe } = harness([false, false, true])
    const restored = vi.fn()
    service.onRestored(restored)
    service.start()
    await settle()
    expect(service.isOffline()).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_400)
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(service.isOffline()).toBe(true)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(service.isOnline()).toBe(true)
    expect(restored).toHaveBeenCalledTimes(1)

    // Verified online: the background re-probe stops entirely.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('backs off so an offline device is watched without being hammered', async () => {
    const { service, probe } = harness([])
    service.start()
    await settle()
    expect(service.isOffline()).toBe(true)

    await vi.advanceTimersByTimeAsync(120_000)
    // Two minutes of watching: the first probes are quick, the rest settle onto
    // the ceiling, and none of it approaches a per-second question.
    expect(probe.mock.calls.length).toBeGreaterThan(3)
    expect(probe.mock.calls.length).toBeLessThan(12)
  })

  it('keeps the connection-loss window for failures the device explains', async () => {
    const { service, clock } = harness([false, true])
    service.start()
    await settle()
    expect(service.isOffline()).toBe(true)
    expect(service.wasOfflineWithin(30_000)).toBe(true)

    clock.now += 40_000
    expect(service.wasOfflineWithin(30_000)).toBe(false)
  })

  it('drops a verified link on a failed request until a probe confirms it again', async () => {
    const { service } = harness([true, false])
    service.start()
    await settle()
    expect(service.isOnline()).toBe(true)

    // The answer was wrong: nothing may run on it until the network answers again.
    service.invalidate('resume attempted offline')
    expect(service.isOnline()).toBe(false)
    expect(service.isOffline()).toBe(false)

    await settle()
    expect(service.isOffline()).toBe(true)
  })

  it('stops probing and listening once stopped', async () => {
    const { service, probe } = harness([false])
    const restored = vi.fn()
    service.onRestored(restored)
    service.start()
    await settle()
    expect(probe).toHaveBeenCalledTimes(1)
    service.stop()
    probe.mockClear()

    service.signal('renderer online event')
    service.invalidate('resume attempted offline')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(probe).not.toHaveBeenCalled()
    expect(restored).not.toHaveBeenCalled()
  })
})

describe('probeDeviceConnectivity', () => {
  it('answers online on an uncached DNS answer and leaves the transport alone', async () => {
    dns.resolve4.mockResolvedValue(['142.250.185.78'])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await probeDeviceConnectivity(4_000)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back to one TLS request when the resolver cannot answer', async () => {
    dns.resolve4.mockRejectedValue(new Error('EAI_AGAIN'))
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }))
    expect(await probeDeviceConnectivity(4_000)).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('answers offline when neither DNS nor the transport reaches anything', async () => {
    dns.resolve4.mockRejectedValue(new Error('ENOTFOUND'))
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'))
    expect(await probeDeviceConnectivity(4_000)).toBe(false)
  })
})
