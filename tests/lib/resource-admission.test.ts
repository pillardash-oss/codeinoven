import { describe, expect, it } from 'vitest'
import {
  CPU_AVAILABLE_FLOOR_PERCENT,
  LARGE_MACHINE_MEMORY_FLOOR_BYTES,
  LARGE_MACHINE_TOTAL_BYTES,
  OVEN_RUN_CAP_MAX,
  OVEN_RUN_CAP_MIN,
  SMALL_MACHINE_MEMORY_FLOOR_RATIO,
  decideAdmission,
  decideOvenAdmission,
  holdsAdmission,
  memoryFloorBytes,
  ovenRunCapacity,
  type OvenResourceSample,
  type ResourceSample
} from '../../src/lib/resource-admission'

const GB = 1024 ** 3

function sample(
  cpuAvailablePercent: number,
  memoryAvailableBytes: number,
  totalMemoryBytes: number
): ResourceSample {
  return { cpuAvailablePercent, memoryAvailableBytes, totalMemoryBytes }
}

describe('memoryFloorBytes', () => {
  it('uses the absolute floor on a large machine', () => {
    expect(memoryFloorBytes(32 * GB)).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
  })

  it('uses the absolute floor exactly at the 16 GB boundary', () => {
    expect(memoryFloorBytes(LARGE_MACHINE_TOTAL_BYTES)).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
  })

  it('scales with total RAM below the boundary', () => {
    expect(memoryFloorBytes(8 * GB)).toBe(Math.round(8 * GB * SMALL_MACHINE_MEMORY_FLOOR_RATIO))
    expect(memoryFloorBytes(8 * GB)).toBe(858993459)
  })

  it('takes the absolute floor when the total cannot be read', () => {
    expect(memoryFloorBytes(0)).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
    expect(memoryFloorBytes(Number.NaN)).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
    expect(memoryFloorBytes(-1)).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
  })
})

describe('decideAdmission', () => {
  it('queues only when CPU and memory are both short', () => {
    const decision = decideAdmission(sample(1, 0.2 * GB, 32 * GB), 1_700)
    expect(decision.action).toBe('queue')
    expect(decision.reason).toBe('cpu-and-memory-short')
    expect(decision.sampledAt).toBe(1_700)
  })

  it('offloads on a busy CPU with memory to spare', () => {
    const decision = decideAdmission(sample(1, 6 * GB, 32 * GB))
    expect(decision.action).toBe('offload')
    expect(decision.reason).toBe('cpu-short')
  })

  it('proceeds on an idle CPU', () => {
    const decision = decideAdmission(sample(50, 6 * GB, 32 * GB))
    expect(decision.action).toBe('proceed')
    expect(decision.reason).toBe('enough')
  })

  it('proceeds when only memory is short, because a queue would free no CPU', () => {
    const decision = decideAdmission(sample(50, 0, 32 * GB))
    expect(decision.action).toBe('proceed')
  })

  it('queues at a completely stalled machine', () => {
    expect(decideAdmission(sample(0, 0, LARGE_MACHINE_TOTAL_BYTES)).action).toBe('queue')
  })

  it('treats the CPU floor as available, not short', () => {
    const decision = decideAdmission(sample(CPU_AVAILABLE_FLOOR_PERCENT, 0, 32 * GB))
    expect(decision.action).toBe('proceed')
  })

  it('treats a memory reading exactly at the floor as enough', () => {
    const floor = LARGE_MACHINE_MEMORY_FLOOR_BYTES
    expect(decideAdmission(sample(1, floor, 32 * GB)).action).toBe('offload')
    expect(decideAdmission(sample(1, floor - 1, 32 * GB)).action).toBe('queue')
  })

  it('queues on a small machine at the proportional floor', () => {
    const floor = Math.round(8 * GB * SMALL_MACHINE_MEMORY_FLOOR_RATIO)
    expect(decideAdmission(sample(1, floor - 1, 8 * GB)).action).toBe('queue')
    expect(decideAdmission(sample(1, floor, 8 * GB)).action).toBe('offload')
  })

  it('clamps an impossible reading instead of trusting it', () => {
    const decision = decideAdmission(sample(-40, -1 * GB, 32 * GB))
    expect(decision.cpuAvailablePercent).toBe(0)
    expect(decision.memoryAvailableBytes).toBe(0)
    expect(decision.action).toBe('queue')
  })

  it('caps a CPU reading above 100', () => {
    expect(decideAdmission(sample(500, GB, 32 * GB)).cpuAvailablePercent).toBe(100)
  })

  it('treats an unreadable reading as zero rather than as room', () => {
    const decision = decideAdmission(sample(Number.NaN, Number.NaN, Number.NaN))
    expect(decision.cpuAvailablePercent).toBe(0)
    expect(decision.memoryAvailableBytes).toBe(0)
    expect(decision.totalMemoryBytes).toBe(0)
    expect(decision.memoryFloorBytes).toBe(LARGE_MACHINE_MEMORY_FLOOR_BYTES)
    expect(decision.action).toBe('queue')
  })

  it('reports the numbers it decided on', () => {
    const decision = decideAdmission(sample(3.4, 0.4 * GB, 8 * GB))
    expect(decision.cpuAvailablePercent).toBeCloseTo(3.4)
    expect(decision.memoryAvailableBytes).toBe(0.4 * GB)
    expect(decision.totalMemoryBytes).toBe(8 * GB)
    expect(decision.memoryFloorBytes).toBe(Math.round(8 * GB * SMALL_MACHINE_MEMORY_FLOOR_RATIO))
    expect(decision.action).toBe('queue')
  })

  it('is deterministic for the same reading', () => {
    const reading = sample(2, 0.3 * GB, 32 * GB)
    expect(decideAdmission(reading, 5)).toEqual(decideAdmission(reading, 5))
  })
})

