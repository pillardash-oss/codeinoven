import type { AgentPart } from './types/agent-message'

/**
 * Wall-clock span of working-trace entries.
 *
 * The renderer measures a chain with it, and the main process measures a whole
 * folded turn with it so a trace header can state how long the turn took without
 * the reader having mounted every page of it. Same code on both sides, because a
 * duration that disagrees with the rows underneath it is worse than no duration.
 */
export interface TraceSpan {
  start: number
  end: number
}

function stepTime(part: AgentPart): { start?: number; end?: number } | undefined {
  if (part.type === 'tool') return part.state.time
  if (part.type === 'reasoning') return part.time
  if (part.type === 'subagent') return part.activity.time
  return undefined
}

/**
 * Earliest start and latest end across a set of parts, or null when none of them
 * reported a timestamp. The end falls back to the start so a span whose entries
 * never closed still has a stable duration to render instead of an open range.
 */
export function traceSpanOfParts(parts: readonly AgentPart[]): TraceSpan | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const part of parts) {
    const time = stepTime(part)
    if (time?.start !== undefined) start = Math.min(start, time.start)
    if (time?.end !== undefined) end = Math.max(end, time.end)
  }
  if (start === Number.POSITIVE_INFINITY) return null
  return { start, end: end === Number.NEGATIVE_INFINITY ? start : Math.max(end, start) }
}

/** True when a part records a compaction of the conversation's context. */
export function isCompactionPart(part: AgentPart): boolean {
  return part.type === 'compaction' || part.type === 'compaction-summary'
}

/**
 * The instant a settled trace's duration ends at.
 *
 * A turn's close outranks the extent of its own rows. The harness writes its
 * answer after its last step, and it can sit quiet far longer than the work it
 * did: one run answered in four minutes, then spent forty more before it wrote
 * anything, and a header measured to the last step reported the four while the
 * turn's own duration reported all forty-four. The caller therefore reports the
 * instant the turn's last message closed when it knows it, and the span stands in
 * only when it does not (a turn whose work never mirrored a closing row, or one
 * whose entries are not mounted at all, where `endTime` is the app's boundary).
 *
 * The close can never shorten a span: clock skew between a harness's step and the
 * app's own stamp must not make a trace state less work than its rows show.
 */
export function traceEndInstant(input: {
  span: TraceSpan | null
  /** When this turn's last message closed, once the turn really has closed. */
  closedAt?: number
  /** The app's own end of the turn, for a trace with no span to measure. */
  endTime?: number
}): number | undefined {
  if (input.closedAt !== undefined) {
    return input.span ? Math.max(input.closedAt, input.span.end) : input.closedAt
  }
  if (input.span) return input.span.end
  return input.endTime
}
