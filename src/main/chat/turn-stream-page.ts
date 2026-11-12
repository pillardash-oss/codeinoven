import {
  COMPLETED_TURN_PAGE_SIZE,
  WORKING_TRACE_PAGE_SIZE,
  type AgentPart,
  type TurnStreamCompletedTurn,
  type TurnStreamPartsChange,
  type TurnStreamPartsPage,
  type TurnStreamPartsQuery
} from '../../lib/types'
import { isTodoToolName } from '../../lib/agent-interactions'
import { isCompactionPart, traceSpanOfParts } from '../../lib/working-trace-span'
import type { TurnStreamEvent } from './turn-stream'

/** Upper bound on the task-list snapshot returned alongside every read. */
const TODO_PARTS_CAP = 60
/** Hard ceiling on a single window, so a hostile or buggy caller cannot ask for
 *  the whole folded turn across IPC. */
const MAX_PAGE_SIZE = 500

/**
 * A task-list tool part is durable trace data that never renders in the working
 * trace: the renderer filters it out of the trace list and feeds it to the task
 * card instead. Paging keeps them out of `parts` so a page stays display-sized.
 */
export function isTodoTracePart(part: AgentPart): boolean {
  return part.type === 'tool' && isTodoToolName(part.tool)
}

/**
 * Every sub-agent step a turn delegated to, whether or not it falls inside the
 * page being read.
 *
 * Delegation is the one part of a trace whose summary must never depend on how
 * much of the turn is mounted: a sub-agent is spawned early in a long turn, so a
 * reader that only holds the newest page has no sub-agent row at all, and the
 * trace header was reporting "no sub-agents" for work it demonstrably delegated.
 * The list therefore rides beside the window, the way the task list does, and the
 * header and its dropdown read it instead of the mounted rows.
 */
export function turnSubagentParts(trace: readonly AgentPart[]): AgentPart[] {
  return trace.filter((part) => part.type === 'subagent')
}

/**
 * The facts the trace header states about a whole turn, independent of which
 * page of it a reader has mounted: whether it compacted its context, and the
 * wall-clock span its steps occupied.
 *
 * Every one of them comes from the durable fold rather than from the window, for
 * the same reason `totalSteps` does: a bounded page is a slice of the turn, and a
 * header that reports a slice states less than the truth (a compaction that never
 * happened, a duration covering only the newest minutes).
 */
export function turnTraceMarkers(trace: readonly AgentPart[]): {
  turnCompacted: boolean
  turnSpan: { start: number; end: number } | null
} {
  return {
    turnCompacted: trace.some(isCompactionPart),
    turnSpan: traceSpanOfParts(trace)
  }
}

/**
 * Cut one bounded window out of a completed turn's folded entries.
 *
 * A completed turn is read the same way the live one is   newest entries first,
 * with `beforeId` walking back through the rest   because a turn closed by a
 * steer can hold hundreds of steps and only a window of them should cross IPC
 * at a time. Task-list tool parts are excluded exactly as they are from the live
 * window: they drive the task card, never the trace.
 */
export function completedTurnWindow(
  turn: { startTs: number; endTs: number; parts: readonly AgentPart[] },
  query: TurnStreamPartsQuery = {}
): TurnStreamCompletedTurn {
  const trace = turn.parts.filter((part) => !isTodoTracePart(part))
  const totalSteps = trace.reduce((count, part) => count + (part.type === 'text' ? 0 : 1), 0)
  const markers = turnTraceMarkers(trace)
  if (query.summaryOnly === true) {
    // Totals without rows: the transcript's folded header needs the count, the
    // span and the delegation of a settled turn, and nothing else until the
    // reader opens it.
    return {
      startTs: turn.startTs,
      endTs: turn.endTs,
      parts: [],
      subagentParts: turnSubagentParts(trace),
      ...markers,
      total: trace.length,
      totalSteps,
      start: trace.length,
      hasOlder: trace.length > 0
    }
  }
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? COMPLETED_TURN_PAGE_SIZE), 1),
    MAX_PAGE_SIZE
  )
  let start: number
  let end: number
  if (query.beforeId !== undefined) {
    const index = trace.findIndex((part) => part.id === query.beforeId)
    end = index >= 0 ? index : trace.length
    start = Math.max(0, end - limit)
  } else {
    end = trace.length
    start = Math.max(0, trace.length - limit)
  }
  return {
    startTs: turn.startTs,
    endTs: turn.endTs,
    parts: trace.slice(start, end),
    subagentParts: turnSubagentParts(trace),
    ...markers,
    total: trace.length,
    totalSteps,
    start,
    hasOlder: start > 0
  }
}

