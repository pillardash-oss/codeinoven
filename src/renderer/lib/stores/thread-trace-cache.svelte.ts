import type { AgentPart, TurnStreamPartsChange, TurnStreamPartsPage } from '$shared/types'
import type { TraceSpan } from '$shared/working-trace-span'
import {
  isSubagentPart,
  mergeTurnSubagents,
  mergeWorkingParts,
  type SubagentPart
} from '$lib/working-trace-parts'

/**
 * Navigation-safe cache for a thread's live working trace.
 *
 * The transcript's messages are cached per thread (`thread-messages`), but the
 * working trace that sits above them was component state: `ThreadView` is keyed
 * by thread id, so every switch threw the trace away and rebuilt it over IPC
 * (`thread:loadStreamParts`). Reopening a live thread therefore painted its
 * header with only the handful of parts the message mirror had persisted, and
 * the real tail arrived seconds later once the durable fold landed.
 *
 * This cache holds the same fold the view mounted last, per thread, so the tail
 * paints again on the very first frame of a reopen. Every read is additive
 * (`mergeWorkingParts`), so the durable log refreshes entries in place and can
 * never blank what is already on screen.
 *
 * One entry is the trace of the thread's newest logical turn, which is exactly
 * what the fold is scoped to. It is dropped only for a real reset (a new local
 * turn, a fold boundary the view abandoned) or when the thread is deleted.
 */

/** Threads whose trace stays in memory. A live trace is a few hundred parts at
 *  most, and only the threads the reader actually visited are ever here. */
const MAX_CACHED_THREADS = 12
/** Hard ceiling on the parts one thread keeps. Older pages beyond this are
 *  re-read from the durable log on demand (`hasOlder` stays true), so the cache
 *  can never grow with a very long turn. */
const MAX_CACHED_PARTS = 600

/** The working trace of one thread, as the mounted view last showed it. */
export class ThreadTraceState {
  /** Durable working-trace parts, newest page first-in-log order. */
  parts = $state<AgentPart[]>([])
  /** True when the durable log still folds entries older than `parts[0]`. */
  hasOlder = $state(false)
  /** Thinking and tool steps the whole turn holds, from the durable fold. */
  totalSteps = $state(0)
  /** Newest durable task-list parts for the turn (they never render inline). */
  todoParts = $state<AgentPart[]>([])
  /**
   * Every sub-agent step the whole turn delegated to, in fold order, whether or
   * not it is inside `parts`.
   *
   * The trace header and its dropdown read this instead of the mounted rows: a
   * turn spawns its workers near the start and the mounted window opens on its
   * newest entries, so the step that delegated the work is usually on a page
   * nobody has scrolled to yet.
   */
  subagentParts = $state<SubagentPart[]>([])
  /** True when the whole turn compacted its context, whether or not the
   *  compaction step is on a mounted page. */
  turnCompacted = $state(false)
  /** Earliest start to latest end across the whole turn's steps, so the header
   *  states the turn's real duration while only a page of it is mounted. */
  turnSpan = $state<TraceSpan | null>(null)
  /** Start time of the turn `todoParts` was folded for. */
  todoTurnStart = $state<number | null>(null)
  /** Stream events the durable log has consumed: the live poll's cursor. */
  cursor = $state<number | null>(null)
  /** Which logical turn this fold belongs to, from the page that delivered it. */
  turnStartTs = $state<number | null>(null)
  /** When a durable window last fed this fold, as a wall clock reading. A hover
   *  preload reads the same window again once this is stale, so a fold warmed a
   *  moment ago is reused instead of re-read on every pointer pass. */
  windowReadAt: number | null = null

