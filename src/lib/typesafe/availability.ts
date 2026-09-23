import type { TypesafeCallStatus, TypesafeDecisionStatus } from '../types/typesafe'

/** First cooldown after TypeSafe refuses the key outright. */
const REJECTED_COOLDOWN_BASE_MS = 30 * 60_000
/** Ceiling the rejection cooldown doubles towards, so a session never stalls for a day. */
const REJECTED_COOLDOWN_MAX_MS = 6 * 60 * 60_000
/** Transient failures tolerated before the breaker opens at all. */
const UNAVAILABLE_FAILURE_THRESHOLD = 3
/** Cooldown after those failures, long enough to stop hammering a dead network. */
const UNAVAILABLE_COOLDOWN_MS = 2 * 60_000
/** Fallback when a rate limit arrives without a usable `retry-after`. */
const RATE_LIMIT_COOLDOWN_MS = 60_000
/** Floor for a rate limit that did send a hint, so a zero hint cannot hot-loop. */
const RATE_LIMIT_MINIMUM_COOLDOWN_MS = 5_000

/**
 * Availability of the capability.
 *
 * Exhausted credits, a revoked key, an outage and a rate limit are not
 * distinguishable from each other in every case, so the breaker treats each as
 * "stop calling for a while" rather than trying to name the cause. While it is
 * open a decision costs a map lookup and opens no socket, which is what keeps a
 * dead key free on every turn.
 */
export interface TypesafeAvailabilityState {
  /** Epoch ms the breaker may close again; a past value means closed. */
  openUntil: number
  /** Cooldown length that opened it last, so a repeat rejection doubles. */
  cooldownMs: number
  /** Consecutive transient failures, reset by any terminal outcome. */
  failures: number
}

/** The closed state: every call is allowed. */
export const TYPESAFE_AVAILABILITY_CLOSED: TypesafeAvailabilityState = {
  openUntil: 0,
  cooldownMs: 0,
  failures: 0
}

/** Whether the breaker is open right now. */
export function isTypesafeCoolingDown(state: TypesafeAvailabilityState, now: number): boolean {
  return state.openUntil > now
}

/**
 * Classify one HTTP response.
 *
 * Deliberately status-driven rather than message-driven: the published OpenAPI
 * document declares only 200 and 422, and describes no credits or quota
 * endpoint, so an exhausted balance can surface as any of the auth statuses.
 * Treating every 4xx as a refusal means a status TypeSafe adds later needs no
 * code change here.
 */
export function classifyTypesafeHttpStatus(status: number): TypesafeCallStatus {
  if (status === 422) return 'invalid-response'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'unavailable'
  if (status >= 400) return 'rejected'
  return 'unavailable'
}

/**
 * Read a `retry-after` header in either documented form and return milliseconds.
 *
 * Both forms are accepted because the header is optional and TypeSafe does not
 * currently send one at all; when it is absent the caller falls back to its own
 * cooldown rather than guessing from a date it does not have.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

/**
 * Fold one outcome into the availability state.
 *
 * The outcome is the only input, so retrying costs nothing to reason about: a
 * terminal refusal opens the breaker on first sight, a rate limit opens it for
 * the hint the service gave or a minute without one, and transient failures
 * have to repeat before they close anything.
 */
export function recordTypesafeOutcome(
  state: TypesafeAvailabilityState,
  outcome: TypesafeDecisionStatus,
  now: number,
  retryAfterMs?: number
): TypesafeAvailabilityState {
  if (outcome === 'answered' || outcome === 'below-threshold') {
    return TYPESAFE_AVAILABILITY_CLOSED
  }
  if (outcome === 'rejected') {
    const cooldownMs =
      state.cooldownMs > 0
        ? Math.min(state.cooldownMs * 2, REJECTED_COOLDOWN_MAX_MS)
        : REJECTED_COOLDOWN_BASE_MS
    return { openUntil: now + cooldownMs, cooldownMs, failures: 0 }
  }
  if (outcome === 'rate-limited') {
    // The service's own hint is honoured when it gives one, because it knows
    // when it will accept calls again; the floor only stops a zero hint from
    // turning the next turn into an immediate retry.
    const cooldownMs =
      retryAfterMs === undefined
        ? RATE_LIMIT_COOLDOWN_MS
        : Math.max(retryAfterMs, RATE_LIMIT_MINIMUM_COOLDOWN_MS)
    return { openUntil: now + cooldownMs, cooldownMs: 0, failures: 0 }
  }
  if (outcome === 'unavailable') {
    const failures = state.failures + 1
    if (failures >= UNAVAILABLE_FAILURE_THRESHOLD) {
      return { openUntil: now + UNAVAILABLE_COOLDOWN_MS, cooldownMs: 0, failures: 0 }
    }
    return { openUntil: state.openUntil, cooldownMs: state.cooldownMs, failures }
  }
  if (outcome === 'not-configured' || outcome === 'disabled') {
    return TYPESAFE_AVAILABILITY_CLOSED
  }
  // A malformed payload or an oversize one is this app's bug, not the
  // service's: retrying is useless, but so is refusing every later call.
  return state
}
