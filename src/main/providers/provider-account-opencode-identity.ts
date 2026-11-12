/**
 * OpenCode's integration identity: the ids OpenCode renamed, the canonical id a
 * stale row has to resolve to, and the CLI failure details that tell a stale
 * rename apart from a real error.
 */

/** Integrations OpenCode renamed; rows pinned before the rename name an id the CLI no longer knows. */
export const OPENCODE_RENAMED_INTEGRATIONS: Record<string, string> = {
  'opencode-zen': 'opencode',
  'opencode-console': 'opencode'
}

/** Canonical integration id for a possibly stale OpenCode provider id. */
export function canonicalOpenCodeIntegrationId(providerId: string): string {
  const canonical = OPENCODE_RENAMED_INTEGRATIONS[providerId.toLowerCase()]
  return canonical ?? providerId
}

/** Whether a CLI failure means the integration itself is unknown (stale rename). */
export function isUnknownOpenCodeIntegrationError(detail: string): boolean {
  return /integration not found|unknown integration|no such integration|integration.+not .*(found|recognised|recognized|known)/iu.test(
    detail
  )
}

/** Whether a CLI failure only reports an already-absent credential (idempotent). */
export function isBenignOpenCodeLogoutError(detail: string): boolean {
  return /no .*credentials?|not logged in|not authenticated|already logged out|no auth/i.test(
    detail
  )
}
