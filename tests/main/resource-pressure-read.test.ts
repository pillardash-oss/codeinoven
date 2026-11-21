import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdmissionDecision } from '../../src/lib/resource-admission'
import {
  IDLE_DISARM_MS,
  PRIME_WINDOW_MS,
  ResourcePressureSampler,
  type CpuSnapshot,
  type DeviceReadings
} from '../../src/main/system/resource-pressure'

// The dev-probe presets live behind `app.isPackaged`, so a packaged app reads the
// real device. That is the behaviour these tests drive.
vi.mock('electron', () => ({ app: { isPackaged: true } }))

const GIGABYTE = 1024 ** 3
const TOTAL_MEMORY_BYTES = 32 * GIGABYTE
/** Well above the 0.5 GB floor of a machine this size, so memory never decides. */
const AVAILABLE_MEMORY_BYTES = 6 * GIGABYTE

/**
 * A machine the test moves by hand.
 *
 * `cpu()` hands out the snapshots in order and then repeats the one that is last
 * at the time of the call, so time only advances where the test pushes a newer
 * snapshot: a read that arrives with nothing elapsed measures a zero delta
 * instead of inventing CPU use.
 */
function scriptedMachine(snapshots: CpuSnapshot[]): DeviceReadings {
  let read = 0
  return {
    cpu: () => {
      const snapshot = snapshots[Math.min(read, snapshots.length - 1)]
      read += 1
      return snapshot ?? { idle: 0, total: 0 }
    },
    memoryAvailableBytes: () => Promise.resolve(AVAILABLE_MEMORY_BYTES),
    totalMemoryBytes: () => TOTAL_MEMORY_BYTES
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

  it('answers the very first read without waiting for the prime', async () => {
    const sampler = new ResourcePressureSampler(
      scriptedMachine([
        { idle: 0, total: 0 },
        { idle: 90, total: 100 }
      ])
    )

    const decision = await readWithoutTimers(sampler)

    // No snapshot behind the first read: nothing is known to be idle, which the
    // policy turns into offload rather than a hold. The real memory reading
    // travels with it.
    expect(decision).not.toBe('pending')
    if (decision === 'pending') return
    expect(decision.cpuAvailablePercent).toBe(0)
    expect(decision.action).toBe('offload')
    expect(decision.memoryAvailableBytes).toBe(AVAILABLE_MEMORY_BYTES)
    expect(decision.totalMemoryBytes).toBe(TOTAL_MEMORY_BYTES)
  })

  it('answers a read after the idle disconnect from the retained window, without the prime', async () => {
    const snapshots: CpuSnapshot[] = [
      { idle: 0, total: 0 },
      { idle: 80, total: 100 }
    ]
    const sampler = new ResourcePressureSampler(scriptedMachine(snapshots))

    expect((await sampler.read()).cpuAvailablePercent).toBe(0)
    // The background prime lands: 80 of 100 ticks idle, so the window is [80].
    await vi.advanceTimersByTimeAsync(PRIME_WINDOW_MS)
    // Nobody reads for the idle window, so the loop stops. No time passes in the
    // scripted machine here, so the window keeps its one reading.
    await vi.advanceTimersByTimeAsync(IDLE_DISARM_MS)
    expect(vi.getTimerCount()).toBe(0)
    // 90 of the 100 ticks since the last sample were idle, across the gap.
    snapshots.push({ idle: 170, total: 200 })

    const decision = await readWithoutTimers(sampler)

    // The gap delta went into the retained window and the average of both is the
    // answer: a sampler that had dropped the window would answer 90, one that had
    // dropped the snapshot as well would answer 0 and offload.
    expect(decision).not.toBe('pending')
    if (decision === 'pending') return
    expect(decision.cpuAvailablePercent).toBe(85)
    expect(decision.action).toBe('proceed')
  })
})
