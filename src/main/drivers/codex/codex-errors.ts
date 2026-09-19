import type { AgentProviderIssue } from '../../../lib/types'
import { classifyProviderIssue, presentProviderError } from '../../../lib/provider-issue'
import { numberValue, recordValue, stringValue } from './codex-values'

/** Codex retry, usage-limit, and reset-time error classification. */

// `turn/started` fires the instant Codex's own retry loop begins its next
// attempt, before that attempt has round-tripped to the provider at all   it
// is not evidence the retry succeeded. Treating it as recovery flipped the UI
// to "working" moments before the same still-exhausted quota failed the
// attempt again, bouncing the thread between waiting and working. Only
// signals that necessarily follow a successful provider response (streamed
// content, completed items, plan updates) count as genuine recovery.
export function isCodexRetryRecoveryActivity(method: string): boolean {
  return (
    method === 'item/agentMessage/delta' ||
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta' ||
    method === 'item/reasoning/summaryPartAdded' ||
    method === 'item/started' ||
    method === 'item/completed' ||
    method === 'turn/plan/updated'
  )
}

export function codexRetryIssue(
  error: Record<string, unknown> | null,
  rawError: string
): AgentProviderIssue {
  const errorInfo = error?.['codexErrorInfo']
  const statusCode = codexErrorStatusCode(errorInfo)
  const kind = codexRetryIssueKind(errorInfo, rawError, statusCode)
  const messages: Partial<Record<AgentProviderIssue['kind'], string>> = {
    network: 'The Codex connection was interrupted. Codex is retrying automatically.',
    provider_unavailable: 'Codex is temporarily unavailable and is retrying automatically.',
    rate_limit: 'Codex is waiting before retrying the provider request.',
    quota: 'Codex is waiting before retrying the provider request.'
  }
  return {
    kind,
    message: messages[kind] ?? 'Codex is retrying the provider request.',
    rawError,
    harnessId: 'codex',
    retryable: true,
    ...(statusCode === undefined ? {} : { statusCode })
  }
}

/** Parse the concrete reset time Codex embeds in its usage-limit message,
 *  e.g. "…or try again at Aug 20th, 2026 7:30 AM." Tolerates an optional
 *  leading weekday ("…try again at Monday, Sep 7th, 2026 12:40 PM.") and
 *  "a.m./p.m." with periods, since a stricter match here silently falls
 *  through to a farther, unrelated reset window (see `scheduleAutomaticRetry`)
 *  instead of trusting the date the provider itself reported. Codex also emits
 *  a time-only variant for same-day resets ("…or try again at 9:30 AM.");
 *  that form resolves to the next occurrence of the time (today, or tomorrow
 *  once the time has already passed) so automatic retry stays schedulable. */
/** How recently a time-only reset may have expired and still count as
 *  propagation lag rather than a genuine next-day window (30 minutes). */
const USAGE_LIMIT_PROPAGATION_WINDOW_MS = 30 * 60 * 1000
/** Short cooldown used when a time-only reset expired within the lag window. */
const USAGE_LIMIT_PROPAGATION_COOLDOWN_MS = 5 * 60 * 1000

export function codexUsageLimitResetAt(message: string, now = Date.now()): number | undefined {
  const timeOnly = message.match(/\btry again at\s+(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)\b/iu)
  if (timeOnly) {
    const hour12 = Number(timeOnly[1])
    const minute = Number(timeOnly[2])
    if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return undefined
    const hour = (hour12 % 12) + (timeOnly[3].toLowerCase().startsWith('p') ? 12 : 0)
    const from = new Date(now)
    const reset = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hour, minute, 0, 0)
    if (reset.getTime() <= now) {
      // A reset that expired only moments ago is provider propagation lag, not
      // tomorrow's window: the auto-resume fires right at the reset second, the
      // still-limited provider re-reports the same time, and naively rolling to
      // tomorrow would park the thread a full day out (observed 2026-09-07:
      // resume at 2:30:02 PM re-failed at 2:30:10 PM). Retry after a short
      // cooldown instead; only a genuinely stale time rolls to tomorrow.
      if (now - reset.getTime() <= USAGE_LIMIT_PROPAGATION_WINDOW_MS) {
        return now + USAGE_LIMIT_PROPAGATION_COOLDOWN_MS
      }
      // The time already passed today means the window resets tomorrow.
      reset.setDate(reset.getDate() + 1)
    }
    return reset.getTime()
  }
  const match = message.match(
    /\btry again at\s+(?:[a-z]+,\s+)?([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})\s+(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)\b/iu
  )
  if (!match) return undefined
  let month: number | undefined
  for (let index = 0; index < 12; index += 1) {
    if (codexMonthName(index).startsWith(match[1].toLowerCase())) {
      month = index
      break
    }
  }
  if (month === undefined) return undefined
  const day = Number(match[2])
  const year = Number(match[3])
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return undefined
  const hour12 = Number(match[4])
  const minute = Number(match[5])
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return undefined
  const hour = (hour12 % 12) + (match[6].toLowerCase().startsWith('p') ? 12 : 0)
  const reset = new Date(year, month, day, hour, minute, 0, 0)
  if (!Number.isFinite(reset.getTime()) || reset.getTime() <= now) return undefined
  return reset.getTime()
}

export function codexMonthName(index: number): string {
  const names = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december'
  ]
  return names[index]
}

/** Build the structured `quota` issue for a Codex usage-limit failure so the
 *  shared usage-limit card renders with a countdown and the retry scheduler can
 *  auto-resume the thread at the reported reset time. */
export function codexUsageLimitIssue(
  error: Record<string, unknown> | null,
  message: string
): AgentProviderIssue | undefined {
  const errorInfo = stringValue(error?.['codexErrorInfo'])
  if (errorInfo !== 'usageLimitExceeded' && !/usage limit/iu.test(message)) return undefined
  const retryAt = codexUsageLimitResetAt(message)
  return {
    kind: 'quota',
    message: presentProviderError(message).message,
    rawError: message,
    harnessId: 'codex',
    retryable: true,
    ...(retryAt === undefined ? {} : { retryAt })
  }
}

export function codexRetryIssueKind(
  errorInfo: unknown,
  message: string,
  statusCode: number | undefined
): AgentProviderIssue['kind'] {
  if (typeof errorInfo === 'string') {
    if (errorInfo === 'usageLimitExceeded') return 'quota'
    if (errorInfo === 'serverOverloaded' || errorInfo === 'internalServerError') {
      return 'provider_unavailable'
    }
    if (errorInfo === 'unauthorized') return 'authentication'
  }
  const classified = classifyProviderIssue(message, statusCode)
  if (classified !== 'unknown' && classified !== 'network') return classified
  const info = recordValue(errorInfo)
  if (
    info?.['httpConnectionFailed'] !== undefined ||
    info?.['responseStreamConnectionFailed'] !== undefined ||
    info?.['responseStreamDisconnected'] !== undefined ||
    info?.['responseTooManyFailedAttempts'] !== undefined
  ) {
    return 'network'
  }
  return classified
}

export function codexErrorStatusCode(errorInfo: unknown): number | undefined {
  const info = recordValue(errorInfo)
  if (!info) return undefined
  for (const value of Object.values(info)) {
    const statusCode = numberValue(recordValue(value)?.['httpStatusCode'])
    if (statusCode !== undefined) return statusCode
  }
  return undefined
}
