import type { AgentPart } from '$shared/types'
import { WORKING_TRACE_PAGE_SIZE } from '$shared/types'

/**
 * The working trace mounts one bounded window of entries, pinned to the oldest
 * entry it currently shows.
 *
 * A live turn streams unbounded into the durable log, so a trace that mounted
 * everything on open made a long running thread expensive to re-enter. Instead
 * the trace opens on the newest page, appends entries that arrive afterwards
 * without ever evicting what the reader already has on screen, and mounts older
 * entries one page at a time only when the reader scrolls the trace's own
 * scroller to its top.
 */

/**
 * Index the mounted window starts at. `startId` is the pinned oldest entry;
 * when it is absent (a fresh trace, or one re-bounded after the reader left)
 * the window is the newest page. An entry that left the list falls back to the
 * newest page so a replaced cache can never render an empty trace.
 */
export function traceWindowStartIndex(
  parts: readonly AgentPart[],
  startId: string | null,
  pageSize = WORKING_TRACE_PAGE_SIZE
): number {
  if (startId !== null) {
    const index = parts.findIndex((part) => part.id === startId)
    if (index >= 0) return index
  }
  return Math.max(0, parts.length - pageSize)
}

/** True when the pinned entry is no longer part of the rendered entry list. */
export function traceWindowAnchorExpired(
  parts: readonly AgentPart[],
  startId: string | null
): boolean {
  if (startId === null) return false
  return !parts.some((part) => part.id === startId)
}

/**
 * The entry one older page starts at, or null when the window already reaches
 * (or is at) the oldest entry the trace holds.
 */
export function olderTraceStartId(
  parts: readonly AgentPart[],
  startIndex: number,
  pageSize = WORKING_TRACE_PAGE_SIZE
): string | null {
  if (startIndex <= 0) return null
  const next = Math.max(0, startIndex - pageSize)
  return parts[next]?.id ?? null
}

/** The id the newest page starts at, or null for an empty entry list. */
export function newestTraceStartId(
  parts: readonly AgentPart[],
  pageSize = WORKING_TRACE_PAGE_SIZE
): string | null {
  return parts[Math.max(0, parts.length - pageSize)]?.id ?? null
}
