/**
 * What a harness reports when the app itself stopped a run.
 *
 * A stop is not a failure. The app already models the difference everywhere the
 * user sees it (`AgentToolStatus` keeps `aborted` apart from `error`), but the
 * harness reports a stopped run as an assistant completion carrying an abort
 * message, and that text reaches the transcript as the turn's `error`. Left
 * there it paints an error card over a run the user (or a cross-instance
 * transfer) stopped on purpose, and a stopped worker's card reads as a failed
 * worker. The engine asks this module instead: when the app is the one that
 * stopped the session, the harness's abort text is not evidence of anything.
 */

/**
 * Provider text that means "this run was aborted", not "this run failed".
 *
 * Deliberately a closed set: a provider that fails with a message of its own
 * must keep that message, so nothing is matched by substring or by shape.
 */
const ABORTED_RUN_ERRORS = new Set([
  'request aborted',
  'this operation was aborted',
  'the operation was aborted',
  'operation aborted',
  'aborted',
  'agent run stopped by user',
  'agent run stopped'
])

/** Whether a harness error is only the abort of a run the app stopped. */
export function isAbortedRunError(error: string | undefined): boolean {
  if (!error) return false
  const text = error
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, '')
  return ABORTED_RUN_ERRORS.has(text)
}

/**
 * Drop the abort text a deliberate stop left on a turn's messages.
 *
 * Mutates the caller's copies before they are persisted, and returns how many
 * messages it cleared, so a caller can log the difference instead of guessing.
 */
export function stripAbortedRunErrors(
  messages: readonly { role: string; error?: string }[]
): number {
  let cleared = 0
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (!isAbortedRunError(message.error)) continue
    delete message.error
    cleared += 1
  }
  return cleared
}
