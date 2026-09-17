import {
  WORKING_TRACE_PAGE_SIZE,
  type AgentPart,
  type TurnStreamPartsChange,
  type TurnStreamPartsPage,
  type TurnStreamPartsQuery
} from '../../lib/types'
import { isTodoToolName } from '../../lib/agent-interactions'
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
 */
export function pageTurnStreamParts(
  folded: readonly AgentPart[],
  events: readonly TurnStreamEvent[],
  query: TurnStreamPartsQuery = {}
): TurnStreamPartsPage | TurnStreamPartsChange {
  const trace = folded.filter((part) => !isTodoTracePart(part))
  const todoParts = folded.filter(isTodoTracePart).slice(-TODO_PARTS_CAP)
  const cursor = events.length

  if (query.changedSince !== undefined) {
    return {
      kind: 'change',
      parts: touchedTraceParts(trace, events, query.changedSince),
      total: trace.length,
      cursor,
      todoParts
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
    start,
    hasOlder: start > 0,
    cursor,
    todoParts
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
