import type { AgentPart } from '../../lib/types'
import { appendPartDelta, mergeStreamedPart } from '../../lib/agent-part-merge'

/**
 * Durable, append-only per-thread SSE stream log.
 *
 * A harness session keeps streaming working-trace parts (reasoning, tool calls,
 * sub-agents) long before its turn completes, and those parts are only written
 * to the message mirror at the turn boundary. If the app or renderer restarts
 * mid-turn, reopening the thread had no way to rebuild the trace: the live
 * session was gone and the mirror was stale. This log appends every
 * part-update/delta as it arrives, so the thread can rehydrate the full working
 * trace on mount and "catch up to the live stream" without depending on the
 * harness process still being connected.
 */

/** One record on the per-thread stream log. */
export type TurnStreamEvent =
  | {
      kind: 'part.updated'
      sessionId: string
      messageId: string
      turnId: string
      ts: number
      part: AgentPart
    }
  | {
      kind: 'part.delta'
      sessionId: string
      messageId: string
      partId: string
      field: string
      delta: string
      turnId: string
      ts: number
    }

/**
 * Reassemble an ordered, latest-state part list from a stream log. Mirrors the
 * renderer's live assembly: a `part.updated` snapshot replaces the part (and
 * resets the text baseline), while a `part.delta` appends to the current text.
 * Order is the first-seen order, deduplicated by part id. When `turnId` is
 * supplied only events from that logical turn are folded; otherwise the whole
 * log is folded (used for tests and unbounded reads).
 *
 * Events persisted with an empty `turnId` (emitted while the session's active
 * turn was unbound   pre-registration setup, teardown, silent continues) belong
 * to no specific turn. They are folded into whichever turn is requested (or the
 * whole-log fold) so real working parts never disappear from a rehydrated trace
 * just because their turn anchor was unbound at emit time.
 *
 * When `minTs` is supplied, a part is only included in the output if its most
 * recent activity (snapshot or delta) happened at or after that timestamp  
 * i.e. the boundary filters by last activity, never by snapshot time. This
 * matters for steered turns: the user's steer message moves the turn boundary
 * to mid-turn, and part snapshots streamed before the steer must still fold
 * (with their full accumulated text) or the steer would retroactively erase
 * the trace built up before it.
 *
 * When `minTs` is supplied, every event streamed before that timestamp is
 * dropped   bound or unbound. The log is thread-wide, and neither the steer
 * continuation (which keeps the original turn's anchor) nor a legacy unbound
 * segment may pull earlier turns' parts into the newest trace; callers derive
 * `minTs` from the mirror's newest real user message, the start of the current
 * logical turn.
 */
