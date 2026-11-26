import { isThreadBusyStatus } from '../../../lib/thread-status-policy'
import type { ThreadStatus } from '../../../lib/types'

/**
 * How long a delegated run may sit in a non-done state before its outcome is
 * reported back to whoever asked for it.
 *
 * A provider limit, a dropped socket or a 503 is usually over in seconds: the
 * harness reports a retryable failure, and the app's own retry policy parks the
 * thread on `working-paused` and resumes it. Reporting that first failure the
 * instant it lands is what told a parent "all four pawns stopped on a 429" while
 * the same four were already running again, and it hands the user a conclusion
 * they then have to un-believe.
 *
 * So a run that does not come back `completed` is reported only after it has had
 * this long to fix itself, and only if it is still not working then. `completed`
 * is reported at once: there is nothing left to recover from.
 */
export const DELEGATION_REPORT_GRACE_MS = 60_000

/** What to do with a settled delegated run once the grace window is over. */
export type DelegationReportVerdict =
  /** The run is working again (a retry owns it); its own settle will report. */
  | { report: false; status: ThreadStatus }
  /** Report this status now. */
  | { report: true; status: ThreadStatus }

/** Sleep without keeping the process alive on its own. */
export function sleepWithoutHoldingProcess(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Decide whether a settled run's outcome is worth reporting.
 *
 * The status is re-read after the grace window rather than trusted from the
 * settle that scheduled this check, because that is exactly the fact that may
 * have changed: a `working-paused` retry that finished, or one that is still
 * waiting. A thread that disappeared while we waited is reported with the
 * status we already had, since somebody asked for that work and the answer has
 * to land somewhere.
 */
export async function awaitDelegationOutcome(
  initialStatus: ThreadStatus,
  readStatus: () => Promise<ThreadStatus | null>,
  options: {
    graceMs?: number
    sleep?: (ms: number) => Promise<void>
    /**
     * Whether the app still has a retry queued for this run's session.
     *
     * A provider failure parks a thread on `failed` and schedules its resume a
     * little later, so the status alone can say "failed" while the run is
     * already on its way back. Reporting then tells the parent its work died
     * moments before the retry finishes it, and nothing is left watching the
     * recovered turn. Read at the end of the window, because a retry that
     * finished inside it is no longer pending.
     */
    isRetryPending?: () => boolean
  } = {}
): Promise<DelegationReportVerdict> {
  if (initialStatus === 'completed') return { report: true, status: initialStatus }
  const graceMs = options.graceMs ?? DELEGATION_REPORT_GRACE_MS
  await (options.sleep ?? sleepWithoutHoldingProcess)(graceMs)
  const status = await readStatus()
  if (status === null) return { report: true, status: initialStatus }
  if (isThreadBusyStatus(status)) return { report: false, status }
  if (options.isRetryPending?.() === true) return { report: false, status }
  return { report: true, status }
}
