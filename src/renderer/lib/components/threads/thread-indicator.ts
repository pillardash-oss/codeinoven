/**
 * The single indicator slot a thread row can show. Speech, browser sound and
 * computer use compete for it, and exactly one of them wins.
 *
 * `transcribing-send` and `transcribing-steer` are the armed refinements of a
 * transcription in flight: the user has told the app how the transcript should
 * be delivered once it lands, so the row shows that intent rather than plain
 * processing.
 *
 * `browser-audio` is a browser tab of this thread playing sound. It is not a
 * speech action of the app's own, but it is still sound the user can hear coming
 * from a thread, so it takes the same slot and competes the same way: the mark
 * must say which thread is making the noise the user is hearing.
 */
export type ThreadIndicator =
  | 'recording'
  | 'speaking'
  | 'transcribing'
  | 'transcribing-send'
  | 'transcribing-steer'
  | 'computer-use'
  | 'browser-audio'

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
