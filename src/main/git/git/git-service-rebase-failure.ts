/**
 * How much of git's own output a failed rebase step keeps in the error log. The
 * reason the sequencer refused is its last words, while the summary of every
 * commit it replayed comes first, so the tail is the part worth keeping and the
 * whole thing would bury the log line.
 */
const REBASE_FAILURE_LOG_CHARS = 2000

/**
 * The tail of git's own output for a rebase step git could not move, for the
 * error log. A rebase prints a summary for every commit it replayed before the
 * lines that say why it stopped, so this reads from the end and never hands the
 * panel the wall of output it would have to render as a message.
 */
export function rebaseFailureDetail(failure: unknown): string {
  const text = failure instanceof Error ? failure.message : String(failure)
  return text.length > REBASE_FAILURE_LOG_CHARS
    ? `...${text.slice(-REBASE_FAILURE_LOG_CHARS)}`
    : text
}
