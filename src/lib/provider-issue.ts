import type { AgentProviderIssue, AgentProviderIssueKind } from './types'

/**
 * True when a provider issue represents a retry wait rather than a terminal
 * failure: a usage/rate-limit reset window, or a retryable provider-load outage
 * (a 429 `overloaded`/`server_error`, a 5xx). This is the app-wide contract:
 * such issues always surface as a `waiting` provider card with a retry time,
 * and the retry scheduler resumes the thread once the wait passes   for every
 * harness, whether or not the harness schedules its own provider retry.
 */
export function isUsageResetWaitIssue(
  issue: Pick<AgentProviderIssue, 'kind' | 'retryable'> | undefined | null
): boolean {
  if (!issue) return false
  if (issue.kind === 'quota' || issue.kind === 'rate_limit') return true
  return issue.kind === 'provider_unavailable' && issue.retryable === true
}

/**
 * Upper bound for an unattended scheduled auto-retry wait. A reset inside this
 * window is imminent: the power-wake policy keeps the device awake so the retry
 * can fire on time, and the header keeps counting the thread as working. A
 * retry parked beyond it is a long wait   treated as not-working so the activity
 * badge drops the thread and the user sees the state change.
 */
export const SCHEDULED_RETRY_WAKE_WINDOW_MS = 6 * 60 * 60 * 1_000

/** True when a scheduled retry deadline falls beyond the keep-awake window. */
export function isLongScheduledRetryWait(retryAt: number, now = Date.now()): boolean {
  return retryAt - now > SCHEDULED_RETRY_WAKE_WINDOW_MS
}

/**
 * How long to wait before retrying a transient provider-load failure.
 *
 * Such a failure is not an account window: `overloaded`, `server_error`, and
 * 5xx responses clear in seconds to minutes. The retry scheduler must never
 * derive a usage reset from account telemetry for one, or a "retry shortly"
 * notice turns into the far-future reset of an unrelated (often monthly)
 * window   observed on OpenCode Go as a `provider_unavailable` record parked
 * three weeks out. One fixed minute is long enough to let a load spike pass and
 * short enough that a still-failing turn resumes promptly.
 */
export const TRANSIENT_PROVIDER_RETRY_MS = 60 * 1_000

/**
 * Upper bound for a persisted transient provider-load wait. A saved record that
 * claims a longer wait is a legacy record written before the fixed backoff
 * above, so load-time repair clamps it instead of parking the thread for weeks.
 */
export const TRANSIENT_PROVIDER_RETRY_MAX_MS = 15 * 60 * 1_000

/**
 * Cooldown schedule for a rate limit the provider did not attach a retry time
 * to. An immediate retry hammers an account that is already refusing work, so
 * each consecutive failure waits longer: 1s, 3s, 5s, 10s, 30s, then a final
 * minute. After the last step the app stops retrying and leaves the thread on
 * its failure card for a deliberate manual retry.
 *
 * The whole streak is short by design: a real rate limit clears in seconds to a
 * minute, and a wait the provider never scheduled must never become an hour-long
 * blind cooldown.
 */
export const RATE_LIMIT_COOLDOWN_SCHEDULE_MS = [
  1_000, 3_000, 5_000, 10_000, 30_000, 60_000
] as const

/** Number of automatic cooldown retries allowed before the app stops. */
export const RATE_LIMIT_COOLDOWN_MAX_ATTEMPTS = RATE_LIMIT_COOLDOWN_SCHEDULE_MS.length

/**
 * Wait before the given (1-based) consecutive cooldown retry, or `undefined`
 * once the schedule is exhausted and the app must stop retrying.
 */
export function rateLimitCooldownMs(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1) return undefined
  return RATE_LIMIT_COOLDOWN_SCHEDULE_MS[attempt - 1]
}

/**
 * Provider errors frequently arrive as a driver-formatted string wrapping a raw
 * JSON error body, e.g. `429: {"message":"You've reached your weekly usage
 * limit...","type":"rate_limit_error","code":"RATE_LIMITED"}`. Surfacing that
 * blob verbatim as the "friendly" message is a recurring UI bug   unwrap it
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
      return {
        message,
        ...(type === undefined ? {} : { type }),
        ...(code === undefined ? {} : { code })
      }
    }
  } catch {
    // Not a JSON envelope (or malformed)   treat the whole string as the message.
  }
  return { message: raw }
}

/**
 * A crash-trace frame line, e.g.
 * `    at resolve (/$bunfs/root/chunk-36bwgd4p.js:2:1659)` or the
 * `at SessionPrompt.run (definition)` shape a compiled runtime emits. A
 * harness that crashes inside its own runtime hands its exception text back
 * as an ordinary message string, so the first frame line is where the
 * diagnostic detail begins.
 */
