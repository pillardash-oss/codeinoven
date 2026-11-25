/**
 * Per-host CPU, sampled on a short rolling window.
 *
 * `app.getAppMetrics()` answers "CPU used since the last call", so one read taken
 * whenever a session happens to be created measures however long it has been
 * since the previous read, which is no reading of now at all. A host's
 * saturation gate needs its own steady cadence, and this is it: one cheap
 * metrics read a second, kept per host pid in a small window, and armed only
 * while it has an answer to give.
 *
 * The window is short on purpose. `percentCPUUsage` from a single second is
 * noisy, and a three second average is the smallest span that still describes
 * "now" rather than "the last minute". Nothing here is a device reading: a host
 * is judged by what it spends, never by what the rest of the machine is doing.
 */
import { app } from 'electron'
import { Logger } from '../system/logger'

/** How often a running sampler reads the process metrics. */
export const HOST_CPU_SAMPLE_INTERVAL_MS = 1_000

/** How many readings one host's average spans: three seconds. */
export const HOST_CPU_WINDOW_SAMPLES = 3

/** One process row, as much of `app.getAppMetrics()` as this needs. */
export interface HostCpuMetric {
  pid: number
  cpu: { percentCPUUsage: number }
}

/** Where the process rows come from, injected so a test can script a host. */
export type HostCpuMetricsReader = () => ReadonlyArray<HostCpuMetric>

function readAppMetrics(): ReadonlyArray<HostCpuMetric> {
  // A module imported outside Electron (a unit test) has no process metrics to
  // read, and a sampler with no source is a sampler that answers nothing rather
  // than one that throws on a placement decision.
  const source = (app as { getAppMetrics?: () => ReadonlyArray<HostCpuMetric> } | undefined)
    ?.getAppMetrics
  if (typeof source !== 'function') return []
  try {
    return source.call(app)
  } catch (error) {
    // Losing a reading costs a placement decision, never the session.
    Logger.dev('Host CPU sample failed', error)
    return []
  }
}

export class HostCpuSampler {
  readonly #read: HostCpuMetricsReader
  /** Recent readings per host pid. Pruned to the pids the machine still lists. */
  readonly #window = new Map<number, number[]>()
  #timer: NodeJS.Timeout | null = null

  constructor(read: HostCpuMetricsReader = readAppMetrics) {
    this.#read = read
  }

  /** Whether a window is being kept right now. */
  get sampling(): boolean {
    return this.#timer !== null
  }

  /**
   * Begin sampling, if it is not already sampling.
   *
   * Idempotent, and it takes the first reading immediately so the window starts
   * filling from the moment work exists rather than one interval later. That
   * first reading is Electron's warm-up and reports nothing, which is why a host
   * only has a confident answer once the window is full.
   */
  start(): void {
    if (this.#timer !== null) return
    this.#sample()
    this.#timer = setInterval(() => this.#sample(), HOST_CPU_SAMPLE_INTERVAL_MS)
    this.#timer.unref?.()
  }

  /** Stop sampling and forget the window: nothing is asking for it any more. */
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#window.clear()
  }

  /**
   * One host's average CPU over the window, as a percentage of one core.
   *
   * Null until the window is full, because a couple of seconds of a process that
   * just started is Electron's warm-up and not a reading of the host. Unknown is
   * the answer a caller must treat as "not saturated".
   */
  cpuPercent(pid: number): number | null {
    const values = this.#window.get(pid)
    if (values === undefined || values.length < HOST_CPU_WINDOW_SAMPLES) return null
    let sum = 0
    for (const value of values) sum += value
    return sum / values.length
  }

  /** Take one reading now and roll the window. */
  sample(): void {
    this.#sample()
  }

  #sample(): void {
    const metrics = this.#read()
    const seen = new Set<number>()
    for (const metric of metrics) {
      if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0) continue
      const percent = Number(metric.cpu?.percentCPUUsage)
      if (!Number.isFinite(percent)) continue
      seen.add(metric.pid)
      const values = this.#window.get(metric.pid) ?? []
      values.push(Math.max(0, percent))
      while (values.length > HOST_CPU_WINDOW_SAMPLES) values.shift()
      this.#window.set(metric.pid, values)
    }
    // A pid the machine no longer lists is a host that exited: its window would
    // otherwise answer for a process that is gone, and a later pid reuse would
    // inherit a stranger's CPU.
    for (const pid of [...this.#window.keys()]) {
      if (!seen.has(pid)) this.#window.delete(pid)
    }
  }
}
