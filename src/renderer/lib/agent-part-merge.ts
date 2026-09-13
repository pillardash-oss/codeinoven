import type { AgentPart } from '$shared/types'

/**
 * Merge an incoming streamed part snapshot with the part already accumulated
 * in the renderer cache.
 *
 * Drivers emit `message.part.updated` snapshots alongside `message.part.delta`
 * streams. A snapshot must always be a superset of what the deltas streamed —
 * but several harness paths violate that: reasoning items that complete with
 * empty text (Codex puts reasoning in `summary`), final thinking blocks that
 * arrive summary-only or truncated, and mid-stream echoes of shorter text.
 * Accepting such a snapshot wipes text the user already watched stream and
 * never recovers it (the cut-off-thinking symptom), so a snapshot whose text
 * is a prefix of the accumulated text keeps the accumulated text and takes the
 * snapshot's newer metadata instead. Genuine replacements — different or
 * longer text — still win outright.
 */
export function mergeStreamedPart(existing: AgentPart, incoming: AgentPart): AgentPart {
  if (incoming.id !== existing.id) return incoming
  if (incoming.type !== existing.type) return incoming
  if (incoming.type !== 'text' && incoming.type !== 'reasoning') return incoming
  const streamedText: string =
    existing.type === 'text' || existing.type === 'reasoning' ? existing.text : ''
  const arrivingText: string =
    incoming.type === 'text' || incoming.type === 'reasoning' ? incoming.text : ''
  if (
    (arrivingText.length < streamedText.length && streamedText.startsWith(arrivingText)) ||
    (incoming.type === 'reasoning' && !arrivingText.startsWith(streamedText))
  ) {
    // Stale, shortened, or summary-only reasoning snapshot: keep the
    // accumulated text and take the snapshot's newer metadata. Reasoning is an
    // append-only stream; a divergent snapshot is never allowed to erase it.
    return { ...incoming, text: streamedText }
  }
  return incoming
}
