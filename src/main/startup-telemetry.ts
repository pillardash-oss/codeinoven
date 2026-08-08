import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import type { IntervalHistogram } from 'node:perf_hooks'
import { Logger } from './logger'

/**
 * Privacy-preserving startup telemetry.
 *
 * Records the elapsed time of each named startup phase (process entry, Electron
 * ready, splash, storage/database ready, window created, first paint, renderer
 * hydration, workspace ready, provider warmup) and samples the Electron main
 * event-loop delay during the boot window. Only phase names and millisecond
 * durations are ever emitted — never paths, project names, usernames, or
 * message content — so the data is safe to keep in durable logs and
 * diagnostics.
 */
export type StartupPhase =
  | 'process:entry'
  | 'electron:ready'
  | 'splash:created'
  | 'storage:ready'
  | 'database:ready'
  | 'window:created'
  | 'window:firstPaint'
  | 'renderer:hydrated'
  | 'workspace:ready'
  | 'provider:warmup'

export interface StartupPhaseRecord {
  phase: StartupPhase
  /** Milliseconds elapsed since process entry. */
  atMs: number
  /** Milliseconds elapsed since the previous recorded phase. */
  deltaMs: number
}

export interface EventLoopDelaySnapshot {
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  samples: number
}

export interface StartupTelemetrySnapshot {
  phases: StartupPhaseRecord[]
  eventLoop: EventLoopDelaySnapshot
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

export class StartupTelemetry {
  private readonly origin: number
  private readonly now: () => number
  private phases: StartupPhaseRecord[] = []
  private previousAt: number
  private loopHistogram: IntervalHistogram | null = null

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now())
    this.origin = this.now()
    this.previousAt = this.origin
  }

  /** Begin tracking event-loop delay for the rest of the boot window. */
  startEventLoopMonitor(): void {
    if (this.loopHistogram) return
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    this.loopHistogram = histogram
  }

  /** Stop recording event-loop delay. Safe to call more than once. */
  stopEventLoopMonitor(): void {
    this.loopHistogram?.disable()
  }

  /** Record a named startup phase with its elapsed time. */
  mark(phase: StartupPhase): void {
    const atMs = this.now() - this.origin
    const deltaMs = Math.max(0, atMs - this.previousAt)
    this.phases.push({ phase, atMs, deltaMs })
    this.previousAt = atMs
  }

  /** Ordered list of recorded phases, newest last. */
  get recordedPhases(): StartupPhaseRecord[] {
    return [...this.phases]
  }

  /** Current event-loop delay statistics over the monitored window. */
  snapshot(): StartupTelemetrySnapshot {
    const histogram = this.loopHistogram
    const samples = histogram ? histogram.count : 0
    const eventLoop: EventLoopDelaySnapshot = histogram
      ? {
          meanMs: round(histogram.mean),
          p50Ms: round(histogram.percentile(50)),
          p95Ms: round(histogram.percentile(95)),
          p99Ms: round(histogram.percentile(99)),
          maxMs: round(histogram.max),
          samples
        }
      : { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 }
    return { phases: [...this.phases], eventLoop }
  }

  /**
   * Emit the recorded phases and event-loop statistics to the durable log.
   * Privacy-preserving by construction: only phase names and numeric
   * durations leave the process.
   */
  report(label = 'startup'): void {
    const { phases, eventLoop } = this.snapshot()
    Logger.info(`${label} phases`, {
      phases: phases.map((record) => ({
        phase: record.phase,
        atMs: round(record.atMs),
        deltaMs: round(record.deltaMs)
      })),
      eventLoop: {
        meanMs: eventLoop.meanMs,
        p50Ms: eventLoop.p50Ms,
        p95Ms: eventLoop.p95Ms,
        p99Ms: eventLoop.p99Ms,
        maxMs: eventLoop.maxMs,
        samples: eventLoop.samples
      }
    })
  }

  /** Clear recorded phases and restart the clock (test convenience). */
  reset(): void {
    this.stopEventLoopMonitor()
    this.loopHistogram = null
    this.phases = []
    this.previousAt = this.origin
  }
}

export const startupTelemetry = new StartupTelemetry()
