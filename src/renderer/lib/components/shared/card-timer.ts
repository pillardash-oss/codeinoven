/**
 * Shared countdown rendering for the human-decision cards.
 *
 * A question card and a secret card both run the same configurable timer
 * (`questionTimeoutMs`), so they must show the same countdown in the same
 * format; the formatting lives here rather than in either card.
 */

/** Remaining time as `m:ss` above a minute, whole seconds below it. */
export function formatRemaining(milliseconds: number): string {
  const seconds = Math.ceil(milliseconds / 1_000)
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${seconds}s`
}
