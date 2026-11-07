/**
 * Trim an oversized provider log payload without corrupting it.
 *
 * Coolify hands a deployment log back as a JSON-encoded array of entries. A
 * blind character slice leaves a half-written entry behind, so the payload no
 * longer parses and the renderer can only dump the whole raw JSON as text.
 * When the payload has that array shape the newest entries are kept instead,
 * cut on an element boundary: a failed build explains itself at the end of the
 * log. Anything else is plain text and keeps its leading characters.
 */

/** Characters kept from a provider log before it is trimmed. */
export const MAX_DEPLOYMENT_LOG_CHARACTERS = 200_000

export function capDeploymentLogPayload(
  payload: string,
  cap: number = MAX_DEPLOYMENT_LOG_CHARACTERS
): string {
  if (payload.length <= cap) return payload
  if (payload.startsWith('[')) {
    const start = firstElementStartWithinTail(payload, cap)
    if (start !== null) return `[${payload.slice(start)}`
  }
  return payload.slice(0, cap)
}

/**
 * Index of the first top-level array element whose suffix still fits under
 * `cap` once the array is re-opened with a leading `[`, or null when no single
 * element fits (a lone oversized entry) or the array is empty.
 */
function firstElementStartWithinTail(payload: string, cap: number): number | null {
  const smallestFittingStart = payload.length - cap + 1
  let depth = 0
  let inString = false
  let escaped = false
  /** True immediately after the opening bracket or an element-separating comma. */
  let expectElement = true

  for (let index = 1; index < payload.length; index += 1) {
    const char = payload[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (depth === 0) {
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue
      if (expectElement) {
        if (char === ']') return null
        if (index >= smallestFittingStart) return index
        expectElement = false
      }
      if (char === ',') {
        expectElement = true
        continue
      }
      if (char === '{' || char === '[') depth += 1
      continue
    }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
  }
  return null
}
