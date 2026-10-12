import type { ThreadSearchResult } from '../types'

/**
 * Merge keyword (title + FTS) results with semantic (intent) results into one
 * ordered list, deduped by thread.
 *
 * Ranking intent, in order:
 * 1. Keyword **title** matches first, keeping their closeness order (exact >
 *    prefix > contains). A literal title hit is the strongest signal there is.
 * 2. Semantic matches next, in descending similarity. These carry the recall
 *    that keyword search misses, which is the whole point of enabling intent.
 * 3. Keyword **message** matches last, keeping their bm25 order.
 *
 * A thread surfaced by more than one signal keeps its strongest placement, so a
 * semantic hit never demotes a keyword title match. Pure and deterministic.
 */
export function mergeHybridThreadSearchResults(
  keyword: readonly ThreadSearchResult[],
  intent: readonly ThreadSearchResult[],
  limit: number
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
  for (const result of keyword) {
    if (result.kind !== 'title') push(result)
  }
  return merged.slice(0, Math.max(1, limit))
}