const STACK_FRAME_LINE = /^\s*at(?:\s|$)/u

export interface ProviderErrorPresentation {
  /** Short, user-facing message the provider card body may render: the JSON
   *  body's `message` with any stack trace reduced to its header line. */
  message: string
  /** Full diagnostic text (raw transport string, trace included). Present only
   *  when it says more than `message`; the Raw Error view shows this. */
  rawError?: string
}

/** Electron's prefix on a rejected `ipcRenderer.invoke`. */
const IPC_REJECTION_WRAPPER = /^Error invoking remote method '[^']+':\s*/u

/**
 * Split a provider/harness failure string into the short message the provider
 * error card body may render and the full diagnostic text reserved for the Raw
 * Error view. A failure reaches the UI as a plain message string, with no
 * envelope to unwrap, in two shapes that both used to leak a whole stack trace
 * into the beautified card body:
 *
 * ```
 * TypeError: undefined is not an object (evaluating 'a.name')
 *     at resolve (/$bunfs/root/chunk-36bwgd4p.js:2:1659)
 *     at map (native:1:11)
 * ```
 *
 * Cutting at the first frame line keeps the header (`TypeError: ...`) as the
 * card body and leaves the trace in Raw Error, which is the app-wide contract
 * for every `AgentProviderIssue`: `message` is display copy, `rawError` is
 * diagnostic detail.
 */
export function presentProviderError(raw: string): ProviderErrorPresentation {
  const detail = raw.trim()
  if (!detail) return { message: '' }
  // A rejected IPC call reaches the card still wrapped in Electron's
  // `Error invoking remote method 'channel':` sentence, which names the app's
  // own plumbing instead of the problem. The wrapper stays in `rawError`.
  const body = extractProviderErrorEnvelope(detail)
    .message.replace(IPC_REJECTION_WRAPPER, '')
    .trim()
  const lines = body.split('\n')
  const frameIndex = lines.findIndex((line) => STACK_FRAME_LINE.test(line))
  const header = (frameIndex === -1 ? lines : lines.slice(0, frameIndex)).join('\n').trim()
  const message = header || (lines[0] ?? body).trim() || detail
  return message === detail ? { message } : { message, rawError: detail }
}

/**
 * A harness-emitted usage-cap notice is a short, plain-text system message  
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
 * agent's ordinary answer can also talk about usage limits at length   and
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
    isWindowLimitPhrase(lead) ||
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
  // or "Resets in 2h 5m". Cline phrases the same countdown as "Try again in
  // 13m". Convert either into an absolute retryAt, or this class of message
  // is left with no reset time and can't schedule a resume.
  const relative =
    /(?:resets?|try again)\s+in\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/iu.exec(
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
 * A reset stated as a wall-clock time, e.g. "resets 6am (Africa/Lagos)".
 *
 * Claude Code words a cap this way, and the shape carries two traps. The minutes
 * are optional (it writes "6am", not "6:00am"), so a `H:MM`-only pattern never
 * matched the weekly window. And the trailing parenthesis names the zone the
 * clock is stated in: reading "6am" with `setHours` on a machine in another
 * zone parks the retry hours off, so the wall clock is resolved in the named
 * zone when the platform knows it and only falls back to the machine zone when
 * it does not.
 */
export function parseClockResetAt(message: string, now = Date.now()): number | undefined {
  const match =
    /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(\s*([A-Za-z][A-Za-z0-9_+\-/]*)\s*\))?/iu.exec(
      message
    )
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined
  const meridiem = match[3]?.toLowerCase()
  // Noon and midnight are the two values `% 12` alone gets wrong.
  const hour24 = (hour % 12) + (meridiem === 'pm' ? 12 : 0)
  const zone = match[4]
  return nextDailyResetAt(hour24, minute, zone, now)
}

/** Milliseconds in a wall-clock reading, resolved in `zone` (machine zone when absent). */
function zonedWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string | undefined
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  // The offset belongs to the instant, not the wall clock, so read it twice:
  // once at the naive guess and once at the instant that guess lands on. The
  // second read is what survives the hour a DST switch removes or repeats.
  const guess = wall - zoneOffsetMs(wall, zone)
  return wall - zoneOffsetMs(guess, zone)
}

/** Offset of `zone` at `epoch`, in milliseconds east of UTC. */
function zoneOffsetMs(epoch: number, zone: string | undefined): number {
  const parts = zoneClockParts(epoch, zone)
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - epoch
  )
}

