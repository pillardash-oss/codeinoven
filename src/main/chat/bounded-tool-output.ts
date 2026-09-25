import type { AgentPart, AgentToolState } from '../../lib/types'
import { base64Kilobytes } from '../../lib/image-payload'

/**
 * Bounded persisted size for one tool part's `state.output`.
 *
 * Tool outputs (file reads, image payloads, command dumps) can reach several
 * megabytes. Persisting them inline   in the SQLite mirror and the per-thread
 * stream log   makes transcript loads, forks, and compaction scans parse
 * multi-megabyte JSON rows on the main process, which visibly hangs the app.
 * The bounded representation keeps enough of the payload to stay useful
 * (head + tail + exact byte count) while capping every row far below the
 * pain threshold.
 */
export const TOOL_OUTPUT_PERSIST_CAP = 64 * 1024

/** Characters kept from the head of an oversized tool output. */
const HEAD_KEEP = 40 * 1024
/** Characters kept from the tail of an oversized tool output. */
const TAIL_KEEP = 8 * 1024

const TRUNCATION_MARKER = '\n\n[… output truncated for persistence: '

/**
 * True when the string is large enough to be worth the truncation pass.
 * Sub-cap strings are returned untouched so the hot path stays cheap.
 */
function isOversized(text: string): boolean {
  return text.length > TOOL_OUTPUT_PERSIST_CAP
}

/** Cap one oversized output string to head + tail + byte-count marker. */
function capOutput(text: string): string {
  return `${text.slice(0, HEAD_KEEP)}${TRUNCATION_MARKER}${text.length} bytes total   showing first ${HEAD_KEEP} and last ${TAIL_KEEP}]…\n${text.slice(-TAIL_KEEP)}`
}

/**
 * Largest embedded base64 image payload kept verbatim in a durable record.
 *
 * `TOOL_OUTPUT_PERSIST_CAP` alone does not bound an image payload. A capture
 * larger than the cap has its head kept, and the head holds the whole data URL,
 * so a measured 1,314,090-character payload still reached the mirror and the
 * stream log at ~50KB per record. A capture smaller than the cap passes through
 * entirely. Either way the bytes serve nothing there: the model is handed the
 * picture as a real image content part, the trace renders the output as
 * collapsed text, and the replay recap keeps 500 characters of a tool result.
 * An embedded payload above this size becomes a marker naming its type and size,
 * while a small inline icon stays readable.
 */
const MAX_INLINE_IMAGE_PAYLOAD = 4 * 1024

const INLINE_IMAGE_PAYLOAD = /data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/giu

/**
 * Replace every oversized embedded base64 image payload with a marker naming its
 * media type and decoded size. A string with no `data:image` in it never reaches
 * the pattern match, and an untouched string is returned by reference, so the hot
 * path stays allocation-free. The marker replaces the data URL alone, leaving any
 * JSON around it parseable.
 */
export function capInlineImagePayloads(text: string): string {
  if (!text.includes('data:image')) return text
  return text.replace(INLINE_IMAGE_PAYLOAD, (match, mimeType: string, data: string) =>
    data.length > MAX_INLINE_IMAGE_PAYLOAD
      ? `[image payload omitted from the durable record: ${mimeType}, ${base64Kilobytes(data.length)} KB]`
      : match
  )
}

/** Bound one persisted string: drop an oversized embedded image payload, then
 *  truncate whatever is still oversized. */
function boundPersistedText(text: string): string {
  const withoutImages = capInlineImagePayloads(text)
  return isOversized(withoutImages) ? capOutput(withoutImages) : withoutImages
}

/**
 * Cap oversized tool-part outputs in an event part before it reaches any
 * durable store (mirror rows, stream log lines). Sub-cap parts pass through
 * by reference   the common case stays allocation-free.
 */
export function capPersistedPart(part: AgentPart): AgentPart {
  if (part.type !== 'tool') return part
  const state = part.state
  let nextState: AgentToolState | null = null
  if (typeof state.output === 'string') {
    const bounded = boundPersistedText(state.output)
    if (bounded !== state.output) nextState = { ...state, output: bounded }
  }
  // Metadata can also carry inline payload (e.g. attachment descriptors).
  const metadata = state.metadata
  if (metadata) {
    let touched = false
    const capped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string') {
        const bounded = boundPersistedText(value)
        capped[key] = bounded
        if (bounded !== value) touched = true
      } else {
        capped[key] = value
      }
    }
    if (touched) nextState = { ...(nextState ?? state), metadata: capped }
  }
  return nextState ? { ...part, state: nextState } : part
}

/** Cap every part of a message that is about to be persisted. */
export function capPersistedParts(parts: AgentPart[]): AgentPart[] {
  return parts.map(capPersistedPart)
}
