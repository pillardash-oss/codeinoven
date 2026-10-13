import type { ThreadSearchResult } from '../types'

/**
 * Merge keyword (title + FTS) results with semantic (intent) results into one
 * ordered list, deduped by thread.
 *
 * Preserve every keyword result's order and snippet. Semantic matches fill
 * remaining space, so enabling intent cannot demote or displace a full-text
 * match. A thread found by both signals keeps its keyword result.
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
  for (const result of keyword) push(result)
  for (const result of intent) push(result)
  return merged.slice(0, Math.max(1, limit))
}
