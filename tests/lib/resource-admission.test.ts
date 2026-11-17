import { describe, expect, it } from 'vitest'
import {
  CPU_AVAILABLE_FLOOR_PERCENT,
  LARGE_MACHINE_MEMORY_FLOOR_BYTES,
  LARGE_MACHINE_TOTAL_BYTES,
  SMALL_MACHINE_MEMORY_FLOOR_RATIO,
  decideAdmission,
  holdsAdmission,
  memoryFloorBytes,
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
