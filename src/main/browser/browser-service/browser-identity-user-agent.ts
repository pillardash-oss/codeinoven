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
 * This scope bakes the alternative in: every browser jar presents the runtime user
 * agent unless `CODEINOVEN_BROWSER_IDENTITY_UA` turns it off, so a Windows build of
 * this branch answers the question without a shell variable. It is an experiment,
 * not a shipped preference, and the whole module goes away with the branch if the
 * Windows sign-in stays blocked with a truthful agent.
 *
 * The main process records the runtime user agent before branding overwrites
 * `app.userAgentFallback`; only the browser jars present it, so the app's own
 * windows keep the branded string.
 */

/** Environment variable that turns the app browser's runtime user agent off. */
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
 * Whether the environment turns the runtime user agent off.
 *
 * Only an explicit falsy spelling disables it, so the baked-in default holds for an
 * unset variable and for a value nobody intended. A typo therefore keeps the
 * experiment running rather than silently reverting what the branch is testing.
 */
export function identityUserAgentDisabled(value: string | undefined): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

/**
 * The user agent a browser jar should present, or null to keep the branded one.
 *
 * Returns null when the variable disables it or when startup recorded nothing,
 * because presenting an empty user agent would break every site rather than
 * answering the question this experiment asks.
 */
export function browserIdentityUserAgent(
  value: string | undefined,
  runtime: string | null = runtimeUserAgent
): string | null {
  if (identityUserAgentDisabled(value)) return null
  return runtime
}
