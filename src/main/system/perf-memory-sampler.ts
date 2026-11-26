import { app } from 'electron'
import { totalmem } from 'node:os'
import type { PerfProcessSample } from '../../lib/perf-trace'
import { Logger } from './logger'
import { perfTrace, readProcessMemory } from './perf-trace'

/**
 * One reading of every process the app is running, plus the machine it runs on.
 *
 * `app.getAppMetrics()` is the only source that names the actual cost of each
 * surface: the main process, the workspace window, every embedded browser tab,
 * the GPU process, the utilities. A single "app memory" number cannot answer the
 * question an investigation actually has — *which* process grew — and on this
 * app the answer is usually one renderer holding memory for surfaces it was
 * never meant to keep.
 */
export interface AppMemorySample {
  /** One row per OS process the app owns, in the order Electron reported them. */
  processes: PerfProcessSample[]
  /** Sum of every process working set, in bytes. */
  totalBytes: number
  /** Physical memory the machine has, in bytes, for judging that total. */
  deviceBytes: number | null
}

/** Electron reports `workingSetSize` in kibibytes; everything else here is bytes. */
const KIBIBYTES_IN_BYTES = 1024

/** One `app.getAppMetrics()` row, reduced to the fields a sample needs. */
interface AppMetricRow {
  pid: number
  type?: string
  cpu?: { percentCPUUsage?: number }
  memory?: { workingSetSize?: number }
}

/** Physical memory of this machine, or null where the OS will not say. */
export function deviceMemoryBytes(): number | null {
  try {
    const bytes = totalmem()
    return Number.isFinite(bytes) && bytes > 0 ? Math.trunc(bytes) : null
  } catch {
    return null
  }
}

/**
 * Read every process's working set and CPU share.
 *
 * Guarded end to end: this runs on a timer beside normal work, so a process that
 * exited between the read and the mapping must cost one missing row, never the
 * sample and never the app.
 */
export function readAppMemory(): AppMemorySample {
  const processes: PerfProcessSample[] = []
  let totalBytes = 0
  let rows: ReadonlyArray<AppMetricRow> = []
  try {
    rows = app.getAppMetrics() as ReadonlyArray<AppMetricRow>
  } catch (error) {
    Logger.dev('App metrics could not be read for the performance trace:', error)
  }
  for (const row of rows) {
    if (!row || typeof row.pid !== 'number' || row.pid <= 0) continue
    const workingSet = row.memory?.workingSetSize
    const memoryBytes =
      typeof workingSet === 'number' && Number.isFinite(workingSet) && workingSet > 0
        ? Math.trunc(workingSet) * KIBIBYTES_IN_BYTES
        : null
    if (memoryBytes !== null) totalBytes += memoryBytes
    const cpu = row.cpu?.percentCPUUsage
    processes.push({
      pid: row.pid,
      kind: typeof row.type === 'string' && row.type ? row.type : 'unknown',
      memoryBytes,
      cpuPercent: typeof cpu === 'number' && Number.isFinite(cpu) ? Math.round(cpu * 10) / 10 : null
    })
  }
  return { processes, totalBytes, deviceBytes: deviceMemoryBytes() }
}

/** The working set of one process, for joining a renderer's records to its cost. */
export function readProcessWorkingSet(pid: number): number | undefined {
  if (!Number.isFinite(pid) || pid <= 0) return undefined
  const sample = readAppMemory()
  return sample.processes.find((entry) => entry.pid === pid)?.memoryBytes ?? undefined
}

/** How often the whole-app sample is taken. */
const SAMPLE_INTERVAL_MS = 5_000

let samplerTimer: ReturnType<typeof setInterval> | null = null
let lastTotalBytes: number | null = null

/**
 * Take one whole-app sample and record it.
 *
 * Exposed so the same reading can be taken on demand — a renderer asking for the
 * current footprint, or a test asserting the shape — instead of only on the
 * timer's schedule.
 */
export function sampleAppMemory(): AppMemorySample {
  const sample = readAppMemory()
  const previous = lastTotalBytes
  lastTotalBytes = sample.totalBytes
  const own = readProcessMemory()
  perfTrace.record({
    id: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'memory',
    actor: 'main',
    name: 'app.memory',
    startedAt: Date.now(),
    durationMs: 0,
    outcome: 'ok',
    totalMemoryBytes: sample.totalBytes,
    processes: sample.processes,
    ...(own ? { memory: own } : {}),
    context: {
      deviceBytes: sample.deviceBytes ?? null,
      // The change since the previous sample is the number that makes a graph
      // readable: a flat total hides one renderer growing while another gives
      // memory back.
      deltaBytes: previous === null ? null : sample.totalBytes - previous,
      processCount: sample.processes.length
    }
  })
  return sample
}

/**
 * Start the periodic whole-app memory sample.
 *
 * One line every few seconds is what turns "the app feels slow" into "the app
 * gained 900 MB over four minutes, and it was this window". Idempotent: a second
 * call keeps the first timer.
 */
export function startPerfMemorySampling(intervalMs: number = SAMPLE_INTERVAL_MS): void {
  if (samplerTimer !== null) return
  samplerTimer = setInterval(() => {
    try {
      sampleAppMemory()
    } catch (error) {
      Logger.dev('Performance memory sample failed:', error)
    }
  }, intervalMs)
  samplerTimer.unref?.()
}

/** Stop the sampler. Used by the quit path and by tests. */
export function stopPerfMemorySampling(): void {
  if (samplerTimer === null) return
  clearInterval(samplerTimer)
  samplerTimer = null
}
