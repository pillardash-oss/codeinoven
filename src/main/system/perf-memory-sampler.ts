import { app } from 'electron'
import { totalmem } from 'node:os'
import type { PerfProcessSample } from '../../lib/perf-trace'
import { Logger } from './logger'
import { heapSnapshots } from './perf-heap-snapshot'
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
export function startPerfMemorySampling(
  intervalMs: number = SAMPLE_INTERVAL_MS,
  /** Total app memory at or above which a heap snapshot is taken by itself.
   *  Omitted means the app never snapshots itself: a snapshot pauses the window
   *  it reads, so it is for a build that is being investigated, not for a user. */
  autoSnapshotAboveBytes?: number
): void {
  if (samplerTimer !== null) return
  samplerTimer = setInterval(() => {
    try {
      const sample = sampleAppMemory()
      if (
        autoSnapshotAboveBytes !== undefined &&
        sample.totalBytes >= autoSnapshotAboveBytes &&
        heapSnapshots.available
      ) {
        // The sampler is the one place that sees the app cross the threshold, so
        // it is where the snapshot is requested. Its own budget decides whether
        // this is the moment: a few per session, minutes apart.
        void heapSnapshots.capture('memory-threshold')
      }
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

/**
 * How late the main process's own timer woke up.
 *
 * The memory sampler proved main was alive during the renderer's longest stalls,
 * but a five-second cadence is far too coarse to see a two-second block. This
 * heartbeat is the fine-grained answer: a timer that should fire every second
 * and reports how late it actually did. A late tick means main's event loop was
 * occupied — a synchronous call, a flood of callbacks — and the record names the
 * lag, which is exactly the delay every IPC reply behind it pays.
 *
 * It exists because the two possibilities look identical from the renderer: "the
 * main process was busy" and "our message never reached it" both show up as one
 * slow call. This is the measurement that tells them apart.
 */
const LOOP_LAG_INTERVAL_MS = 1_000

/** Lag at or above this is worth a record; a healthy timer is a few milliseconds. */
const LOOP_LAG_REPORT_MS = 200

let lagTimer: ReturnType<typeof setInterval> | null = null

/** Start the main-process event-loop lag heartbeat. Idempotent. */
export function startMainLoopLagSampling(intervalMs: number = LOOP_LAG_INTERVAL_MS): void {
  if (lagTimer !== null) return
  let expected = Date.now() + intervalMs
  lagTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + intervalMs
    if (lag < LOOP_LAG_REPORT_MS) return
    perfTrace.record({
      id: `loop-lag-${now}`,
      kind: 'mark',
      actor: 'main',
      name: 'main.loop.lag',
      startedAt: now - lag,
      durationMs: lag,
      outcome: 'abandoned',
      context: { lagMs: lag }
    })
  }, intervalMs)
  lagTimer.unref?.()
}

/** Stop the lag heartbeat. Used by the quit path and by tests. */
export function stopMainLoopLagSampling(): void {
  if (lagTimer === null) return
  clearInterval(lagTimer)
  lagTimer = null
}
