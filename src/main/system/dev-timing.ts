import { performance } from 'node:perf_hooks'

/**
 * Dev-only step clock.
 *
 * A phase mark answers "when did this stage begin". That is enough to see that a
 * stage was slow and useless for saying why: a stage that awaits several
 * independent things (a process spawn, an extension rewrite, a settings
 * round-trip) reports one number for all of them. A step is timed from its own
 * start, so concurrent units report concurrent durations and a manual step covers
 * work that hands back a callback instead of a promise (a queue admission, a
 * subscription that has to be released).
 *
 * Nothing here writes on its own: the caller decides where the records go (the
 * turn dispatch line, the harness dispatch line, a startup snapshot), and every
 * read is a clock read, so measuring a path never changes it.
 */
export interface DevStepRecord {
  step: string
  /** Milliseconds after the clock's origin when the step began. */
  startedAtMs: number
  /** Milliseconds the step itself took. */
  ms: number
}

export class DevStepClock {
  private readonly origin: number
  private readonly steps: DevStepRecord[] = []

  constructor(origin: number = performance.now()) {
    this.origin = origin
  }

  /** Time one unit of work from its own start, even when it runs concurrently. */
  async step<T>(step: string, work: Promise<T>): Promise<T> {
    const finish = this.begin(step)
    try {
      return await work
    } finally {
      // `finally` so a rejected unit still reports the time it burned: the
      // failure path is exactly the one worth measuring.
      finish()
    }
  }

  /** Open a manual step and return its finisher. Calling twice is harmless. */
  begin(step: string): () => void {
    const startedAt = performance.now()
    let finished = false
    return () => {
      if (finished) return
      finished = true
      this.steps.push({
        step,
        startedAtMs: Math.round(startedAt - this.origin),
        ms: Math.round(performance.now() - startedAt)
      })
    }
  }

  /** The steps recorded so far, in completion order. */
  records(): DevStepRecord[] {
    return [...this.steps]
  }
}
