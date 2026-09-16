import {
  WORKING_TRACE_PAGE_SIZE,
  type AgentPart,
  type TurnStreamPartsPage,
  type TurnStreamPartsQuery
} from '../../lib/types'
import { isTodoToolName } from '../../lib/agent-interactions'

/** Upper bound on the task-list snapshot returned alongside every page. */
const TODO_PARTS_CAP = 60
/** Hard ceiling on a single page, so a hostile or buggy caller cannot ask for
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
 * Cut one bounded page out of a folded working trace.
 *
 * The fold (`foldTurnStreamEvents`) collapses the raw SSE log into a single
 * ordered, first-seen list of parts for the newest logical turn: later
 * snapshots of the same part id update their entry in place rather than
 * appending a new one. That makes the folded list a stable coordinate space, so
 * a page is simply a slice of it and a cursor is just a part id whose index we
 * resolve inside the same list. This keeps the window correct while the log
 * keeps streaming: an id seen on an earlier page still resolves as long as the
 * fold retained it.
 *
 * Task-list tool parts ride out of band (`todoParts`) because they are excluded
 * from the trace window entirely: whichever trace page is mounted must never
 * decide whether the task card can render, so the newest slice always travels
 * with the page. The list is capped defensively (they are small, and the card
 * only ever shows the latest one).
 */
export function pageTurnStreamParts(
  folded: AgentPart[],
  query: TurnStreamPartsQuery = {}
): TurnStreamPartsPage {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? WORKING_TRACE_PAGE_SIZE), 1),
    MAX_PAGE_SIZE
  )
  const trace = folded.filter((part) => !isTodoTracePart(part))
  const todoParts = folded.filter(isTodoTracePart).slice(-TODO_PARTS_CAP)

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
  } else if (query.afterId !== undefined) {
    // Live-delta request: everything newer than the cursor part.
    const index = trace.findIndex((part) => part.id === query.afterId)
    if (index >= 0) {
      start = index + 1
      end = Math.min(trace.length, start + limit)
    } else {
      end = trace.length
      start = Math.max(0, trace.length - limit)
    }
  } else {
    // No cursor: open on the newest page.
    end = trace.length
    start = Math.max(0, trace.length - limit)
  }

  return {
    parts: trace.slice(start, end),
    total: trace.length,
    start,
    hasOlder: start > 0,
    hasNewer: end < trace.length,
    todoParts
  }
}