/**
 * Cut one bounded window out of a folded working trace, or report what the log
 * touched since a change cursor.
 *
 * The fold (`foldTurnStreamEvents`) collapses the raw SSE log into a single
 * ordered, first-seen list of parts for the newest logical turn: later
 * snapshots of the same part id update their entry in place rather than
 * appending a new one. That makes the folded list a stable coordinate space, so
 * a window is simply a slice of it and a cursor is just a part id whose index we
 * resolve inside the same list. This keeps the window correct while the log
 * keeps streaming: an id seen on an earlier page still resolves as long as the
 * fold retained it.
 *
 * A change read is the live poll's cursor. It is deliberately not a window: it
 * reports growth AND in-place updates, because a reader that already mounted a
 * part must never be left holding a stale snapshot of it (a tool call that
 * finished, a sub-agent that reported progress). It is also deliberately
 * uncapped: everything the log touched between two reads has to arrive, or the
 * reader would advance its cursor past entries it never received.
 *
 * Task-list tool parts ride out of band (`todoParts`) because they are excluded
 * from the trace window entirely: whichever trace page is mounted must never
 * decide whether the task card can render, so the newest slice always travels
 * with the read.
 *
 * Sub-agent steps ride out of band for the same reason (`subagentParts`), from
 * the other direction: they do render in the trace, but they are spawned early
 * in a long turn while the window opens on its newest entries, so a page-sized
 * view of a turn can hold none of them. The trace header states the turn's
 * delegation from this list, never from the mounted rows.
 *
 * The read also carries `turnStartTs`, the boundary the fold was scoped to, so
 * the card can tell whether the snapshot still describes the turn the
 * transcript is on. The card refreshes only while a view watches a live turn,
 * so without that identity the previous turn's snapshot would outrank the
 * fresher message cache after the transcript moved on, which is what left a
 * stale task list on screen.
 */
export function pageTurnStreamParts(
  folded: readonly AgentPart[],
  events: readonly TurnStreamEvent[],
  query: TurnStreamPartsQuery = {},
  turnStartTs: number | null = null
): TurnStreamPartsPage | TurnStreamPartsChange {
  const trace = folded.filter((part) => !isTodoTracePart(part))
  const todoParts = folded.filter(isTodoTracePart).slice(-TODO_PARTS_CAP)
  const cursor = events.length
  // The header reports how much thinking and tool work the whole turn holds,
  // independent of how many steps the renderer has mounted.
  const totalSteps = trace.reduce((count, part) => count + (part.type === 'text' ? 0 : 1), 0)
  const markers = turnTraceMarkers(trace)

  if (query.changedSince !== undefined) {
    return {
      kind: 'change',
      parts: touchedTraceParts(trace, events, query.changedSince),
      total: trace.length,
      totalSteps,
      ...markers,
      cursor,
      todoParts,
      turnStartTs
    }
  }

  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? WORKING_TRACE_PAGE_SIZE), 1),
    MAX_PAGE_SIZE
  )
  let start: number
  let end: number
  if (query.beforeId !== undefined) {
    // Older-page request: the page ends just before the cursor part.
    const index = trace.findIndex((part) => part.id === query.beforeId)
    if (index >= 0) {
      end = index
      start = Math.max(0, index - limit)
    } else {
      // The log folded a different turn (or the part is gone): the safest
      // window is the newest one, never an empty or out-of-range slice.
      end = trace.length
      start = Math.max(0, trace.length - limit)
    }
  } else {
    // No cursor: open on the newest page.
    end = trace.length
    start = Math.max(0, trace.length - limit)
  }

  return {
    kind: 'window',
    parts: trace.slice(start, end),
    total: trace.length,
    totalSteps,
    start,
    hasOlder: start > 0,
    cursor,
    todoParts,
    subagentParts: turnSubagentParts(trace),
    ...markers,
    turnStartTs
  }
}

/**
 * Parts of the current fold touched by stream events after `changedSince`, in
 * fold order. A snapshot touches its own part id; a text delta touches the id
 * it appends to. Events a later fold dropped (an earlier turn, a part filtered
 * out of the newest logical turn) resolve to nothing and are simply not
 * reported.
 */
function touchedTraceParts(
  trace: readonly AgentPart[],
  events: readonly TurnStreamEvent[],
  changedSince: number
): AgentPart[] {
  // A cursor past the end can only mean the log was rewritten under the reader.
  // Treating it as "everything already consumed" keeps the next read honest: the
  // fresh cursor that ships with this response re-syncs the reader.
  const from = Math.max(0, Math.min(changedSince, events.length))
  const touched = new Set<string>()
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (!event) continue
    touched.add(event.kind === 'part.updated' ? event.part.id : event.partId)
  }
  if (touched.size === 0) return []
  return trace.filter((part) => touched.has(part.id))
}
