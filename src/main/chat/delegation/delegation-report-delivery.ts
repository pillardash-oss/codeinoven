import { Logger } from '../../system/logger'
import { sleepWithoutHoldingProcess } from './delegation-report-grace'

/**
 * How many times a delegated run's report is handed to the waiting thread.
 *
 * A report is the only thing that tells a parent its pawn or dispatched run has
 * finished, so a delivery that fails once cannot simply be logged away: the
 * work exists, the parent never hears about it, and the thread sits waiting for
 * a message that was thrown out. The failures this retries are the transient
 * kind   a session that is still settling, a harness call that lost its race
 * with the turn that just ended   and a later attempt either steers the live
 * turn or starts the next one.
 */
export const DELEGATION_REPORT_DELIVERY_ATTEMPTS = 4

/** How long to wait between two attempts, doubling up to this cap. */
export const DELEGATION_REPORT_DELIVERY_DELAY_MS = 5_000

export interface DelegationReportDeliveryOptions {
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Called with each rejected attempt, so a caller can record what it saw. */
  onFailure?: (error: unknown, attempt: number) => void
}

/**
 * Deliver a delegated report, retrying while the target session is not ready.
 *
 * Resolves with what the sender returned. Throws the last failure once every
 * attempt is spent, so a caller that truly cannot deliver still says so rather
 * than pretending the report landed.
 */
export async function deliverDelegationReport<T>(
  send: () => Promise<T>,
  options: DelegationReportDeliveryOptions = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DELEGATION_REPORT_DELIVERY_ATTEMPTS)
  const sleep = options.sleep ?? sleepWithoutHoldingProcess
  let delay = options.delayMs ?? DELEGATION_REPORT_DELIVERY_DELAY_MS
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await send()
    } catch (error) {
      lastError = error
      options.onFailure?.(error, attempt)
      if (attempt === attempts) break
      Logger.dev('Delegation report delivery failed, retrying:', {
        attempt,
        attempts,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error)
      })
      await sleep(delay)
      // Back off, so a session that needs a whole turn to settle is not hammered
      // with the same report every few seconds.
      delay = Math.min(delay * 2, DELEGATION_REPORT_DELIVERY_DELAY_MS * 8)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
