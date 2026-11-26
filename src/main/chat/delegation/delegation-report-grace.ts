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

/**
 * How soon a queued retry has to arrive for a failure to still be a non-event.
 *
 * A provider failure parks the run on `failed` and schedules its resume. A
 * resume a minute away is the same event the grace window exists for: the run
 * continues and the failure was noise. A resume hours or days away (a usage
 * reset is often weeks out) is the opposite   holding that back leaves the
 * agent that asked for the work believing it is still running, for a day.
 */
export const DELEGATION_REPORT_RETRY_HORIZON_MS = 5 * 60_000

/** Whether a retry queued for `retryAt` arrives soon enough to wait quietly for. */
export function delegationRetryIsImminent(retryAt: number, now = Date.now()): boolean {
  return retryAt - now <= DELEGATION_REPORT_RETRY_HORIZON_MS
}

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
     * When the app will resume this run's session, if a retry is queued.
     *
     * A provider failure parks a thread and schedules its resume, so the status
     * alone cannot answer "will this run move again?". A resume seconds away is
     * the same event the grace window exists for: nothing is reported, because
     * the run is about to continue. A resume hours or days away is real news and
     * is reported now   silence there leaves the agent that asked for the work
     * believing it is still running until next week. Read at the end of the
     * window, since a retry that already finished is no longer pending.
     */
    retryAt?: () => number | undefined
  } = {}
): Promise<DelegationReportVerdict> {
  if (initialStatus === 'completed') return { report: true, status: initialStatus }
  const graceMs = options.graceMs ?? DELEGATION_REPORT_GRACE_MS
  await (options.sleep ?? sleepWithoutHoldingProcess)(graceMs)
  const status = await readStatus()
  if (status === null) return { report: true, status: initialStatus }
  const retryAt = options.retryAt?.()
  const retryArrivesSoon = retryAt !== undefined && delegationRetryIsImminent(retryAt)
  if (isThreadBusyStatus(status)) {
    // Parked on a retry that will not fire for hours or days: that is not the
    // run working, it is the run stopped with a date on it, and the parent is
    // told now instead of being left to guess.
    if (status === 'working-paused' && retryAt !== undefined && !retryArrivesSoon) {
      return { report: true, status }
    }
    return { report: false, status }
  }
  if (retryArrivesSoon) return { report: false, status }
  return { report: true, status }
}
