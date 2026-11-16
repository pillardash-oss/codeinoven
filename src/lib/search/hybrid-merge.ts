import type { ThreadSearchResult } from '../types'
import { queryConceptCoverage, queryConcepts } from './query-evidence'

/**
 * The richest text each thread brought to the result set.
 *
 * One thread can arrive twice with different excerpts (a short full-text
 * snippet and the long evidence excerpt), so both the coverage score and the
 * literal check read the longest one.
 */
function bestTextByThread(results: readonly ThreadSearchResult[]): Map<string, string> {
  const bestText = new Map<string, string>()
  for (const result of results) {
    const text = `${result.thread.title}\n${result.snippet ?? ''}`
    const previous = bestText.get(result.thread.id)
    if (previous === undefined || text.length > previous.length) {
      bestText.set(result.thread.id, text)
    }
  }
  return bestText
}

/** Coverage per thread, computed once per result set. */
function coverageScores(
  results: readonly ThreadSearchResult[],
  raw: string,
  bestText = bestTextByThread(results)
): (result: ThreadSearchResult) => number {
  const scores = new Map<string, number>()
  return (result) => {
    const cached = scores.get(result.thread.id)
    if (cached !== undefined) return cached
    const score = queryConceptCoverage(raw, bestText.get(result.thread.id) ?? result.thread.title)
    scores.set(result.thread.id, score)
    return score
  }
}

/** Keep one row per thread, with a title match winning over a message one. */
function dedupeByThread(results: readonly ThreadSearchResult[]): ThreadSearchResult[] {
  const byId = new Map<string, ThreadSearchResult>()
  for (const result of results) {
    const existingById = byId.get(result.thread.id)
    if (existingById === undefined) {
      byId.set(result.thread.id, result)
      continue
    }
    if (result.kind === 'title' && existingById.kind !== 'title') {
      byId.set(result.thread.id, result)
    }
  }
  return [...byId.values()]
}

/** Lowercased words of a text, the way the query concepts are tokenized. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Whether a row carries the query literally, in the text it matched.
 *
 * Meaning-based ranking answers what a passage is about; it cannot answer a
 * name. A rare word like "amebo" sits in an embedding space with no neighbour
 * to score against, so every thread lands within a hair of every other and the
 * model's order becomes arbitrary - which is exactly how unrelated threads end
 * up above the one conversation that says the word twenty times.
 *
 * Literal evidence is decisive in the two cases where it cannot be incidental:
 * the whole query appears as a contiguous phrase, or the query is a single
 * concept and that word is in the row verbatim. Both are checked against the
 * matched excerpt, not the whole transcript, so a long message that happens to
 * mention every common word of a sentence-shaped query is not promoted for it.
 */
function isLiteralMatch(raw: string, text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const phrase = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normalized || !phrase) return false
  if (normalized.includes(phrase)) return true
  const concepts = queryConcepts(raw)
  const [concept] = concepts
  if (concepts.length !== 1 || concept === undefined) return false
  return wordsOf(normalized).includes(concept)
}

/**
 * Rank one body of matches without the model: a title match first, then how much
 * of the query a thread's own title names, then how much of it a matched message
 * carries.
 *
 * This is the spotlight's first paint. Full-text ranking alone answered a
 * sentence-shaped query ("navigation happening outside the browser") with long
 * messages that happened to contain every token somewhere, while the threads
 * that actually discuss the subject sat behind them. The title is the strongest
 * short signal a thread has, and concept coverage is the part of ranking that
 * needs no embedding, so the rows the user sees before the model answers are
 * already the best keyword evidence available.
 */
