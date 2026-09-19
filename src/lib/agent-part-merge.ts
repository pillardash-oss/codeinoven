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
  const merged = { ...incoming, ...streamedSummaryPatch(existing, incoming) }
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
    return merged
  }
  if (
    (arrivingText.length < streamedText.length && streamedText.startsWith(arrivingText)) ||
    (incoming.type === 'reasoning' && !arrivingText.startsWith(streamedText))
  ) {
    // Stale, shortened, or summary-only reasoning snapshot: keep the
    // accumulated text and take the snapshot's newer metadata. Reasoning is an
    // append-only stream; a divergent snapshot is never allowed to erase it.
    return { ...merged, text: streamedText }
  }
  return merged
}

/**
 * The summary to carry across a reasoning snapshot.
 *
 * Reasoning summaries arrive on their own channel (Codex
 * `item/reasoning/summaryTextDelta`) and, like reasoning text, are append-only.
 * A completion snapshot routinely omits the summary the deltas already
 * delivered, or echoes a truncated prefix of it, so adopting the snapshot
 * verbatim would erase the summary the user watched stream. The accumulated
 * summary wins unless the snapshot carries a genuinely more complete value.
 *
 * Returns an empty patch whenever the snapshot's own summary should stand, so
 * spreading it over the incoming part is a no-op.
 */
function streamedSummaryPatch(existing: AgentPart, incoming: AgentPart): { summary?: string } {
  if (existing.type !== 'reasoning' || incoming.type !== 'reasoning') return {}
  const streamed = existing.summary ?? ''
  // Nothing streamed to protect, or the snapshot already restates it.
  if (streamed === '') return {}
  const arriving = incoming.summary ?? ''
  if (streamed === arriving) return {}
  if (streamFitsSnapshot(streamed, arriving)) return {}
  if (arriving.length < streamed.length && streamed.startsWith(arriving)) {
    return { summary: streamed }
  }
  if (!arriving.startsWith(streamed)) return { summary: streamed }
  return {}
}

/**
 * Append one streamed delta to the field it targets on an accumulated part.
 * Shared by the main-process fold, the durable turn-stream fold, and the
 * renderer so all three assemble streamed parts identically.
 *
 * Codex streams a reasoning item on two channels: `item/reasoning/textDelta`
 * carries the reasoning text and `item/reasoning/summaryTextDelta` carries the
 * concise summary. Collapsing both into `text` made the same sentences render
 * twice in the thinking block (once as the body, once under "Thinking
 * summary"), so each channel now writes its own field.
 */
export function appendPartDelta(part: AgentPart, field: string, delta: string): AgentPart {
  if (delta === '') return part
  if (field === 'text' && (part.type === 'text' || part.type === 'reasoning')) {
    return { ...part, text: `${part.text}${delta}` }
  }
  if (field === 'summary' && part.type === 'reasoning') {
    return { ...part, summary: `${part.summary ?? ''}${delta}` }
  }
  return part
}

/**
 * True when a reasoning part's summary repeats the body it accompanies, so
 * rendering both would show the same sentences twice. Harness streams that
 * collapse their reasoning-text and reasoning-summary channels into one field
 * produce this shape, and sessions persisted before that collapse was fixed
 * still carry it.
 *
 * Comparison ignores whitespace and Markdown emphasis markers: Codex wraps
 * every summary line in `**` and joins the lines with `\n`, while the same
 * sentences arrive concatenated in the body, so a literal string compare would
 * miss the duplicate. Only full equality counts   a genuinely shorter summary
 * whose words also appear somewhere in a long body is still a real summary and
 * must keep rendering.
 */
export function reasoningSummaryRepeatsBody(text: string, summary: string): boolean {
  const body = normalizeReasoningComparison(text)
  const condensed = normalizeReasoningComparison(summary)
  if (body === '' || condensed === '') return false
  return body === condensed
}

/** Strip the whitespace and Markdown emphasis markers that differ between a
 *  reasoning body and its summary without changing the words compared. Only
 *  `*` and whitespace are removed: they are exactly what separates the two
 *  copies of the Codex shape, while leaving identifiers (`snake_case`) and
 *  inline code untouched so a real summary is never mistaken for a duplicate. */
function normalizeReasoningComparison(value: string): string {
  return value.replace(/[*\s]+/gu, '')
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
