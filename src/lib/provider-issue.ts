import type { AgentProviderIssue, AgentProviderIssueKind, AgentRateLimitWindow } from './types'

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
 * A harness-emitted usage-cap notice is a short, plain-text system message —
 * anything longer or formatted is agent prose, not a notice.
 */
const USAGE_LIMIT_NOTICE_MAX_LENGTH = 300
/** The limit phrasing must lead the notice; mid-prose mentions are agent prose. */
const USAGE_LIMIT_NOTICE_LEAD_LENGTH = 120
/**
 * Sentence/line terminator used to isolate a notice's leading phrase. Real
 * notices lead with the limit phrasing in their first short sentence or line;
 * agent prose buries it mid-sentence.
 */
const USAGE_LIMIT_NOTICE_SENTENCE_SPLIT = /[.!?\n]/

/**
 * True when a plain assistant message actually IS a harness usage/rate-limit
 * notice rather than an ordinary agent answer that merely discusses limits.
 *
 * Some harnesses (opencode observed in the wild) emit their usage-cap notice
 * as a completed assistant message ("5-hour usage limit reached. Resets in
 * 1hr 53min."), which the chat engine re-classifies into a retry wait. But an
 * agent's ordinary answer can also talk about usage limits at length — and
 * classifying that prose as a limit notice splashes the entire agent output
 * into the usage-limit card. A genuine notice is short, unformatted text whose
 * limit phrasing leads the message; agent prose is long, markdown-formatted,
 * or only mentions limits mid-sentence.
 */
export function isUsageLimitNoticeText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > USAGE_LIMIT_NOTICE_MAX_LENGTH) return false
  // Agent answers are markdown; harness notices are plain text.
  if (
    /(^|\n)#{1,6}\s/.test(trimmed) ||
    trimmed.includes('**') ||
    trimmed.includes('```') ||
    /(^|\n)\s*(?:[-*+]|\d+\.)\s/.test(trimmed) ||
    trimmed.includes('](')
  ) {
    return false
  }
  // The limit phrasing must lead the notice: within a short first sentence
  // or line. Agent prose that merely mentions limits mid-sentence (even early
  // in the text) does not qualify.
  const lead = (trimmed.split(USAGE_LIMIT_NOTICE_SENTENCE_SPLIT, 1)[0] ?? trimmed)
    .trim()
    .toLowerCase()
  if (!lead || lead.length > USAGE_LIMIT_NOTICE_LEAD_LENGTH) return false
  return (
    lead.includes('usage limit') ||
    lead.includes('rate limit') ||
    lead.includes('session limit') ||
    lead.includes('quota') ||
    lead.includes('too many requests') ||
    lead.includes('limit reached') ||
    lead.includes('limit exceeded')
  )
}

/**
 * Usage/quota errors commonly embed an ISO-8601 reset time in prose (e.g. "Your
 * limit resets at 2026-09-04T17:52:23.222Z."). Extract it so the retry
 * scheduler and UI get a concrete, authoritative `retryAt` instead of guessing
 * or trusting a harness's own short-interval retry hint, which is meant for
 * transient errors and is meaningless against a multi-day quota reset.
 */
export function parseUsageResetAt(message: string, now = Date.now()): number | undefined {
  const absolute = /resets? at\s+(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu.exec(message)
  if (absolute) {
    const resetMs = Date.parse(absolute[1] ?? '')
    if (Number.isFinite(resetMs) && resetMs > now) return resetMs
  }
  // Some harnesses (e.g. opencode's usage-cap notice) report a relative
  // countdown instead of an absolute timestamp, e.g. "Resets in 1hr 53min"
  // or "Resets in 2h 5m". Convert that into an absolute retryAt too, or this
  // class of message is left with no reset time and can't schedule a resume.
  const relative =
    /resets?\s+in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/iu.exec(
      message
    )
  if (relative && (relative[1] || relative[2] || relative[3])) {
    const days = Number(relative[1] ?? 0)
    const hours = Number(relative[2] ?? 0)
    const minutes = Number(relative[3] ?? 0)
    const deltaMs = (days * 24 * 60 + hours * 60 + minutes) * 60_000
    if (deltaMs > 0) return now + deltaMs
  }
  return undefined
}

/**
 * Convert a structured usage-limit issue into the exhausted quota window the
 * usage meter expects. Provider headers and account APIs remain preferable,
 * but a provider's explicit limit notice is authoritative telemetry too and
 * must not produce a limit card with an empty usage panel beside it.
 */
export function rateLimitWindowFromProviderIssue(
  issue: Pick<AgentProviderIssue, 'kind' | 'message' | 'retryAt' | 'retryable'>,
  now = Date.now()
): AgentRateLimitWindow | null {
  if (!isUsageResetWaitIssue(issue)) return null
  const normalized = extractProviderErrorEnvelope(issue.message).message.toLowerCase()
  const hourWindow = /(\d+)\s*[- ]?h(?:(?:ou)?rs?)?/iu.exec(normalized)
  const hours = hourWindow ? Number(hourWindow[1]) : undefined
  const label = normalized.includes('weekly')
    ? 'Weekly limit'
    : normalized.includes('monthly')
      ? 'Monthly limit'
      : normalized.includes('daily')
        ? 'Daily limit'
        : hours !== undefined && Number.isFinite(hours)
          ? `${hours}-hour limit`
          : normalized.includes('session')
            ? 'Session limit'
            : issue.kind === 'rate_limit'
              ? 'Rate limit'
              : 'Usage limit'
  const windowMinutes = normalized.includes('weekly')
    ? 10_080
    : normalized.includes('monthly')
      ? 43_200
      : normalized.includes('daily')
        ? 1_440
        : hours !== undefined && Number.isFinite(hours)
          ? hours * 60
          : undefined
  const resetsAt = issue.retryAt ?? parseUsageResetAt(issue.message, now)
  return {
    id: `provider-issue:${label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}`,
    label,
    status: 'exhausted',
    usedPercent: 100,
    remaining: 0,
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowMinutes === undefined ? {} : { windowMinutes })
  }
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
