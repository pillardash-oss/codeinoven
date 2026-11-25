import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdmissionDecision } from '../../src/lib/resource-admission'
import {
  IDLE_DISARM_MS,
  PRIME_WINDOW_MS,
  ResourcePressureSampler,
  type DeviceReadings
} from '../../src/main/system/resource-pressure'

// The dev-probe presets live behind `app.isPackaged`, so a packaged app reads the
// real device. That is the behaviour these tests drive.
vi.mock('electron', () => ({ app: { isPackaged: true } }))

const GIGABYTE = 1024 ** 3
const TOTAL_MEMORY_BYTES = 32 * GIGABYTE
/** Well above the 0.5 GB floor of a machine this size, so memory never decides. */
const AVAILABLE_MEMORY_BYTES = 6 * GIGABYTE
/** Seconds of one-second readings the sampler has to watch before it believes a shortage. */
const SUSTAINED_SECONDS = 10

/**
 * A machine the test drives by the second.
 *
 * Every `cpu()` call advances one second of ticks and hands back the snapshot,
 * so whatever idle share the test sets is exactly what that reading measured.
 * Time is the test's, not the wall clock's: nothing here depends on how fast the
 * runner is.
 */
function scriptedMachine(initialIdleShare: number): {
  readings: DeviceReadings
  setIdleShare: (share: number) => void
} {
  let idle = 0
  let total = 0
  let share = initialIdleShare
  return {
    readings: {
      cpu: () => {
        total += 100
        idle += share * 100
        return { idle, total }
      },
      memoryAvailableBytes: () => Promise.resolve(AVAILABLE_MEMORY_BYTES),
      totalMemoryBytes: () => TOTAL_MEMORY_BYTES
    },
    setIdleShare: (next) => {
      share = next
    }
  }
}

/**
 * One read, with no timer allowed to run: `pending` means it waited for the
 * prime window instead of answering from what the sampler already held.
 */
async function readWithoutTimers(
  sampler: ResourcePressureSampler
): Promise<AdmissionDecision | 'pending'> {
  let settled = false
  const reading = (async () => {
    const decision = await sampler.read()
    settled = true
    return decision
  })()
  for (let turn = 0; turn < 8 && !settled; turn += 1) await Promise.resolve()
  return settled ? await reading : 'pending'
}

describe('resource pressure reads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * A cold sampler knows nothing, and "nothing is known" is not "the machine is
   * short". Reporting it as a shortage was how a burst, or the first read after a
   * launch, moved work and held messages on a machine with room.
   */
  it('answers a cold read with room rather than a shortage', async () => {
    const { readings } = scriptedMachine(0.9)
    const sampler = new ResourcePressureSampler(readings)

    const decision = await readWithoutTimers(sampler)

    expect(decision).not.toBe('pending')
    if (decision === 'pending') return
    expect(decision.cpuAvailablePercent).toBe(100)
    expect(decision.action).toBe('proceed')
    // The real memory reading travels with it: only the CPU is unknown.
    expect(decision.memoryAvailableBytes).toBe(AVAILABLE_MEMORY_BYTES)
    expect(decision.totalMemoryBytes).toBe(TOTAL_MEMORY_BYTES)
  })

  it('calls a machine short only after it has stayed short', async () => {
    const { readings } = scriptedMachine(0.01)
    const sampler = new ResourcePressureSampler(readings)

    expect((await sampler.read()).action).toBe('proceed')
    // Two busy seconds are a burst, not a machine that cannot take work.
    await vi.advanceTimersByTimeAsync(PRIME_WINDOW_MS + 2_000)
    expect((await sampler.read()).action).toBe('proceed')

    await vi.advanceTimersByTimeAsync(SUSTAINED_SECONDS * 1_000)
    const decision = await sampler.read()
    expect(decision.cpuAvailablePercent).toBeCloseTo(1)
    expect(decision.action).toBe('offload')
  })

  it('does not believe a burst inside an otherwise idle window', async () => {
    const { readings, setIdleShare } = scriptedMachine(0.9)
    const sampler = new ResourcePressureSampler(readings)
    await sampler.read()

    setIdleShare(0.01)
    await vi.advanceTimersByTimeAsync(PRIME_WINDOW_MS + 3_000)
    setIdleShare(0.95)
    await vi.advanceTimersByTimeAsync(9_000)

    const decision = await sampler.read()
    // Three busy seconds out of thirteen cannot hold a message.
    expect(decision.action).toBe('proceed')
    expect(decision.cpuAvailablePercent).toBeGreaterThan(50)
  })

  /**
   * A window describes the stretch of activity it was filled in, and nothing
   * else. Keeping it across the idle pause let a busy minute from before the
   * pause outvote the machine as it actually is afterwards.
   */
  it('forgets the window it filled once it stops watching', async () => {
    const { readings, setIdleShare } = scriptedMachine(0.01)
    const sampler = new ResourcePressureSampler(readings)
    await sampler.read()
    // A full window of a pegged machine, then nobody asks for thirty seconds.
    await vi.advanceTimersByTimeAsync(PRIME_WINDOW_MS + 15_000)
    await vi.advanceTimersByTimeAsync(IDLE_DISARM_MS)
    expect(vi.getTimerCount()).toBe(0)

    setIdleShare(0.95)
    const decision = await sampler.read()

    // The dropped window cannot outvote the present: the read answers from the
    // delta across the pause, which is one reading, so the CPU is unknown and
    // unknown is room.
    expect(decision.cpuAvailablePercent).toBe(100)
    expect(decision.action).toBe('proceed')
  })
})
