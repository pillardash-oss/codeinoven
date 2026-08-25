import type { AgentPart } from '../../lib/types'

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
 */
export function foldTurnStreamEvents(events: TurnStreamEvent[], turnId?: string): AgentPart[] {
  const parts: AgentPart[] = []
  const indexById = new Map<string, number>()
  // Text length already present in the stored part, so a delta never re-appends
  // text a later snapshot already included.
  const textBaseline = new Map<string, number>()

  for (const event of events) {
    if (turnId !== undefined && event.turnId !== turnId) continue
    if (event.kind === 'part.updated') {
      const part = event.part
      const existingIndex = indexById.get(part.id)
      if (existingIndex === undefined) {
        indexById.set(part.id, parts.length)
        parts.push(part)
      } else {
        parts[existingIndex] = part
      }
      const text = part.type === 'reasoning' || part.type === 'text' ? part.text.length : 0
      textBaseline.set(part.id, text)
      continue
    }
    if (event.kind !== 'part.delta') continue
    const existingIndex = indexById.get(event.partId)
    if (existingIndex === undefined) continue
    if (event.field !== 'text') continue
    const part = parts[existingIndex]
    if (part.type !== 'reasoning' && part.type !== 'text') continue
    const baseline = textBaseline.get(part.id) ?? part.text.length
    // Only append deltas that continue from the recorded baseline; a rewind
    // (snapshot replaced the text shorter than expected) is ignored rather
    // than corrupting the reconstruction.
    if (baseline > part.text.length) {
      textBaseline.set(part.id, part.text.length)
      continue
    }
    const updated = { ...part, text: part.text + event.delta }
    parts[existingIndex] = updated
    textBaseline.set(part.id, updated.text.length)
  }

  return parts
}
