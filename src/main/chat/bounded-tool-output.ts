import type { AgentPart } from '../../lib/types'

/**
 * Bounded persisted size for one tool part's `state.output`.
 *
 * Tool outputs (file reads, image payloads, command dumps) can reach several
 * megabytes. Persisting them inline — in the SQLite mirror and the per-thread
 * stream log — makes transcript loads, forks, and compaction scans parse
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
  return `${text.slice(0, HEAD_KEEP)}${TRUNCATION_MARKER}${text.length} bytes total — showing first ${HEAD_KEEP} and last ${TAIL_KEEP}]…\n${text.slice(-TAIL_KEEP)}`
}

/**
 * Cap oversized tool-part outputs in an event part before it reaches any
 * durable store (mirror rows, stream log lines). Sub-cap parts pass through
 * by reference — the common case stays allocation-free.
 */
export function capPersistedPart(part: AgentPart): AgentPart {
  if (part.type !== 'tool') return part
  const state = part.state
  if (typeof state.output === 'string' && isOversized(state.output)) {
    return {
      ...part,
      state: { ...state, output: capOutput(state.output) }
    }
  }
  // Metadata can also carry inline payload (e.g. attachment descriptors).
  const metadata = state.metadata
  if (metadata) {
    let touched = false
    const capped: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && isOversized(value)) {
        capped[key] = capOutput(value)
        touched = true
      } else {
        capped[key] = value
      }
    }
    if (touched) return { ...part, state: { ...state, metadata: capped } }
  }
  return part
}

/** Cap every part of a message that is about to be persisted. */
export function capPersistedParts(parts: AgentPart[]): AgentPart[] {
  return parts.map(capPersistedPart)
}