  /**
   * Adopt one durable window read: parts, fold boundary, cursor and the
   * task-list snapshot travel together, so a hover preload and a read from the
   * mounted view leave the cache in exactly the same state.
   *
   * A window that belongs to a newer logical turn replaces the fold instead of
   * merging into the previous turn's entries: a steer opens a turn of its own,
   * and the work before it must not trail into the new turn's trace.
   */
  adoptWindow(page: TurnStreamPartsPage): void {
    const boundary = page.turnStartTs ?? null
    if (boundary !== null && this.turnStartTs !== null && boundary !== this.turnStartTs) {
      this.reset()
    }
    this.turnStartTs = boundary ?? this.turnStartTs
    this.setParts(mergeWorkingParts(this.parts, page.parts))
    this.hasOlder = page.hasOlder
    this.totalSteps = page.totalSteps
    this.todoParts = page.todoParts
    this.adoptSubagents(page.subagentParts)
    this.adoptTraceMarkers(page)
    this.todoTurnStart = boundary
    this.cursor = page.cursor
    this.windowReadAt = Date.now()
  }

  /** Replace the mounted parts, keeping the cache bounded from the old end. */
  setParts(next: AgentPart[]): void {
    if (next.length > MAX_CACHED_PARTS) {
      this.parts = next.slice(next.length - MAX_CACHED_PARTS)
      // Trimming the head is exactly what paging expects: the durable log still
      // holds those entries and `beforeId` can fetch them again.
      this.hasOlder = true
      return
    }
    this.parts = next
  }

  /**
   * Adopt what the durable fold says about the whole turn: whether it compacted
   * its context, and the span it occupied.
   *
   * Both travel on every read, window or change, because they are facts about
   * the turn rather than about the slice a reader happens to hold.
   */
  adoptTraceMarkers(page: TurnStreamPartsPage | TurnStreamPartsChange): void {
    this.turnCompacted = page.turnCompacted
    this.turnSpan = page.turnSpan
  }

  /**
   * Adopt the turn's delegation from a durable window read.
   *
   * Every window read of one turn carries the whole turn's sub-agent steps, so
   * this is a replacement rather than a merge: paging an older page in changes
   * nothing about who the turn delegated to.
   */
  adoptSubagents(parts: readonly AgentPart[]): void {
    this.subagentParts = parts.filter(isSubagentPart)
  }

  /**
   * Fold the sub-agent snapshots a change read delivered into the turn list.
   *
   * A window read ships the whole turn's delegation, but the live poll only
   * ships what the log touched, so a worker that starts or finishes between two
   * windows arrives here and must reach the header without waiting for the next
   * page.
   */
  mergeTouchedSubagents(parts: readonly AgentPart[]): void {
    const touched = parts.filter(isSubagentPart)
    if (touched.length === 0) return
    this.subagentParts = mergeTurnSubagents(this.subagentParts, touched)
  }

  reset(): void {
    this.parts = []
    this.hasOlder = false
    this.totalSteps = 0
    this.todoParts = []
    this.subagentParts = []
    this.turnCompacted = false
    this.turnSpan = null
    this.todoTurnStart = null
    this.cursor = null
    this.turnStartTs = null
    this.windowReadAt = null
  }
}

class ThreadTraceCache {
  #states = new Map<string, ThreadTraceState>()

  /**
   * The trace state for a conversation, created on first use.
   *
   * Insertion order doubles as recency: every touch moves the entry to the end,
   * so the bound evicts the thread nobody has looked at in a while.
   */
  scope(projectId: string, conversationId: string): ThreadTraceState {
    const key = `${projectId}:${conversationId}`
    const existing = this.#states.get(key)
    if (existing) {
      this.#states.delete(key)
      this.#states.set(key, existing)
      return existing
    }
    const created = new ThreadTraceState()
    this.#states.set(key, created)
    while (this.#states.size > MAX_CACHED_THREADS) {
      const oldest = this.#states.keys().next().value
      if (oldest === undefined || oldest === key) break
      this.#states.delete(oldest)
    }
    return created
  }

  /** The cached trace for a conversation, without creating or touching one. */
  peek(projectId: string, conversationId: string): ThreadTraceState | undefined {
    return this.#states.get(`${projectId}:${conversationId}`)
  }

  /** Drop a thread's trace (thread deleted, or its turn reset). */
  forget(projectId: string, conversationId: string): void {
    this.#states.delete(`${projectId}:${conversationId}`)
  }
}

export const threadTraceCache = new ThreadTraceCache()
