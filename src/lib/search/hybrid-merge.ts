import type { ThreadSearchResult } from '../types'

/**
 * Merge keyword (title + FTS) results with semantic (intent) results into one
 * ordered list, deduped by thread.
 *
 * Rank in three passes, which is the order the Search settings page promises the
 * user ("Title matches stay first, semantic matches follow, keyword-only finds
 * come last"):
 *
 * 1. title matches, in keyword order,
 * 2. semantic matches, in the provider's similarity order,
 * 3. the remaining keyword (message) matches, in keyword order.
 *
 * Semantic search is additive: it only ever adds threads the keyword pass did
 * not already rank, so a full-text match is never dropped, only ordered below a
 * meaning-based one. Passing every keyword result first instead buried semantic
 * matches under every message match, which made intent search invisible in a
 * list that is capped at the requested limit.
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
