/** Bound both the indexed candidate lookup and the in-memory typo comparison. */
function queryWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 32)
}

/**
 * Words that carry no concept of their own.
 *
 * A query an agent writes is a sentence ("find where we grouped the classroom env
 * variables into defaults"), not a bag of search terms, so the function words
 * have to leave before matching: counted as concepts they lowered the coverage of
 * a passage that answered the question, and in an all-terms query one of them was
 * enough to make the whole query match nothing.
 */
const FILLER_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'before',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'up',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
])

/**
 * The concepts a query asks about: its words with the filler removed.
 *
 * A query made only of filler words still searches for them, because dropping
 * every word would answer a question with nothing.
 */
export function queryConcepts(text: string): string[] {
  const words = queryWords(text)
  const meaningful = words.filter((word) => !FILLER_WORDS.has(word))
  return meaningful.length > 0 ? meaningful : words
}

/** One FTS5 prefix term, relaxed only at the end of longer words. */
function conceptTerm(word: string): string {
  return `"${word.length >= 5 ? word.slice(0, 3) : word}"*`
}

/** Keep all concepts in the FTS query, relaxing only the end of longer words. */
export function evidenceFtsQuery(query: string): string {
  return queryConcepts(query).map(conceptTerm).join(' ')
}

/**
 * The same concepts as an FTS query that accepts any of them.
 *
 * Every concept required at once is what made a sentence-length query answer
 * nothing: no single passage holds all twelve words an agent typed, so the
 * index returned no row at all. Ranking by how many concepts a passage does
 * carry, and requiring a majority, keeps precision without demanding a query
 * written as a search box would write it.
 */
export function evidenceAnyFtsQuery(query: string): string {
  return queryConcepts(query).map(conceptTerm).join(' OR ')
}

/** How many concepts a passage must carry to count as evidence for a query. */
export function requiredEvidenceConcepts(conceptCount: number): number {
  if (conceptCount <= 3) return Math.max(1, conceptCount)
  // A sentence carries words a passage need not repeat verbatim ("usable",
  // "format") next to the ones it must ("classroom", "defaults"). Requiring a
  // majority of them called the passage that answered the question unmatching;
  // two fifths plus ranking by coverage keeps the answer while still rejecting
  // a passage that shares almost nothing with the question.
  return Math.max(2, Math.ceil(conceptCount * 0.4))
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

/** How many of the query's concepts a passage carries. */
export function queryConceptCoverage(query: string, text: string): number {
  const terms = queryConcepts(query)
  if (terms.length === 0) return 0
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return terms.filter((term) => words.some((word) => matchesWord(term, word))).length
}

/** Broad prefix candidates count only when every original concept is present. */
export function hasQueryEvidence(query: string, text: string): boolean {
  const terms = queryConcepts(query)
  return terms.length > 0 && queryConceptCoverage(query, text) === terms.length
}
