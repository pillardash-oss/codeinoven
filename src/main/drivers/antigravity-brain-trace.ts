/**
 * Parser for Antigravity's durable "brain" transcripts.
 *
 * agy strips thought summaries from headless `stream-json` output: the
 * concatenated `text_delta` stream always equals the final `response`, even
 * when steps consumed hundreds of thinking tokens. The thinking text itself is
 * however persisted per step to
 * `~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`
 * as one JSON object per line, written incrementally as the run progresses.
 *
 * `PLANNER_RESPONSE` entries carry the model's raw `thinking` text for that
 * step; `step_index` matches the `step_index` agy streams in `step_update`
 * records, so brain entries join onto the streamed step timeline directly.
 *
 * This file describes an undocumented internal format and may change in any
 * agy release. The parser is therefore tolerant: unexpected shapes degrade to
 * "no thinking available" and callers keep the timed-only entries.
 */

/** agy release whose transcript shape this parser was verified against. */
export const VERIFIED_AGY_VERSION = '1.1.26'

/** One joinable brain transcript entry. */
export interface BrainTraceEntry {
  /** Streamed step this entry belongs to (matches `step_update.step_index`). */
  stepIndex: number
  /** Raw model thinking text for the step. */
  thinking: string
}

/**
 * Parse one brain transcript JSONL line into the trace join shape. Returns
 * null for anything that is not a settled entry with both a usable step index
 * and thinking text — only what joins confidently is surfaced.
 */
export function parseBrainTraceLine(line: string): BrainTraceEntry | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.charAt(0) !== '{') return null
  let value: unknown
  try {
    value = JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  // Thinking text lives on PLANNER_RESPONSE entries; entries of any other
  // shape simply have no usable `thinking` string and are skipped.
  const thinking = entry['thinking']
  if (typeof thinking !== 'string' || thinking.length === 0) return null
  const stepIndex = entry['step_index']
  if (typeof stepIndex !== 'number' || !Number.isSafeInteger(stepIndex) || stepIndex < 0) {
    return null
  }
  return { stepIndex, thinking }
}
