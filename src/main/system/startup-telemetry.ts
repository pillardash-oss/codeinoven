/// <reference types="node" />

import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { Logger } from './logger'

/**
 * Privacy-preserving startup telemetry.
 *
 * Records the elapsed time of each named startup phase (process entry, Electron
 * ready, splash, storage/database ready, window creation, renderer document
 * load, visual readiness, hydration, workspace readiness, provider warmup) and samples the Electron main
 * event-loop delay during the boot window. Only phase names and millisecond
 * durations are ever emitted   never paths, project names, usernames, or
 * message content   so the data is safe to keep in durable logs and
 * diagnostics.
 */
export type StartupPhase =
  | 'nativeSplash:active'
  | 'process:entry'
  | 'electron:ready'
  | 'splash:created'
  | 'splash:visualReady'
  | 'storage:ready'
  | 'database:ready'
  | 'window:created'
  | 'renderer:documentLoaded'
  | 'window:visualReady'
  | 'renderer:hydrated'
  | 'features:ready'
  | 'workspace:ready'
  | 'provider:warmup'

export interface StartupPhaseRecord {
  phase: StartupPhase
  /** Milliseconds elapsed since process entry. */
  atMs: number
  /** Milliseconds elapsed since the previous recorded phase. */
  deltaMs: number
}

/**
 * One named stretch of startup work whose own duration is recorded.
 *
 * Phase marks answer "when did the boot reach X". A gap between two marks is
 * often several things running at once (storage, database and the platform
 * probe warm up concurrently), so a flat phase delta can never say which of
 * them owned the gap. A step is the missing half: it is timed from its own
 * start, so concurrent work reports concurrent numbers.
 */
export type StartupStep =
  | 'splash:barrier'
  | 'storage:directories'
  | 'storage:migrations'
  | 'storage:config'
  | 'database:init'
  | 'trafficLight:warm'

export interface StartupStepRecord {
  step: StartupStep
  /** Milliseconds after process entry when the step started. */
  startedAtMs: number
  durationMs: number
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
  /** Timed work inside the phases, including work that ran concurrently. */
  steps: StartupStepRecord[]
  eventLoop: EventLoopDelaySnapshot
}

/** `monitorEventLoopDelay` histograms report in nanoseconds. */
const NANOSECONDS_PER_MILLISECOND = 1e6

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function histogramMilliseconds(value: number): number {
  return round(value / NANOSECONDS_PER_MILLISECOND)
}

export class StartupTelemetry {
  private readonly origin: number
  private readonly now: () => number
  private readonly marked = new Set<StartupPhase>()
  private phases: StartupPhaseRecord[] = []
  private steps: StartupStepRecord[] = []
  private previousAt: number
  // Derived from the API rather than naming the histogram interface directly:
  // @types/node renamed it (IntervalHistogram -> ELDHistogram), and a rename
  // must not be able to break the type check again.
  private loopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now())
    this.origin = this.now()
    // Phase timestamps are relative to origin, so the first delta is simply the
    // first phase's elapsed time. Previous-relative deltas start at zero.
    this.previousAt = 0
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

  /**
   * Record a named startup phase with its elapsed time. Each phase is recorded
   * at most once: repeated marks (e.g. renderer signals its readiness more than
   * once) are ignored, so `process:entry` and `provider:warmup` are guaranteed
   * to appear exactly once in the final report.
   */
  mark(phase: StartupPhase): void {
    if (this.marked.has(phase)) return
    this.marked.add(phase)
    const atMs = this.now() - this.origin
    const deltaMs = Math.max(0, atMs - this.previousAt)
    this.phases.push({ phase, atMs, deltaMs })
    this.previousAt = atMs
  }

  /** Whether the given phase has already been recorded. */
  hasMarked(phase: StartupPhase): boolean {
    return this.marked.has(phase)
  }

  /**
   * Time one named step and return the closure that reports its duration.
   *
   * Call the returned function from a `finally` so a step that throws is still
   * measured: the boot has to keep going, and a step that failed halfway is
   * exactly the one whose duration explains the delay. Calling it twice records
   * once, because a `finally` and a success path must never double-count.
   */
  beginStep(step: StartupStep): () => void {
    const startedAt = this.now()
    let recorded = false
    return () => {
      if (recorded) return
      recorded = true
      this.steps.push({
        step,
        startedAtMs: startedAt - this.origin,
        durationMs: this.now() - startedAt
      })
    }
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
          meanMs: histogramMilliseconds(histogram.mean),
          p50Ms: histogramMilliseconds(histogram.percentile(50)),
          p95Ms: histogramMilliseconds(histogram.percentile(95)),
          p99Ms: histogramMilliseconds(histogram.percentile(99)),
          maxMs: histogramMilliseconds(histogram.max),
          samples
        }
      : { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, samples: 0 }
    return { phases: [...this.phases], steps: [...this.steps], eventLoop }
  }

  /**
   * Emit the recorded phases and event-loop statistics to the durable log.
   * Privacy-preserving by construction: only phase names and numeric
   * durations leave the process.
   */
  report(label = 'startup'): void {
    const { phases, steps, eventLoop } = this.snapshot()
    Logger.info(`${label} phases`, {
      phases: phases.map((record) => ({
        phase: record.phase,
        atMs: round(record.atMs),
        deltaMs: round(record.deltaMs)
      })),
      // Slowest first: the reader of a slow boot wants the top of this list, and
      // a concurrent warm-up reports several steps inside one phase gap.
      steps: [...steps]
        .sort((left, right) => right.durationMs - left.durationMs)
        .map((record) => ({
          step: record.step,
          startedAtMs: round(record.startedAtMs),
          durationMs: round(record.durationMs)
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
    this.marked.clear()
    this.phases = []
    this.steps = []
    this.previousAt = 0
  }
}

export const startupTelemetry = new StartupTelemetry()
