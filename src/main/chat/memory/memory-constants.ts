import { join } from 'path'

export const MEMORY_FILENAME = 'memory.md'
export const PROPOSALS_FILENAME = 'memory-proposals.json'
export const DEFERRED_EXTRACTIONS_FILENAME = 'memory-deferred-extractions.json'
export const ENTRY_MARKER = '<!-- codeinoven-memory-entry -->'
export const MEMORY_DIR = 'memory'
export const MEMORY_PROJECTS_DIR = join(MEMORY_DIR, 'projects')
export const MEMORY_CHATS_DIR = join(MEMORY_DIR, 'chats')
export const THREADS_DIR = 'threads'

export const MEMORY_LIMITS = {
  maxEntries: 50,
  maxLabelCharacters: 80,
  maxEntryCharacters: 4_096,
  maxAggregateCharacters: 24_576,
  maxProposals: 20,
  proposalExpiryMs: 7 * 24 * 60 * 60 * 1000
} as const

/** Bounds for the deferred-extraction retry queue so it can never grow unbounded. */
export const MEMORY_DEFERRED_EXTRACTION_LIMITS = {
  maxEntries: 20,
  maxAttempts: 5,
  expiryMs: 7 * 24 * 60 * 60 * 1000
} as const

/**
 * Bounds for auxiliary (deterministic + cheap-model) memory extraction so a
 * turn can never resend the full user/assistant transcript to a second model
 * session. These satisfy the A-06 acceptance: local caps, deduplication,
 * debounce, and a separately configurable cheap-model token budget.
 * `maxPreviousUserCharacters` bounds the user's earlier message that the
 * decision needs as supporting context.
 */
export const MEMORY_EXTRACTION_LIMITS = {
  maxUserCandidateCharacters: 2_000,
  maxAssistantCandidateCharacters: 8_000,
  maxPreviousUserCharacters: 800,
  maxCandidates: 3,
  debounceMs: 60_000,
  maxExtractionsPerWindow: 3,
  extractionWindowMs: 10 * 60 * 1000,
  cheapModelTokenBudget: 4_096
} as const
