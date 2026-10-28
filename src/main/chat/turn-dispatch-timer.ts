import { Logger } from '../system/logger'

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
 */
export interface TurnDispatchTimer {
  /** Stamp a phase boundary. Re-marking the same name is ignored. */
  mark(phase: string): void
  /** Log every phase from the previous mark to this one, then the total. */
  finish(): void
}

export function createTurnDispatchTimer(projectId: string, threadId: string): TurnDispatchTimer {
  const startedAt = performance.now()
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
    finish(): void {
      // Nothing is stamped when the caller bailed out early (a queue handoff,
      // an approval card, an error) so an empty breakdown is not a report.
      if (phases.length === 0) return
      Logger.dev('Turn dispatch phases', {
        projectId,
        threadId,
        totalMs: Math.round(lastAt - startedAt),
        phases
      })
    }
  }
}