describe('holdsAdmission', () => {
  it('holds only a queue decision', () => {
    expect(holdsAdmission(decideAdmission(sample(1, 0.2 * GB, 32 * GB)))).toBe(true)
    expect(holdsAdmission(decideAdmission(sample(1, 6 * GB, 32 * GB)))).toBe(false)
    expect(holdsAdmission(decideAdmission(sample(50, 6 * GB, 32 * GB)))).toBe(false)
  })

  it('agrees with the action on both boundaries', () => {
    for (const reading of [
      sample(CPU_AVAILABLE_FLOOR_PERCENT, LARGE_MACHINE_MEMORY_FLOOR_BYTES, 32 * GB),
      sample(CPU_AVAILABLE_FLOOR_PERCENT - 1, LARGE_MACHINE_MEMORY_FLOOR_BYTES - 1, 32 * GB),
      sample(0, 0, 8 * GB),
      sample(100, 16 * GB, 8 * GB)
    ]) {
      const decision = decideAdmission(reading)
      expect(holdsAdmission(decision)).toBe(decision.action === 'queue')
    }
  })

  it('holds a short machine regardless of its size', () => {
    expect(holdsAdmission(decideAdmission(sample(0, 0, 8 * GB)))).toBe(true)
    expect(holdsAdmission(decideAdmission(sample(0, 0, 64 * GB)))).toBe(true)
  })
})

describe('decideOvenAdmission', () => {
  const oven = (memory: number | null, total: number, runs: number): OvenResourceSample => ({
    memoryAvailableBytes: memory,
    totalMemoryBytes: total,
    activeRuns: runs
  })

  it('holds a turn when the Oven reports less than its floor', () => {
    const decision = decideOvenAdmission(oven(0.2 * GB, 32 * GB, 0))
    expect(decision.action).toBe('queue')
    expect(decision.reason).toBe('memory-short')
    expect(holdsAdmission(decision)).toBe(true)
  })

  it('proceeds when the Oven has room', () => {
    const decision = decideOvenAdmission(oven(6 * GB, 32 * GB, 4))
    expect(decision.action).toBe('proceed')
    expect(decision.reason).toBe('enough')
  })

  it('falls back to the run cap when the live reading is missing', () => {
    // 32 GB supports 4 assumed runs; the fifth holds the message.
    expect(decideOvenAdmission(oven(null, 32 * GB, 3)).action).toBe('proceed')
    expect(decideOvenAdmission(oven(null, 32 * GB, 4)).action).toBe('queue')
  })

  it('never lets a live reading be overridden by the run count', () => {
    // Plenty of memory with many runs running: the live number outranks the cap.
    expect(decideOvenAdmission(oven(20 * GB, 64 * GB, 16)).action).toBe('proceed')
  })

  it('fails open when nothing about the Oven can be read', () => {
    expect(decideOvenAdmission(oven(null, 0, 0)).action).toBe('proceed')
  })

  it('uses the shared floor, so a small Oven holds earlier than a large one', () => {
    // 0.55 GB clears the 32 GB floor (500 MB) but not the 8 GB floor (10%).
    expect(decideOvenAdmission(oven(0.55 * GB, 8 * GB, 0)).action).toBe('queue')
    expect(decideOvenAdmission(oven(0.55 * GB, 32 * GB, 0)).action).toBe('proceed')
  })
})

describe('ovenRunCapacity', () => {
  it('scales with the Oven total, one assumed run per 8 GB', () => {
    expect(ovenRunCapacity(8 * GB)).toBe(1)
    expect(ovenRunCapacity(32 * GB)).toBe(4)
    expect(ovenRunCapacity(64 * GB)).toBe(8)
  })

  it('stays inside its bounds', () => {
    expect(ovenRunCapacity(0)).toBe(OVEN_RUN_CAP_MIN)
    expect(ovenRunCapacity(1024 * GB)).toBe(OVEN_RUN_CAP_MAX)
  })
})
