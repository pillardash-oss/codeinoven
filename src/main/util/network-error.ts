/**
 * Network-level failure detection for IPC handlers.
 *
 * Handlers that reach out to remote providers (GitHub, npm, …) must never let
 * a raw `fetch failed` TypeError cross the IPC boundary   the renderer treats
 * a rejected handler as a broken feature instead of a transient offline
 * state. Use {@link isNetworkError} to recognize connect/DNS timeouts and
 * degrade gracefully (cached data + an actionable offline message) instead.
 */

/** Undici and Node error codes that indicate the network itself failed. */
const NETWORK_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE'
])

/** Messages undici/Node use for network-level fetch failures. */
const NETWORK_MESSAGE_PATTERN = /fetch failed|network error|socket (?:hang ?up|closed)/iu

/**
 * Error names a transport gives a request that outlived its deadline.
 *
 * `AbortError` is what `AbortController.abort()` produces, which is how this
 * app ends a provider request at its own timeout, and `TimeoutError` is what
 * undici raises for a connect or headers timeout. Both mean the network never
 * answered in time, so both are weather rather than a defect. A request this
 * app cancels on purpose must not be routed here: the only aborts on the
 * provider read path are its own deadline.
 */
const NETWORK_ERROR_NAMES = new Set(['AbortError', 'TimeoutError'])

/**
 * Whether an error (or anything in its `cause` chain) is a network-level
 * failure   offline, DNS, a connect or request timeout, or a dropped socket
 * as opposed to an application-level failure that should still be surfaced
 * as-is.
 */
export function isNetworkError(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true
  const name = (error as { name?: unknown }).name
  if (typeof name === 'string' && NETWORK_ERROR_NAMES.has(name)) return true
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string' && NETWORK_MESSAGE_PATTERN.test(message)) return true
  return isNetworkError((error as { cause?: unknown }).cause, depth + 1)
}