export function rankThreadsByEvidence(
  results: readonly ThreadSearchResult[],
  raw: string,
  limit: number
): ThreadSearchResult[] {
  const ranked = dedupeByThread(results)
  const bodyCoverageOf = coverageScores(ranked, raw)
  const titleCoverage = new Map<string, number>()
  const titleCoverageOf = (result: ThreadSearchResult): number => {
    const cached = titleCoverage.get(result.thread.id)
    if (cached !== undefined) return cached
    const score = queryConceptCoverage(raw, result.thread.title)
    titleCoverage.set(result.thread.id, score)
    return score
  }
  const titleRank = (result: ThreadSearchResult): number => (result.kind === 'title' ? 0 : 1)
  // Array.prototype.sort is stable, so equal scores keep the incoming order (the
  // title ranking, then the full-text ranking behind it).
  ranked.sort(
    (left, right) =>
      titleRank(left) - titleRank(right) ||
      titleCoverageOf(right) - titleCoverageOf(left) ||
      bodyCoverageOf(right) - bodyCoverageOf(left)
  )
  return ranked.slice(0, Math.max(1, limit))
}

/**
 * Merge keyword matches with semantic matches into one ordered list.
 *
 * Rank in four passes:
 *
 * 1. title matches, in keyword order,
 * 2. keyword matches that carry the query literally, in keyword order,
 * 3. semantic matches, in the provider's similarity order,
 * 4. the remaining keyword matches, best title then message coverage first.
 *
 * Semantic search is additive: it never drops a full-text match. Above the
 * remaining keyword half it is the stronger ranker, because a passage that means
 * the same thing beats one that merely repeats a word, and the model reads the
 * whole thread window where full text only sees a message. It never leads
 * evidence the user typed verbatim (see {@link isLiteralMatch}). Below a title
 * match it is not: a thread whose title names the query still opens the list.
 *
 * An earlier attempt promoted keyword rows that carried every query concept
 * above the semantic half, which failed on common words: any long excerpt with
 * "computer", "use" and "cua" somewhere outranked the one thread that is about
 * CUA. That is why the promoted pass demands a contiguous phrase or a
 * single-concept query rather than concept coverage.
 *
 * Without `raw`, coverage is not computed and the merge keeps the plain title /
 * semantic / keyword order.
 */
export function mergeHybridThreadSearchResults(
  keyword: readonly ThreadSearchResult[],
  intent: readonly ThreadSearchResult[],
  limit: number,
  raw = ''
): ThreadSearchResult[] {
  const merged: ThreadSearchResult[] = []
  const seen = new Set<string>()
  const push = (result: ThreadSearchResult): void => {
    const id = result.thread.id
    if (seen.has(id)) return
    seen.add(id)
    merged.push(result)
  }
  for (const result of keyword) {
    if (result.kind === 'title') push(result)
  }
  const bestText = bestTextByThread(keyword)
  const literalOf = (result: ThreadSearchResult): boolean =>
    result.kind !== 'title' &&
    isLiteralMatch(raw, bestText.get(result.thread.id) ?? result.thread.title)
  // A thread that carries the query word for word outranks one the model only
  // related to it by meaning: exact evidence is what the reader typed, and for a
  // name or a rare term it is the only signal that means anything.
  for (const result of keyword) {
    if (literalOf(result)) push(result)
  }
  for (const result of intent) push(result)
  if (raw.trim().length === 0) {
    for (const result of keyword) {
      if (result.kind !== 'title') push(result)
    }
    return merged.slice(0, Math.max(1, limit))
  }

  const coverageOf = coverageScores(keyword, raw, bestText)
  const titleCoverage = new Map<string, number>()
  const titleCoverageOf = (result: ThreadSearchResult): number => {
    const cached = titleCoverage.get(result.thread.id)
    if (cached !== undefined) return cached
    const score = queryConceptCoverage(raw, result.thread.title)
    titleCoverage.set(result.thread.id, score)
    return score
  }
  // Stable sort keeps the full-text order between rows of equal evidence.
  const rest = keyword
    .filter((result) => result.kind !== 'title' && !literalOf(result))
    .sort(
      (left, right) =>
        titleCoverageOf(right) - titleCoverageOf(left) || coverageOf(right) - coverageOf(left)
    )
  for (const result of rest) push(result)
  return merged.slice(0, Math.max(1, limit))
}
