import { Logger } from './logger'

/**
 * One failure condition this process is watching, and how it has behaved so far.
 */
interface FailureIncident {
  /** Signature of the cause, so a changed cause reports itself as a new incident. */
  signature: string
  /** How many times the condition has failed since it started failing. */
  count: number
  /** When the condition started failing. */
  firstAt: number
  /** When the durable log last carried an error for this incident. */
  lastEscalatedAt: number
}

export interface RepeatedFailureLogOptions {
  /**
   * How long one incident may keep failing before it is escalated back to
   * `Logger.error` for a single reminder. Defaults to six hours, which keeps a
   * condition that never clears visible in `logs/<day>/error.log` without
   * rewriting that file on every poll.
   */
  reEscalateAfterMs?: number
}

/** Six hours: four reminders a day at most for a condition that never clears. */
const DEFAULT_RE_ESCALATE_AFTER_MS = 6 * 60 * 60 * 1000

/**
 * Incidents live here rather than on the caller, because the same condition is
 * often watched from several places in one process (every `SecretVault` instance
 * reads the same ref). One label, one incident, one durable error line.
 */
const incidents = new Map<string, FailureIncident>()

/**
 * Report a failure of a condition that may be checked again and again.
 *
 * A status poll, a sidebar mount, or a health probe runs on a timer, so a
 * condition that persists (an unreadable credential, an unreachable service)
 * otherwise writes the same error hundreds of times a day and buries the
 * incidents that need attention behind its own noise. This policy keeps the
 * durable sinks honest instead:
 *
 * - the first failure of an incident is a `Logger.error` carrying the full cause,
 * - every later failure of that incident is a `Logger.dev` line naming the repeat
 *   count and how long it has been failing, so the detail is still there for a
 *   developer reading `debug.log`,
 * - an incident that keeps failing past `reEscalateAfterMs` returns to
 *   `Logger.error` once per interval, so a condition that never clears cannot go
 *   quiet forever,
 * - `clearRepeatedFailure` closes it with one informational line when the
 *   condition stops failing.
 *
 * A different cause under the same label starts a new incident, and reports itself
 * at error level immediately: two different faults are two different incidents.
 *
 * Consumers repeat the line for the user-facing half of the problem; this is only
 * the logging half. In particular never swallow the failure because it was logged
 * here: a caller still has to decide what its own state becomes.
 */
export function reportRepeatedFailure(
  label: string,
  failure: unknown,
  options: RepeatedFailureLogOptions = {}
): void {
  const now = Date.now()
  const signature = failureSignature(failure)
  const existing = incidents.get(label)

  if (!existing || existing.signature !== signature) {
    incidents.set(label, { signature, count: 1, firstAt: now, lastEscalatedAt: now })
    Logger.error(label, failure)
    return
  }

  existing.count += 1
  const reEscalateAfterMs = options.reEscalateAfterMs ?? DEFAULT_RE_ESCALATE_AFTER_MS
  const repeats = existing.count - 1
  if (now - existing.lastEscalatedAt >= reEscalateAfterMs) {
    existing.lastEscalatedAt = now
    Logger.error(
      `${label} (still failing after ${describeDuration(now - existing.firstAt)}, ${repeats} times)`,
      failure
    )
    return
  }

  Logger.dev(`${label} (repeat ${repeats} of a failure already reported at error level)`, failure)
}

/**
 * Close the incident under a label after the operation succeeded, so the next
 * failure is reported at error level again and the log carries one line saying
 * the fault is over.
 */
export function clearRepeatedFailure(label: string): void {
  const existing = incidents.get(label)
  if (!existing) return
  incidents.delete(label)
  Logger.info(`${label} recovered`, {
    failures: existing.count,
    lastedMs: Date.now() - existing.firstAt
  })
}

/** A stable signature of what failed, so a changed cause is a new incident. */
function failureSignature(failure: unknown): string {
  if (failure instanceof Error) return `${failure.name}: ${failure.message}`
  return String(failure)
}

/** Readable duration for an escalation line: minutes, then hours, then days. */
function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
