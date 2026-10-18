/** Bound both the indexed candidate lookup and the in-memory typo comparison. */
function queryWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32)
}

/** Keep all concepts in the FTS query, relaxing only the end of longer words. */
export function evidenceFtsQuery(query: string): string {
  return queryWords(query)
    .map((word) => `"${word.length >= 5 ? word.slice(0, 3) : word}"*`)
    .join(' ')
}

function matchesWord(query: string, word: string): boolean {
  if (word.startsWith(query)) return true
  if (query.length < 5 || query.length > 64 || word.length > 64) return false
  if (Math.abs(query.length - word.length) > 1) return false
  let left = 0
  let right = 0
  let edits = 0
  while (left < query.length && right < word.length) {
    if (query[left] === word[right]) {
      left++
      right++
      continue
    }
    if (++edits > 1) return false
    if (query.length >= word.length) left++
    if (word.length >= query.length) right++
  }
  return edits + Number(left < query.length || right < word.length) <= 1
}

/** Broad prefix candidates count only when every original concept is present. */
export function hasQueryEvidence(query: string, text: string): boolean {
  const terms = queryWords(query)
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return terms.length > 0 && terms.every((term) => words.some((word) => matchesWord(term, word)))
}
