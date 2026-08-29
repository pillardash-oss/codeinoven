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
 * Provider errors frequently arrive as a driver-formatted string wrapping a raw
 * JSON error body, e.g. `429: {"message":"You've reached your weekly usage
 * limit...","type":"rate_limit_error","code":"RATE_LIMITED"}`. Surfacing that
 * blob verbatim as the "friendly" message is a recurring UI bug — unwrap it
 * once here so every caller (classification and display) works off the actual
 * message/type/code rather than the raw transport string.
 */
export interface ProviderErrorEnvelope {
  /** Human-readable message: the JSON body's `message` field, or the input unchanged. */
  message: string
  /** The JSON body's `type` field, if present (e.g. `rate_limit_error`, `overloaded_error`). */
  type?: string
  /** The JSON body's `code` field, if present (e.g. `RATE_LIMITED`). */
  code?: string
}

export function extractProviderErrorEnvelope(raw: string): ProviderErrorEnvelope {
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) return { message: raw }
  try {
    const parsed: unknown = JSON.parse(raw.slice(jsonStart))
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>
      const message = typeof body['message'] === 'string' ? body['message'] : raw
      const type = typeof body['type'] === 'string' ? body['type'] : undefined
      const code = typeof body['code'] === 'string' ? body['code'] : undefined
      return { message, ...(type === undefined ? {} : { type }), ...(code === undefined ? {} : { code }) }
    }
  } catch {
    // Not a JSON envelope (or malformed) — treat the whole string as the message.
  }
  return { message: raw }
}

/**
 * Usage/quota errors commonly embed an ISO-8601 reset time in prose (e.g. "Your
 * limit resets at 2026-09-04T17:52:23.222Z."). Extract it so the retry
 * scheduler and UI get a concrete, authoritative `retryAt` instead of guessing
 * or trusting a harness's own short-interval retry hint, which is meant for
 * transient errors and is meaningless against a multi-day quota reset.
 */
export function parseUsageResetAt(message: string, now = Date.now()): number | undefined {
  const match = /resets? at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu.exec(message)
  if (!match) return undefined
  const resetMs = Date.parse(match[1] ?? '')
  if (!Number.isFinite(resetMs) || resetMs <= now) return undefined
  return resetMs
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
  const envelope = extractProviderErrorEnvelope(message)
  // Harnesses frequently surface limits as machine-style subtype strings
  // (`usage_limit_exceeded`, `session-limit-reached`, `rate_limit_error`).
  // Normalize separators to spaces first, or these fall through to `unknown`
  // and a scheduled usage-reset wait renders as a terminal error.
  const normalized = envelope.message.replaceAll(/[_-]+/gu, ' ').toLowerCase()
  const normalizedType = (envelope.type ?? '').replaceAll(/[_-]+/gu, ' ').toLowerCase()
  // A provider-load 429 ("overloaded_error", "temporarily unavailable") is a
  // transient condition, not a usage/rate cap — check it before the blanket
  // `statusCode === 429` branch below, or it always loses to `rate_limit` and
  // gets treated as a long usage-reset wait instead of a short retry.
  if (
    normalizedType.includes('overloaded') ||
    normalized.includes('overloaded') ||
    (normalized.includes('unavailable') && !normalized.includes('rate limit'))
  ) {
    return 'provider_unavailable'
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
    statusCode === 429 ||
    normalizedType.includes('rate limit') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests')
  ) {
    return 'rate_limit'
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
  if (statusCode === 503 || normalized.includes('unavailable')) {
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
