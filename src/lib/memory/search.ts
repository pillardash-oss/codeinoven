import type { MemoryCategory, MemoryEntry, MemoryPriority, MemoryScope } from '../types'

export interface SearchFilters {
  category?: MemoryCategory
  priority?: MemoryPriority
  scope?: MemoryScope
  projectId?: string
  enabledOnly?: boolean
}

export interface SearchResult {
  entry: MemoryEntry
  score: number
  matchedFields: string[]
}

/**
 * Search memory entries with scoring based on relevance.
 * Higher scores indicate better matches.
 */
export function searchEntries(
  entries: MemoryEntry[],
  query: string,
  filters: SearchFilters = {}
): SearchResult[] {
  const lowerQuery = query.toLowerCase()
  const results: SearchResult[] = []

  for (const entry of entries) {
    if (filters.enabledOnly !== false && !entry.enabled) continue
    if (filters.category && entry.category !== filters.category) continue
    if (filters.priority && entry.priority !== filters.priority) continue
    if (filters.scope && entry.scope !== filters.scope) continue
    if (filters.projectId && entry.projectId !== filters.projectId) continue

    const { score, matchedFields } = scoreEntry(entry, lowerQuery)
    if (score > 0) {
      results.push({ entry, score, matchedFields })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

function scoreEntry(entry: MemoryEntry, lowerQuery: string): { score: number; matchedFields: string[] } {
  let score = 0
  const matchedFields: string[] = []

  if (!lowerQuery) {
    return { score: 1, matchedFields: ['all'] }
  }

  const labelLower = entry.label.toLowerCase()
  const contentLower = entry.content.toLowerCase()

  if (labelLower === lowerQuery) {
    score += 100
    matchedFields.push('label:exact')
  } else if (labelLower.includes(lowerQuery)) {
    score += 50
    matchedFields.push('label:contains')
  }

  if (contentLower.includes(lowerQuery)) {
    score += 30
    matchedFields.push('content:contains')
  }

  const queryWords = lowerQuery.split(/\s+/)
  for (const word of queryWords) {
    if (word.length < 2) continue
    if (labelLower.includes(word)) score += 10
    if (contentLower.includes(word)) score += 5
  }

  if (entry.priority === 'critical') score += 5
  else if (entry.priority === 'high') score += 3

  if (entry.frequency > 5) score += 5
  else if (entry.frequency > 2) score += 2

  return { score, matchedFields }
}

/**
 * Filter entries by multiple criteria.
 */
export function filterEntries(entries: MemoryEntry[], filters: SearchFilters): MemoryEntry[] {
  return entries.filter((entry) => {
    if (filters.enabledOnly !== false && !entry.enabled) return false
    if (filters.category && entry.category !== filters.category) return false
    if (filters.priority && entry.priority !== filters.priority) return false
    if (filters.scope && entry.scope !== filters.scope) return false
    if (filters.projectId && entry.projectId !== filters.projectId) return false
    return true
  })
}

/**
 * Format search results for display.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No matching memory entries found.'

  const lines: string[] = [`Found ${results.length} matching ${results.length === 1 ? 'entry' : 'entries'}:`]
  for (const result of results) {
    const { entry, score, matchedFields } = result
    lines.push(
      `- **${entry.label}** (${entry.category}, ${entry.priority}) — ${matchedFields.join(', ')} [score: ${score}]`,
      `  ${entry.content.slice(0, 100)}${entry.content.length > 100 ? '...' : ''}`
    )
  }
  return lines.join('\n')
}
