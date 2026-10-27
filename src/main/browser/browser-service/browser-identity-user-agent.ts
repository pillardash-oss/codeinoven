/**
 * The runtime's own user agent, as the one alternative the app browser may present.
 *
 * `brandUserAgent` rewrites the runtime user agent into a plain Chrome string so
 * sites accept a supported Chromium version. Google's account pages read that as a
 * claim that does not hold: the string says Chrome while Chromium's own client
 * hints still say Chromium, and `accounts.google.com` answers with "This browser or
 * app may not be secure". The alternative is the runtime's untouched user agent,
 * which is truthful about what is rendering the page rather than a different claim
 * about it.
 *
 * This is an experiment aimed at a Windows report, not a shipped preference, so it
 * is switched by an environment variable. The main process records the runtime user
 * agent before branding overwrites `app.userAgentFallback`, and the app browser's
 * jars present it only when the variable asks for it.
 */

/** Environment variable that makes the app browser present the runtime user agent. */
export const BROWSER_IDENTITY_USER_AGENT_ENV = 'CODEINOVEN_BROWSER_IDENTITY_UA'

/** The runtime user agent captured before branding rewrote the app fallback. */
let runtimeUserAgent: string | null = null

/**
 * Record the runtime's user agent. Called once at startup, before
 * `app.userAgentFallback` is branded, because that assignment is the only chance to
 * see the value Chromium itself would have sent.
 */
export function rememberRuntimeUserAgent(userAgent: string): void {
  runtimeUserAgent = userAgent.length > 0 ? userAgent : null
}

/** The recorded runtime user agent, or null when startup never recorded one. */
export function recordedRuntimeUserAgent(): string | null {
  return runtimeUserAgent
}

/**
 * Whether the environment asks the app browser for the runtime user agent.
 *
 * An unset or unrecognized value keeps the branded string, so a typo cannot silently
 * change what every site sees.
 */
export function identityUserAgentRequested(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

/**
 * The user agent a browser jar should present, or null to keep the branded one.
 *
 * Returns null when the variable is off or when startup recorded nothing, because
 * presenting an empty user agent would break every site rather than answering the
 * question this experiment asks.
 */
export function browserIdentityUserAgent(
  value: string | undefined,
  runtime: string | null = runtimeUserAgent
): string | null {
  if (!identityUserAgentRequested(value)) return null
  return runtime
}
