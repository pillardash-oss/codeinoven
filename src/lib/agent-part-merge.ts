import type { AgentPart } from './types'

/**
 * Merge an incoming streamed part snapshot with the part already accumulated in
 * the consumer's cache (renderer store, or the durable working-trace fold).
 * Shared by the renderer and the main process so both assemble a streamed
 * transcript identically.
 *
 * Drivers emit `message.part.updated` snapshots alongside `message.part.delta`
 * streams. A snapshot must always be a superset of what the deltas streamed,
 * but several harness paths violate that: reasoning items that complete with
 * empty text (Codex puts reasoning in `summary`), final thinking blocks that
 * arrive summary-only or truncated, and mid-stream echoes of shorter text.
 * Accepting such a snapshot wipes text the user already watched stream and
 * never recovers it (the cut-off-thinking symptom), so a snapshot whose text is
 * a prefix of the accumulated text keeps the accumulated text and takes the
 * snapshot's newer metadata instead. Genuine replacements, longer text, and a
 * stream that a reordered append shuffled (see `streamFitsSnapshot`) win
 * outright.
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
    incoming.type === 'reasoning' &&
    arrivingText !== streamedText &&
    streamFitsSnapshot(streamedText, arrivingText)
  ) {
    // Everything streamed is present in the snapshot, only in a different order
    // (a reordered append scrambled the stream, see StorageEngine.appendRaw), so
    // the snapshot is strictly more complete. Adopting its order cannot lose
    // streamed text, and it is the only way a scrambled trace gets cleaned up
    // when the final reasoning block arrives.
    return incoming
  }
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

/**
 * True when every code point the streamed text holds also appears in the
 * snapshot, so adopting the snapshot cannot drop streamed content: the stream
 * is a reordering of the snapshot (or a reordered prefix of it), never a
 * divergent rewrite. Compares code points, never UTF-16 units, so surrogate
 * pairs survive intact. A snapshot shorter than the stream can never qualify,
 * which keeps the stale/truncated-snapshot protection intact.
 */
function streamFitsSnapshot(streamed: string, snapshot: string): boolean {
  if (streamed.length > snapshot.length) return false
  const available = new Map<string, number>()
  for (const character of snapshot) available.set(character, (available.get(character) ?? 0) + 1)
  for (const character of streamed) {
    const count = available.get(character)
    if (count === undefined) return false
    if (count === 1) available.delete(character)
    else available.set(character, count - 1)
  }
  return true
}
