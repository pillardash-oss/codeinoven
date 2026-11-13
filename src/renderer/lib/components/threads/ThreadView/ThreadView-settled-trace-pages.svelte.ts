import { SvelteMap } from 'svelte/reactivity'
import { isCompactionPart, traceSpanOfParts, type TraceSpan } from '$shared/working-trace-span'
import type { AgentPart } from '$shared/types'
import { BoardUnit } from '$lib/components/board-unit'
import type { ThreadView } from './ThreadView-board.svelte'

/**
 * Newest entries a settled turn's trace mounts before the reader asks for more.
 *
 * A settled trace is assembled from the transcript's own rows, so it carries
 * every step the turn ever ran: a long run holds several hundred of them, and
 * mounting all of them at once is what made opening one expand into seconds of
 * layout and markdown work. The live trace already pages the durable fold 15 at
 * a time; a settled trace mounts the same way, newest first.
 */
const SETTLED_TRACE_PAGE_SIZE = 40

/** Entries one scroll to the top of a settled trace adds above what is mounted. */
const SETTLED_TRACE_OLDER_PAGE_SIZE = 60

/** What one mounted slice of a settled turn's trace shows. */
export interface SettledTracePage {
  /** Stable identity of the trace this page belongs to. */
  key: string
  /** The newest mounted entries, in the turn's own order. */
  parts: AgentPart[]
  /** Every step the whole trace holds, so the header states its real size. */
  totalSteps: number
  /** True when the trace holds steps older than the oldest mounted one. */
  hasOlder: boolean
  /** Every sub-agent step the whole trace delegated to, mounted or not. */
  subagentParts: AgentPart[]
  /** True when any step of the whole trace compacted its context. */
  compacted: boolean
  /** The whole trace's wall-clock span, mounted or not. */
  span: TraceSpan | null
}

/** One mounted page, kept so a re-render neither re-slices nor re-derives. */
interface SettledTracePageSlot {
  source: readonly AgentPart[]
  limit: number
  page: SettledTracePage
}

/**
 * How much of each settled turn's working trace is mounted.
 *
 * A settled turn is not read from the durable log: its work is already in the
 * transcript rows the view holds, so there is nothing to fetch and nothing that
 * can page over IPC. The cost the reader pays is mounting it, and that is what
 * this unit bounds. Every trace keeps its own newest page, and a scroll to its
 * top adds the next older one, so a 600-step run opens as 40 steps and grows
 * backwards only where somebody is reading.
 *
 * The unit lives on the board, which is keyed by thread and conversation, so the
 * pages a reader opened belong to the conversation they opened them in.
 */
export class ThreadViewSettledTracePages extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }

  /** Steps mounted per trace, by the trace's stable key. */
  private shown = new SvelteMap<string, number>()

  /** Pages already computed, so a streamed frame cannot re-slice a long trace. */
  private slots = new SvelteMap<string, SettledTracePageSlot>()

  /**
   * Identity of one mounted trace.
   *
   * The message that carries the slice and the slice's ordinal inside its turn:
   * both survive the transcript growing upwards, while absolute indices do not.
   */
  keyFor(messageId: string, segmentIndex: number): string {
    return `${messageId}#${segmentIndex}`
  }

  /** Every step a trace holds. Text draws prose, never a step. */
  stepCount(parts: readonly AgentPart[]): number {
    let steps = 0
    for (const part of parts) if (part.type !== 'text') steps += 1
    return steps
  }

  /**
   * The newest page of one trace, with the facts the header states about the
   * whole of it.
   *
   * The totals are computed from every part rather than the mounted page, so a
   * trace showing its newest window still reports the turn's real step count,
   * delegation and span instead of climbing as older pages arrive.
   */
  page(key: string, parts: readonly AgentPart[]): SettledTracePage {
    const limit = this.shown.get(key) ?? SETTLED_TRACE_PAGE_SIZE
    const cached = this.slots.get(key)
    if (cached && cached.source === parts && cached.limit === limit) return cached.page
    const mounted = parts.length > limit ? parts.slice(parts.length - limit) : [...parts]
    const page: SettledTracePage = {
      key,
      parts: mounted,
      totalSteps: this.stepCount(parts),
      hasOlder: parts.length > limit,
      subagentParts: parts.filter((part) => part.type === 'subagent'),
      compacted: parts.some(isCompactionPart),
      span: traceSpanOfParts(parts)
    }
    this.slots.set(key, { source: parts, limit, page })
    return page
  }

  /** Mount the next older page of one trace, above what is already on screen. */
  loadOlder(key: string, total: number): void {
    const limit = this.shown.get(key) ?? SETTLED_TRACE_PAGE_SIZE
    if (limit >= total) return
    this.shown.set(key, Math.min(total, limit + SETTLED_TRACE_OLDER_PAGE_SIZE))
  }
}
