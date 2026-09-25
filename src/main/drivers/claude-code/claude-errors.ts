import type {
  AgentProviderIssue,
  AgentProviderIssueKind,
  AgentRateLimitWindow
} from '../../../lib/types'
import {
  classifyProviderIssue,
  parseUsageResetAt,
  presentProviderError
} from '../../../lib/provider-issue'

/** Claude Code limit notices, result failures, and API retry classification. */

export function claudeSessionLimitResetAt(message: string, now = Date.now()): number | undefined {
  const match = message.match(/\bresets\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/iu)
  if (!match) return undefined
  const parsedHour = Number(match[1])
  const minute = Number(match[2])
  if (parsedHour < 1 || parsedHour > 12 || minute < 0 || minute > 59) return undefined
  const meridiem = match[3]?.toLowerCase()
  const hour = (parsedHour % 12) + (meridiem === 'pm' ? 12 : 0)
  const reset = new Date(now)
  reset.setHours(hour, minute, 0, 0)
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1)
  return reset.getTime()
}

export function claudeSessionLimitIssue(
  error: string | undefined,
  rateLimits: AgentRateLimitWindow[]
): AgentProviderIssue | undefined {
  if (
    !error ||
    !/(?:you(?:'|’)ve|you have) hit your session limit|session limit reached/iu.test(error)
  ) {
    return undefined
  }
  const retryAt =
    rateLimits.find((limit) => limit.resetsAt !== undefined)?.resetsAt ??
    claudeSessionLimitResetAt(error)
  return {
    kind: 'quota',
    message: presentProviderError(error).message,
    rawError: error,
    harnessId: 'claude-code',
    retryable: retryAt !== undefined,
    ...(retryAt === undefined ? {} : { retryAt })
  }
}

/**
 * `result`-type turn failures that aren't a session-limit notice (e.g. "Fable
 * 5 requires usage credits. Run /usage-credits to continue or switch models
 * with /model.") otherwise reach the UI as a bare string with no `issue`,
 * which renders as a generic "Agent output error" instead of the billing
 * card that lets the user switch models. Classify them the same way every
 * other driver does.
 */
export function claudeResultIssue(error: string | undefined): AgentProviderIssue | undefined {
  if (!error) return undefined
  const kind = classifyProviderIssue(error)
  if (kind === 'unknown') return undefined
  const message = presentProviderError(error).message
  const retryAt = kind === 'quota' || kind === 'rate_limit' ? parseUsageResetAt(message) : undefined
  return {
    kind,
    message,
    rawError: error,
    harnessId: 'claude-code',
    retryable: retryAt !== undefined,
    ...(retryAt === undefined ? {} : { retryAt })
  }
}

/**
 * Classify a Claude Code `system`/`api_retry` stream event. The SDK emits this
 * for ANY retryable provider failure   connection errors (no HTTP status),
 * overloaded servers (529), 5xx responses, and 429 rate limiting   so the issue
 * kind must come from the event's `error`/`error_status` rather than treating
 * every retry as an exhausted usage limit.
 */
export function claudeApiRetryKind(
  error: string | undefined,
  statusCode: number | undefined
): AgentProviderIssueKind {
  switch (error) {
    case 'rate_limit':
      return 'rate_limit'
    case 'overloaded':
    case 'server_error':
      return 'provider_unavailable'
    case 'billing_error':
      return 'billing'
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
      return 'authentication'
    default:
      break
  }
  if (statusCode === undefined) return 'network'
  if (statusCode === 429) return 'rate_limit'
  if (statusCode >= 500) return 'provider_unavailable'
  return classifyProviderIssue('', statusCode)
}
