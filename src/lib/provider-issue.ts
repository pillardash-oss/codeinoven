import type { AgentProviderIssue, AgentProviderIssueKind } from './types'

/**
 * True when a provider issue represents a usage/rate-limit reset wait rather
 * than a terminal failure. This is the app-wide contract: such issues always
 * surface as a `waiting` provider card with a retry time, and the retry
 * scheduler resumes the thread once the reset passes — for every harness,
 * whether or not the harness schedules its own provider retry.
 */
export function isUsageResetWaitIssue(
  issue: Pick<AgentProviderIssue, 'kind' | 'retryable'> | undefined | null
): boolean {
  if (!issue) return false
  if (issue.kind === 'quota' || issue.kind === 'rate_limit') return true
  return issue.kind === 'provider_unavailable' && issue.retryable === true
}

/**
 * Classify a provider/harness failure message and optional HTTP status code into
 * a provider-neutral kind so every driver and the chat engine agree on how the
 * failure is presented (title, retry affordance, raw-error visibility).
 */
export function classifyProviderIssue(
  message: string,
  statusCode?: number
): AgentProviderIssueKind {
  // Harnesses frequently surface limits as machine-style subtype strings
  // (`usage_limit_exceeded`, `session-limit-reached`, `rate_limit_error`).
  // Normalize separators to spaces first, or these fall through to `unknown`
  // and a scheduled usage-reset wait renders as a terminal error.
  const normalized = message.replaceAll(/[_-]+/gu, ' ').toLowerCase()
  if (
    statusCode === 429 ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests')
  ) {
    return 'rate_limit'
  }
  if (
    normalized.includes('quota') ||
    normalized.includes('usage limit') ||
    normalized.includes('session limit') ||
    normalized.includes('exhausted') ||
    normalized.includes('window exceeded')
  ) {
    return 'quota'
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('authenticate') ||
    normalized.includes('oauth') ||
    normalized.includes('sign in') ||
    normalized.includes('login required') ||
    normalized.includes('session expired') ||
    normalized.includes('api key')
  ) {
    return 'authentication'
  }
  if (
    normalized.includes('billing') ||
    normalized.includes('credit') ||
    normalized.includes('payment')
  ) {
    return 'billing'
  }
  if (
    statusCode === 503 ||
    normalized.includes('overloaded') ||
    normalized.includes('unavailable')
  ) {
    return 'provider_unavailable'
  }
  if (
    normalized.includes('network') ||
    normalized.includes('connection') ||
    normalized.includes('disconnected') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('socket hang up') ||
    normalized.includes('fetch failed') ||
    normalized.includes('dns') ||
    normalized.includes('offline')
  ) {
    return 'network'
  }
  return 'unknown'
}
