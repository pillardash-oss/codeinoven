import type { ThreadSearchResult } from '../types'
import { queryConceptCoverage } from './query-evidence'

/** Coverage per thread, computed once per result set. */
function coverageScores(
  results: readonly ThreadSearchResult[],
  raw: string
): (result: ThreadSearchResult) => number {
  // One thread can arrive twice with different excerpts (a short full-text
  // snippet and the long evidence excerpt), so the score is measured on the
  // richest text the thread brought.
  const bestText = new Map<string, string>()
  for (const result of results) {
    const text = `${result.thread.title}\n${result.snippet ?? ''}`
    const previous = bestText.get(result.thread.id)
    if (previous === undefined || text.length > previous.length) {
      bestText.set(result.thread.id, text)
    }
  }
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
 * Rank in three passes:
 *
 * 1. title matches, in keyword order,
 * 2. semantic matches, in the provider's similarity order,
 * 3. the remaining keyword matches, best title then message coverage first.
 *
 * Semantic search is additive: it never drops a full-text match. Above the
 * keyword half it is the stronger ranker, because a passage that means the same
 * thing beats one that repeats a word, and the model reads the whole thread
 * window where full text only sees a message. Below a title match it is not: a
 * thread whose title names the query still opens the list.
 *
 * An earlier attempt promoted keyword rows that carried every query concept
 * above the semantic half, which failed on common words: any long excerpt with
 * "computer", "use" and "cua" somewhere outranked the one thread that is about
 * CUA. Title coverage is the signal strong enough to lead; everything else waits
 * for the model.
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
  for (const result of intent) push(result)
  if (raw.trim().length === 0) {
    for (const result of keyword) {
      if (result.kind !== 'title') push(result)
    }
    return merged.slice(0, Math.max(1, limit))
  }

  const coverageOf = coverageScores(keyword, raw)
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
    .filter((result) => result.kind !== 'title')
    .sort(
      (left, right) =>
        titleCoverageOf(right) - titleCoverageOf(left) || coverageOf(right) - coverageOf(left)
    )
  for (const result of rest) push(result)
  return merged.slice(0, Math.max(1, limit))
}