interface ZoneClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zoneClockParts(epoch: number, zone: string | undefined): ZoneClockParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(zone ? { timeZone: zone } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  })
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = formatter.formatToParts(new Date(epoch)).find((part) => part.type === type)?.value
    return Number(value ?? 0)
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second')
  }
}

/** True when the platform resolves `zone` as an IANA time zone. */
function isKnownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The next time `hour:minute` comes round in `zone` (or the machine zone).
 *
 * A cap states the clock time it resets at, not a date, and the reset is by
 * definition still ahead: today's occurrence that has already passed means
 * tomorrow.
 */
function nextDailyResetAt(
  hour: number,
  minute: number,
  zone: string | undefined,
  now: number
): number {
  const resolvedZone = zone && isKnownZone(zone) ? zone : undefined
  if (!resolvedZone) {
    const reset = new Date(now)
    reset.setHours(hour, minute, 0, 0)
    if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1)
    return reset.getTime()
  }
  const today = zoneClockParts(now, resolvedZone)
  const candidate = zonedWallClock(today.year, today.month, today.day, hour, minute, resolvedZone)
  if (candidate > now) return candidate
  // Let `Date.UTC` roll the day over: month and year ends need no handling.
  return zonedWallClock(today.year, today.month, today.day + 1, hour, minute, resolvedZone)
}

/**
 * Whether a failure says the scope's managed checkout is missing or unhealthy.
 * No provider is involved in that, so it is neither a provider outage nor
 * something Change or Retry can fix: the fix is repairing the worktree.
 */
export function isScopeRootFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('managed scope root') || normalized.includes('managed checkout')
}

/**
 * Window-scoped usage-cap phrasing, e.g. "weekly limit", "5-hour limit".
 *
 * Providers do not agree on what to call a cap. Claude Code names the seven-day
 * window "You've hit your weekly limit" and its session window "5-hour limit",
 * and neither sentence contains the words "usage limit" or "session limit".
 * Without these window adjectives the notice classified as `unknown`, the
 * completed message carried no issue, and the turn's non-zero exit code became
 * the failure the user was shown. The window word must sit immediately before
 * `limit`, so agent prose that mentions a week or an hour next to an unrelated
 * limit never matches.
 */
const WINDOW_LIMIT_PATTERN =
  /\b(?:(?:five|5)[\s-]?hours?|(?:twenty[\s-]?four|24)[\s-]?hours?|hourly|daily|weekly|monthly|yearly|annual)[\s-]?limit\b/u

/** True when the text names a window-scoped cap ("weekly limit", "5-hour limit"). */
export function isWindowLimitPhrase(text: string): boolean {
  return WINDOW_LIMIT_PATTERN.test(text.toLowerCase())
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
  // A missing or unhealthy managed checkout says "unavailable" too, but no
  // provider is involved: Change and Retry cannot fix it, so it must not be
  // filed as a provider outage.
  if (isScopeRootFailure(normalized)) return 'unknown'
  // A provider-load 429 ("overloaded_error", "temporarily unavailable") is a
  // transient condition, not a usage/rate cap   check it before the blanket
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
    isWindowLimitPhrase(normalized) ||
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

/**
 * The heading a provider issue is shown under.
 *
 * Shared so the thread's provider card and every other surface that renders a
 * failure from the same `AgentProviderIssue` name it the same way. `waiting`
 * distinguishes a retry the app scheduled from a failure that has stopped.
 */
export function providerIssueTitle(kind: AgentProviderIssueKind, waiting = false): string {
  switch (kind) {
    case 'rate_limit':
    case 'quota':
      return 'Usage limit reached'
    case 'authentication':
      return 'Provider sign-in required'
    case 'billing':
      return 'Provider billing issue'
    case 'provider_unavailable':
      return 'Provider temporarily unavailable'
    case 'network':
      return 'Provider connection interrupted'
    default:
      return waiting ? 'Provider retry scheduled' : 'Agent output error'
  }
}

/**
 * The status colour a provider issue is reported in, so a card's colour says what
 * it communicates. A wait the app is already handling is `info`; a limit, a
 * sign-in, a billing problem or an outage the reader can wait out or fix is
 * `warning`; only a failure with no such way through is `danger`.
 */
export function providerIssueTone(
  kind: AgentProviderIssueKind,
  waiting = false
): 'danger' | 'warning' | 'info' {
  if (waiting) return 'info'
  switch (kind) {
    case 'rate_limit':
    case 'quota':
    case 'authentication':
    case 'billing':
    case 'provider_unavailable':
    case 'network':
      return 'warning'
    default:
      return 'danger'
  }
}
