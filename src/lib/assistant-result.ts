/** The model's user-facing result, separated from any surrounding draft text. */
const RESULT_TAGS = ['assistant_result', 'assistant_detail'] as const
export const ASSISTANT_INVALID_RESULT = 'I could not produce a clean update. Please retry this run.'

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
    if (!result && !streaming) return ASSISTANT_INVALID_RESULT
    if (selected === 'assistant_result' && exceedsBriefLimit(result))
      return streaming ? '' : ASSISTANT_INVALID_RESULT
    return result
  }
  if (streaming) return ''
  if (/<\/?assistant_(?:result|detail)\b/iu.test(raw)) return ASSISTANT_INVALID_RESULT
  if (/^(?:Now write the report\.|The user wants|Let me (?:think|draft)|Draft:)/imu.test(raw))
    return ASSISTANT_INVALID_RESULT
  return raw.trim()
}
