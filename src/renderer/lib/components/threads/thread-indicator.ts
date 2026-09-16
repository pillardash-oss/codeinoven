/**
 * The single indicator slot a thread row can show. Speech and computer use
 * compete for it, and exactly one of them wins.
 */
export type ThreadIndicator = 'recording' | 'speaking' | 'transcribing' | 'computer-use'

export interface ThreadIndicatorCandidate {
  indicator: ThreadIndicator
  /** Wall-clock time the action this candidate represents began. */
  at: number
}

/**
 * Pick the row's indicator under the app's "last action wins" rule: the
 * candidate whose action began most recently takes the slot.
 *
 * Order carries meaning. Candidates are supplied from the most to the least
 * preferred, and an identical `at` keeps the earlier candidate, which preserves
 * the speech precedence that already governs the slot (listening, then
 * speaking, then transcribing) when two actions share a timestamp.
 */
export function resolveThreadIndicator(
  candidates: readonly ThreadIndicatorCandidate[]
): ThreadIndicator | null {
  let winner: ThreadIndicatorCandidate | null = null
  for (const candidate of candidates) {
    if (winner === null || candidate.at > winner.at) winner = candidate
  }
  return winner?.indicator ?? null
}
