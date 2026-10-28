import { performance } from 'node:perf_hooks'
import { Logger } from '../system/logger'
import { DevStepClock, type DevStepRecord } from '../system/dev-timing'

/**
 * One unit of work timed from its own start.
 *
 * Phases answer "when did the dispatch reach X". A gap between two marks is
 * often several things running at once (the utility runtime, the behavior
 * prompt, the history recap and the checkpoint all run in parallel), so a flat
 * phase delta can never say which of them owned the wait. A step is the missing
 * half: it is timed from its own start, so concurrent work reports concurrent
 * numbers, exactly like the startup telemetry's phase/step split.
 */
export type TurnStepRecord = DevStepRecord

/** Time a step someone else owns, without owning the timer itself. */
export interface TurnStepTimer {
  /** Time one unit of work from its own start, even when it runs concurrently. */
  step<T>(step: string, work: Promise<T>): Promise<T>
}

/**
 * Dev-only phase timer for one dispatched turn.
 *
 * Follow-up prompts on a warm session used to sit on the bare spinner for
 * seconds with no way to tell which phase owned the wait: the send path is one
 * long sequence of awaited engine work, so "it is slow" could mean the mirror
 * write, the session lookup, the utility runtime, the checkpoint snapshot, or
 * the harness round-trip. Every phase is stamped here and the whole breakdown
 * is logged once, under `Logger.dev`, so a regression is visible in the log
 * instead of being argued about. It never changes the turn: a mark is a clock
 * read, and the timings are only ever written to the dev log.
 *
 * A phase alone is too coarse for the slowest one: `turnContext` is 38 s on a
 * bad turn, and a single mark around it cannot say whether the utility runtime,
 * the credential vault or the history recap owned those 38 s. Every awaited unit
 * inside a phase therefore also reports a step, and the one log line carries
 * both lists.
 */
export interface TurnDispatchTimer extends TurnStepTimer {
  /** Stamp a phase boundary. Re-marking the same name is ignored. */
  mark(phase: string): void
  /** Log every phase and step from the previous mark to this one, then the total. */
  finish(): void
}

export function createTurnDispatchTimer(projectId: string, threadId: string): TurnDispatchTimer {
  const startedAt = performance.now()
  const steps = new DevStepClock(startedAt)
  let lastAt = startedAt
  const phases: { phase: string; ms: number }[] = []
  const seen = new Set<string>()
  return {
    mark(phase: string): void {
      if (seen.has(phase)) return
      seen.add(phase)
      const now = performance.now()
      phases.push({ phase, ms: Math.round(now - lastAt) })
      lastAt = now
    },
    step<T>(step: string, work: Promise<T>): Promise<T> {
      return steps.step(step, work)
    },
    finish(): void {
      // Nothing is stamped when the caller bailed out early (a queue handoff,
      // an approval card, an error) so an empty breakdown is not a report.
      if (phases.length === 0) return
      Logger.dev('Turn dispatch phases', {
        projectId,
        threadId,
        totalMs: Math.round(lastAt - startedAt),
        phases,
        steps: steps.records()
      })
    }
  }
}
