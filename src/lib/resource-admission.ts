/**
 * Device admission policy for new agent work.
 *
 * One question, three answers. Enough device means the work starts now, a busy
 * CPU means it starts anyway on a process of its own so it is not queued behind
 * whatever is pinning the CPU, and a machine short on both CPU and memory means
 * the work waits instead of making the machine worse.
 *
 * The numbers are the user's, not a guess: 5% CPU available, a 0.5 GB memory
 * floor on a machine with 16 GB or more, and 10% of total RAM below that. The
 * policy is pure and shared so main and the renderer can never disagree about a
 * threshold, and main stays the only place that makes the call.
 */

/** Percent of total CPU that has to be idle for new work to be considered safe. */
export const CPU_AVAILABLE_FLOOR_PERCENT = 5

/** A machine this large or larger uses the absolute memory floor. */
export const LARGE_MACHINE_TOTAL_BYTES = 16 * 1024 ** 3

/** The absolute memory floor on a large machine. */
export const LARGE_MACHINE_MEMORY_FLOOR_BYTES = 500 * 1024 ** 2

/** The memory floor as a share of total RAM on a smaller machine. */
export const SMALL_MACHINE_MEMORY_FLOOR_RATIO = 0.1

/** What a device reading says about starting more work. */
export interface ResourceSample {
  /** Idle share of total CPU across the sampling window, 0 to 100. */
  cpuAvailablePercent: number
  /** Bytes the machine can give new work without swapping. */
  memoryAvailableBytes: number
  /** Total physical memory, so the floor can scale with the machine. */
  totalMemoryBytes: number
}

/**
 * The memory floor for a machine, which is the number the policy compares
 * against. An unreadable total falls back to the absolute floor: waiting for
 * half a gigabyte is the safe answer when we cannot see how big the machine is.
 */
export function memoryFloorBytes(totalMemoryBytes: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return LARGE_MACHINE_MEMORY_FLOOR_BYTES
  }
  return totalMemoryBytes >= LARGE_MACHINE_TOTAL_BYTES
    ? LARGE_MACHINE_MEMORY_FLOOR_BYTES
    : Math.round(totalMemoryBytes * SMALL_MACHINE_MEMORY_FLOOR_RATIO)
}

/**
 * `proceed` starts the work here, `offload` starts it on a process of its own
 * because the CPU is busy, and `queue` holds it because the machine is short on
 * both. Only the last one is visible to the user as a waiting message.
 */
export type AdmissionAction = 'proceed' | 'offload' | 'queue'

/**
 * Whether a reading holds new work back.
 *
 * Every gate asks this one predicate instead of comparing the action itself, so
 * the dispatcher, the mounted thread and the composer cannot drift apart on what
 * "the device is short" means.
 */
export function holdsAdmission(decision: AdmissionDecision): boolean {
  return decision.action === 'queue'
}

export type AdmissionReason = 'enough' | 'cpu-short' | 'cpu-and-memory-short'

export interface AdmissionDecision {
  action: AdmissionAction
  reason: AdmissionReason
  cpuAvailablePercent: number
  memoryAvailableBytes: number
  memoryFloorBytes: number
  totalMemoryBytes: number
  /** When the reading was taken, so a stale answer is visible as stale. */
  sampledAt: number
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/**
 * Decide whether new work starts now, starts on another process, or waits.
 *
 * The two shortages are deliberately asymmetric: a busy CPU alone never queues
 * work, it moves it, because a queue would not free any CPU and the user would
 * lose the turn for nothing. A queue only protects the machine when memory is
 * short too, which is the case where another process would make things worse.
 */
export function decideAdmission(sample: ResourceSample, sampledAt = Date.now()): AdmissionDecision {
  const cpuAvailablePercent = clampPercent(sample.cpuAvailablePercent)
  const memoryAvailableBytes = Number.isFinite(sample.memoryAvailableBytes)
    ? Math.max(0, sample.memoryAvailableBytes)
    : 0
  const totalMemoryBytes = Number.isFinite(sample.totalMemoryBytes)
    ? Math.max(0, sample.totalMemoryBytes)
    : 0
  const floor = memoryFloorBytes(totalMemoryBytes)
  const cpuShort = cpuAvailablePercent < CPU_AVAILABLE_FLOOR_PERCENT
  const memoryShort = memoryAvailableBytes < floor

  if (cpuShort && memoryShort) {
    return {
      action: 'queue',
      reason: 'cpu-and-memory-short',
      cpuAvailablePercent,
      memoryAvailableBytes,
      memoryFloorBytes: floor,
      totalMemoryBytes,
      sampledAt
    }
  }

  return {
    action: cpuShort ? 'offload' : 'proceed',
    reason: cpuShort ? 'cpu-short' : 'enough',
    cpuAvailablePercent,
    memoryAvailableBytes,
    memoryFloorBytes: floor,
    totalMemoryBytes,
    sampledAt
  }
}