export function foldTurnStreamEvents(
  events: TurnStreamEvent[],
  turnId?: string,
  minTs?: number
): AgentPart[] {
  const parts: AgentPart[] = []
  const indexById = new Map<string, number>()
  // Text length already present in the stored part, so a delta never re-appends
  // text a later snapshot already included.
  const textBaseline = new Map<string, number>()
  // Same guard for the reasoning summary channel, which Codex streams
  // separately from the reasoning body.
  const summaryBaseline = new Map<string, number>()

  const lastActivityTs = new Map<string, number>()

  for (const event of events) {
    if (turnId !== undefined && event.turnId !== turnId && event.turnId !== '') continue
    if (event.kind === 'part.updated') {
      const part = event.part
      const existingIndex = indexById.get(part.id)
      if (existingIndex === undefined) {
        indexById.set(part.id, parts.length)
        parts.push(part)
      } else {
        parts[existingIndex] = mergeStreamedPart(parts[existingIndex], part)
      }
      const mergedPart = parts[indexById.get(part.id) ?? parts.length - 1]
      const text =
        mergedPart?.type === 'reasoning' || mergedPart?.type === 'text' ? mergedPart.text.length : 0
      textBaseline.set(part.id, text)
      summaryBaseline.set(
        part.id,
        mergedPart?.type === 'reasoning' ? (mergedPart.summary ?? '').length : 0
      )
      lastActivityTs.set(part.id, event.ts)
      continue
    }
    lastActivityTs.set(event.partId, event.ts)
    if (event.kind !== 'part.delta') continue
    const existingIndex = indexById.get(event.partId)
    if (existingIndex === undefined) continue
    const part = parts[existingIndex]
    if (event.field === 'summary') {
      if (part.type !== 'reasoning') continue
      const current = (part.summary ?? '').length
      const baseline = summaryBaseline.get(part.id) ?? current
      // A rewind (a snapshot shortened the summary) is ignored rather than
      // corrupting the reconstruction, mirroring the text channel below.
      if (baseline > current) {
        summaryBaseline.set(part.id, current)
        continue
      }
      const updated = appendPartDelta(part, event.field, event.delta)
      parts[existingIndex] = updated
      if (updated.type === 'reasoning') {
        summaryBaseline.set(part.id, (updated.summary ?? '').length)
      }
      continue
    }
    if (event.field !== 'text') continue
    if (part.type !== 'reasoning' && part.type !== 'text') continue
    const baseline = textBaseline.get(part.id) ?? part.text.length
    // Only append deltas that continue from the recorded baseline; a rewind
    // (snapshot replaced the text shorter than expected) is ignored rather
    // than corrupting the reconstruction.
    if (baseline > part.text.length) {
      textBaseline.set(part.id, part.text.length)
      continue
    }
    const updated = appendPartDelta(part, event.field, event.delta)
    parts[existingIndex] = updated
    if (updated.type === 'text' || updated.type === 'reasoning') {
      textBaseline.set(part.id, updated.text.length)
    }
  }

  if (minTs === undefined) return parts
  // Boundary filter: a part survives only if it was touched at or after the
  // boundary. Snapshots streamed before it still fold (so deltas can append
  // and text stays intact), but stale parts from before the boundary are
  // excluded from the output.
  return parts.filter((part) => (lastActivityTs.get(part.id) ?? 0) >= minTs)
}

/**
 * Drop everything streamed before `minTs` except the latest snapshot of each
 * part the current turn still touches.
 *
 * The log is thread-wide and append-only, so a cache that keeps it whole holds
 * every event the app has ever streamed for a thread, even though the fold only
 * ever uses the current turn. A snapshot carries a part's whole state, so the
 * newest one before the boundary is the only pre-boundary event that can still
 * contribute: it seeds the deltas that arrive after it. Dropping all the other
 * pre-boundary events leaves the fold identical while bounding the cache to the
 * current turn. A part the current turn never touches needs no baseline, so its
 * pre-boundary events are dropped entirely.
 *
 * Returns the same array when there is nothing to drop, so a caller can detect a
 * no-op by identity.
 */
export function compactTurnStreamEvents(
  events: TurnStreamEvent[],
  minTs: number | undefined
): TurnStreamEvent[] {
  if (minTs === undefined || events.length === 0) return events
  // Part ids the current turn still touches: these are the only ones whose
  // pre-boundary snapshot can still matter.
  const liveParts = new Set<string>()
  let hasPreBoundaryEvent = false
  for (const event of events) {
    if (event.ts >= minTs) {
      liveParts.add(event.kind === 'part.updated' ? event.part.id : event.partId)
    } else {
      hasPreBoundaryEvent = true
    }
  }
  if (!hasPreBoundaryEvent) return events
  const retainedSnapshots = new Map<string, number>()
  const kept: TurnStreamEvent[] = []
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!event) continue
    if (event.ts >= minTs) {
      kept.push(event)
      continue
    }
    if (event.kind !== 'part.updated' || !liveParts.has(event.part.id)) continue
    // Later snapshots of the same part supersede earlier ones.
    const previous = retainedSnapshots.get(event.part.id)
    if (previous !== undefined) kept[previous] = event
    else {
      retainedSnapshots.set(event.part.id, kept.length)
      kept.push(event)
    }
  }
  if (kept.length === events.length) return events
  return kept
}
