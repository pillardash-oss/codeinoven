/**
 * Device admission policy for new agent work.
 *
 * One question, three answers. Enough device means the work starts now, a busy
 * CPU means the device is in use but a second process would not help it, and a
 * machine short on both CPU and memory means the work waits instead of making
 * the machine worse.
 *
 * The numbers are the user's, not a guess: 5% CPU available, a 0.5 GB memory
 * floor on a machine with 16 GB or more, and 10% of total RAM below that. The
 * policy is pure and shared so main and the renderer can never disagree about a
 * threshold, and main stays the only place that makes the call.
 *
 * Where one Pi session runs, on the other hand, is not this policy's question:
 * see {@link hostIsSaturated}, which reads the host's own CPU instead.
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

export type AdmissionReason = 'enough' | 'cpu-short' | 'cpu-and-memory-short' | 'memory-short'

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
 * What a held message is waiting on: this machine, or one named Oven.
 *
 * The card says which machine the wait belongs to, so an Oven hold reads as an
 * Oven hold instead of as this device being busy.
 */
export type ResourceWaitTarget = { kind: 'device' } | { kind: 'oven'; ovenId: string; name: string }

/** One thread's gate answer: the reading that holds it, and whose machine. */
export interface ThreadResourceGateAnswer {
  wait: AdmissionDecision | null
  target: ResourceWaitTarget
}

/**
 * One Oven's reading, shaped for {@link decideOvenAdmission}.
 *
 * `memoryAvailableBytes` is null when the Oven's service revision predates the
 * field or its sampler could not answer. `activeRuns` is the number of harness
 * runs the Oven service reports as running, which every revision answers.
 */
export interface OvenResourceSample {
  memoryAvailableBytes: number | null
  totalMemoryBytes: number
  activeRuns: number
}

/** Memory one Oven run is assumed to cost, for the run-cap fallback. */
export const OVEN_RUN_ASSUMED_BYTES = 8 * 1024 ** 3
/** Never fewer than one concurrent run on a small Oven. */
export const OVEN_RUN_CAP_MIN = 1
/** Never more than this many concurrent runs on one Oven, however large. */
export const OVEN_RUN_CAP_MAX = 12

/**
 * How many concurrent runs an Oven's memory plausibly supports.
 *
 * The cap is a fallback for services that predate the live memory reading: it
 * bounds the Oven by its own total memory, so a queued message waits on a
 * machine the current runs already fill rather than on a number pulled from
 * nowhere. A live reading always outranks it.
 */
export function ovenRunCapacity(totalMemoryBytes: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return OVEN_RUN_CAP_MIN
  return Math.min(
    OVEN_RUN_CAP_MAX,
    Math.max(OVEN_RUN_CAP_MIN, Math.floor(totalMemoryBytes / OVEN_RUN_ASSUMED_BYTES))
  )
}

/**
 * Decide whether one Oven has room for a new run.
 *
 * The Oven's own memory is the whole question: the machine running the app is
 * not the one about to receive the work, so its CPU is irrelevant. A queue
 * holds the message when the Oven reports less available memory than its floor,
 * or when its running count has already reached what its total memory supports
 * and the service cannot report a live reading (a live reading outranks the
 * run count, because runs vary widely in what they actually hold).
 */
export function decideOvenAdmission(
  sample: OvenResourceSample,
  sampledAt = Date.now()
): AdmissionDecision {
  const totalMemoryBytes = Number.isFinite(sample.totalMemoryBytes)
    ? Math.max(0, sample.totalMemoryBytes)
    : 0
  const floor = memoryFloorBytes(totalMemoryBytes)
  const memoryAvailableBytes =
    sample.memoryAvailableBytes === null || !Number.isFinite(sample.memoryAvailableBytes)
      ? null
      : Math.max(0, sample.memoryAvailableBytes)
  const activeRuns = Number.isFinite(sample.activeRuns) ? Math.max(0, sample.activeRuns) : 0

  if (memoryAvailableBytes !== null && memoryAvailableBytes < floor) {
    return {
      action: 'queue',
      reason: 'memory-short',
      cpuAvailablePercent: 100,
      memoryAvailableBytes,
      memoryFloorBytes: floor,
      totalMemoryBytes,
      sampledAt
    }
  }
  if (memoryAvailableBytes === null && activeRuns >= ovenRunCapacity(totalMemoryBytes)) {
    return {
      action: 'queue',
      reason: 'memory-short',
      cpuAvailablePercent: 100,
      memoryAvailableBytes: 0,
      memoryFloorBytes: floor,
      totalMemoryBytes,
      sampledAt
    }
  }
  return {
    action: 'proceed',
    reason: 'enough',
    cpuAvailablePercent: 100,
    memoryAvailableBytes: memoryAvailableBytes ?? 0,
    memoryFloorBytes: floor,
    totalMemoryBytes,
    sampledAt
  }
}

/**
 * Decide whether new work starts now, or waits.
 *
 * The two shortages are deliberately asymmetric: a busy CPU alone never queues
 * work, it only reports `offload`, because a queue would not free any CPU and
 * the user would lose the turn for nothing. A queue only protects the machine
 * when memory is short too, which is the case where another process would make
 * things worse.
 *
 * `offload` is a statement about the device, and no longer about where a Pi
 * session goes: a second process cannot free another program's CPU. Placement
 * between hosts is decided by the host's own CPU, in {@link hostIsSaturated}.
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

/**
 * Host placement: one process's own CPU, never the machine's.
 *
 * A hosted Pi session is a Node process that spends almost all of its life
 * waiting on a provider, so its own CPU use sits near one percent. What a second
 * host can actually relieve is that process's event loop, which only matters
 * when the host is spending a whole core on its sessions. The device's CPU is a
 * different question with a different answer: offloading a session because some
 * other program is busy moves no work off that program and only adds another
 * process to the machine.
 *
 * The numbers below are percentages of one core, which is how
 * `app.getAppMetrics()` reports `percentCPUUsage`, so `100` is a process using
 * one core solid.
 */

/** A host at or above this much of one core is saturated: a second host helps. */
export const HOST_SATURATION_PERCENT = 95

/**
 * The load a borrowed host's sessions are handed back to the primary at.
 *
 * Deliberately far below the saturation gate: draining at 94% would hand the
 * sessions home, saturate the primary again, and open a host again on the next
 * turn. A host has to be comfortably unloaded before its sessions travel.
 */
export const HOST_REJOIN_PERCENT = 60

/**
 * Whether a host's own CPU use says a second process would take work off it.
 *
 * A reading that never arrived is not saturation: nothing is known to be busy,
 * and an unknown reading must never cost the user another process.
 */
export function hostIsSaturated(cpuPercent: number | null): boolean {
  if (cpuPercent === null || !Number.isFinite(cpuPercent)) return false
  return cpuPercent >= HOST_SATURATION_PERCENT
}

/**
 * Whether a host is unloaded enough to take a borrowed session back.
 *
 * An unread host counts as having room, because one host is the arrangement the
 * app is always trying to return to.
 */
export function hostHasRoom(cpuPercent: number | null): boolean {
  if (cpuPercent === null || !Number.isFinite(cpuPercent)) return true
  return cpuPercent < HOST_REJOIN_PERCENT
}
