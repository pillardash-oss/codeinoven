import {
  ASSISTANT_IMPACT_IDS,
  ASSISTANT_IMPACT_OPTIONS,
  ASSISTANT_TIMELINESS_IDS,
  ASSISTANT_TIMELINESS_OPTIONS
} from './assistant-reporting'

/** The model's user-facing result, separated from any surrounding draft text. */
const RESULT_TAGS = ['assistant_result', 'assistant_detail'] as const
export const ASSISTANT_INVALID_RESULT = 'I could not produce a clean update. Please retry this run.'

/** Lowercased every way the app knows to write one bracket: the stored id and its label. */
function bracketTokens(ids: ReadonlyArray<string>, labels: ReadonlyArray<string>): Set<string> {
  return new Set([...ids, ...labels].map((token) => token.toLowerCase()))
}

const TIMELINESS_TOKENS = bracketTokens(
  ASSISTANT_TIMELINESS_IDS,
  ASSISTANT_TIMELINESS_OPTIONS.map((option) => option.label)
)
const IMPACT_TOKENS = bracketTokens(
  ASSISTANT_IMPACT_IDS,
  ASSISTANT_IMPACT_OPTIONS.map((option) => option.label)
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Longest first, so `this-week` is preferred over `week` in a single match. */
function tokenAlternation(tokens: Set<string>): string {
  return [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
}

/**
 * A leading urgency tag the run was never supposed to write, e.g.
 * `[whenever · just-me]`. The contract gives urgency as the run's own guidance
 * and forbids it in the message, so the model should not emit one; when an older
 * or over-eager model still does, the tag is dropped rather than shown to the
 * user. Only a bracket or parenthesis at the very start, holding exactly the two
 * known brackets, is removed.
 */
const URGENCY_TAG_PREFIX = new RegExp(
  `^\\s*[\\[(]\\s*(?:${tokenAlternation(TIMELINESS_TOKENS)})\\s*(?:\\u00b7|[|,;/:-])\\s*(?:${tokenAlternation(IMPACT_TOKENS)})\\s*[\\])]\\s*`,
  'iu'
)

function stripUrgencyTag(text: string): string {
  return text.replace(URGENCY_TAG_PREFIX, '')
}

/** Count only far enough to decide whether the default brief result fits. */
function exceedsBriefLimit(text: string): boolean {
  const words = /\S+/gu
  let count = 0
  while (words.exec(text) !== null) {
    if (++count > 80) return true
  }
  return false
}

/**
 * Keep explicit final results, never the draft around them. Existing unmarked
 * reports remain readable, except recognizable drafting instructions. A result
 * accepts end-of-message as a closing boundary. Streaming
 * stays silent until a result opens, so partial internal text cannot flash in
 * the answer before its delimiter arrives. The original transcript is unchanged.
 */
export function assistantResultText(raw: string, streaming = false): string {
  let opening = -1
  let selected: (typeof RESULT_TAGS)[number] = 'assistant_result'
  for (const tag of RESULT_TAGS) {
    const at = raw.lastIndexOf(`<${tag}>`)
    if (at > opening) {
      opening = at
      selected = tag
    }
  }
  if (opening >= 0) {
    const start = opening + selected.length + 2
    const end = raw.indexOf(`</${selected}>`, start)
    let result = raw.slice(start, end < 0 ? undefined : end).trim()
    // A closer can be split across streamed deltas. Never show its fragment.
    if (end < 0) {
      const partial = result.lastIndexOf('<')
      if (partial >= 0 && `</${selected}>`.startsWith(result.slice(partial)))
        result = result.slice(0, partial).trimEnd()
    }
    result = stripUrgencyTag(result)
    if (!result && !streaming) return ASSISTANT_INVALID_RESULT
    if (selected === 'assistant_result' && exceedsBriefLimit(result))
      return streaming ? '' : ASSISTANT_INVALID_RESULT
    return result
  }
  if (streaming) return ''
  if (/<\/?assistant_(?:result|detail)\b/iu.test(raw)) return ASSISTANT_INVALID_RESULT
  if (/^(?:Now write the report\.|The user wants|Let me (?:think|draft)|Draft:)/imu.test(raw))
    return ASSISTANT_INVALID_RESULT
  return stripUrgencyTag(raw.trim())
}
