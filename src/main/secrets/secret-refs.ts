/** Where a stored secret belongs. Recorded with the value so it can be described. */
export type SecretScope =
  | 'cloud-provider'
  | 'git'
  | 'utility'
  | 'mcp-oauth'
  | 'media'
  | 'typesafe'
  | 'github'
  | 'oven'
  | 'agent'
  | 'project-env'
  | 'base-url-provider'
  | 'unknown'

/**
 * Every vault reference the app constructs, in one place.
 *
 * A reference is the only thing that outlives a save: ciphertext lives in the
 * vault under the ref, and the ref alone is what a project, a project account, a
 * utility or a thread persists. That makes the ref format a compatibility
 * surface: the strings below are the ones already written into users' state, so
 * they are stable on purpose and must never be reformatted.
 */

/**
 * Cloud deployment provider token, keyed by the global account id only: one
 * account's token is shared by every project that attaches it.
 */
export function providerTokenRef(accountId: string): string {
  return `deployment_provider_${accountId}`
}

/** One MCP utility's OAuth state: tokens, PKCE verifier, client registration. */
export function mcpOAuthStateRef(utilityId: string): string {
  return `mcp_oauth_state_${utilityId}`
}

/** A hand-registered OAuth client's secret for one MCP utility. */
export function mcpOAuthClientRef(utilityId: string): string {
  return `mcp_oauth_client_${utilityId}`
}

/** A project's git push/pull credential. */
export function gitCredentialRef(projectId: string): string {
  return `git_pat_${projectId}`
}

/** One media provider's API token. */
export function mediaProviderTokenRef(providerId: string): string {
  return `media_provider_token_${providerId}`
}

/** The TypeSafe (Jev) API key. */
export const TYPESAFE_KEY_REF = 'cio_typesafe_api_key'

/** The GitHub OAuth account set, stored as one encrypted JSON document. */
export const GITHUB_ACCOUNTS_REF = 'github_oauth_accounts'

/** The single-token GitHub credential this app wrote before the account set. */
export const LEGACY_GITHUB_TOKEN_REF = 'github_oauth_token'

/** One Oven connection's password, private key or key passphrase. */
export function ovenSecretRef(
  ovenId: string,
  field: 'password' | 'private-key' | 'passphrase'
): string {
  return `oven_${ovenId}_${field}`
}

/** One project's Oven git identity private key. */
export function ovenGitIdentityKeyRef(projectId: string): string {
  return `oven_git_identity_${projectId}`
}

/** A base-URL provider's API key, keyed by the provider's own id. */
export function baseUrlProviderKeyRef(providerId: string): string {
  return `base_url_provider_${providerId}`
}

/** A free-standing secret one thread collected through `cio_ask_secret`. */
export function agentThreadSecretRef(threadId: string, environmentVariable: string): string {
  return `agent_secret_${threadId}_${environmentVariable}`
}

/**
 * A ref for a value whose owner does not need a stable address: a utility
 * credential, an Oven field, a provider key. Callers persist the returned ref.
 */
export function generatedSecretRef(id: string): string {
  return `secret_${id}`
}
