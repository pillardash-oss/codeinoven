/**
 * Bound a promise that is allowed to answer late, or not at all.
 *
 * Several of the app's gates sit between a click and the thing the click asked
 * for, and every one of them is answered by something outside this process: a
 * database worker, an SSH probe of another machine, a platform service. A gate
 * that never answers must not become a gate that never opens, so a caller with a
 * fallback answer races its own work against a deadline and takes the fallback.
 *
 * The timer is always cleared, so a fast answer costs nothing, and the dropped
 * promise is left to settle on its own: attaching a rejection handler keeps a
 * late failure from surfacing as an unhandled rejection in a caller that has
 * already moved on.
 */

/** Sentinel meaning the work did not finish in time. */
export const DEADLINE_EXCEEDED = Symbol('deadline-exceeded')

export type DeadlineResult<T> = T | typeof DEADLINE_EXCEEDED

/**
 * The work's own result, or `DEADLINE_EXCEEDED` when it did not land in time.
 *
 * A rejection passes straight through: a caller that can handle a failure
 * differently from a timeout still can.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<DeadlineResult<T>> {
  if (!(timeoutMs > 0)) return DEADLINE_EXCEEDED
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), timeoutMs)
    timer.unref?.()
  })
  // A late rejection has nobody left to reject, so it is absorbed here.
  work.catch(() => undefined)
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
