import type { SecretScope } from '../../lib/secrets'

/**
 * Every vault reference the app constructs, in one place.
 *
 * A reference is the only thing that outlives a save: ciphertext lives in the
 * vault under the ref, and the ref alone is what a project, a project account, a
 * utility or a thread persists. That makes the ref format a compatibility
 * surface: the strings below are the ones already written into users' state, so
 * they are stable on purpose and must never be reformatted.
 */

/** A ref plus what the app knows about its owner from the ref alone. */
export interface SecretRefIdentity {
  scope: SecretScope
  /** Id of the account, project, utility or thread the ref is keyed by. */
  ownerId?: string
}

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

const REF_PREFIXES: readonly { prefix: string; scope: SecretScope }[] = [
  { prefix: 'deployment_provider_', scope: 'cloud-provider' },
  { prefix: 'mcp_oauth_state_', scope: 'mcp-oauth' },
  { prefix: 'mcp_oauth_client_', scope: 'mcp-oauth' },
  { prefix: 'git_pat_', scope: 'git' },
  { prefix: 'media_provider_token_', scope: 'media' },
  { prefix: 'oven_git_identity_', scope: 'oven' },
  { prefix: 'oven_', scope: 'oven' },
  { prefix: 'base_url_provider_', scope: 'base-url-provider' },
  { prefix: 'agent_secret_', scope: 'agent' },
  { prefix: 'cio_typesafe_api_key', scope: 'typesafe' },
  { prefix: 'github_oauth_accounts', scope: 'github' },
  { prefix: 'github_oauth_token', scope: 'github' },
  { prefix: 'secret_', scope: 'unknown' }
]

/**
 * What a ref says about itself, so a stored value can be listed and described
 * without the code that wrote it being present.
 */
export function describeSecretRef(ref: string): SecretRefIdentity {
  for (const { prefix, scope } of REF_PREFIXES) {
    if (!ref.startsWith(prefix)) continue
    const ownerId = ref.slice(prefix.length)
    return ownerId ? { scope, ownerId } : { scope }
  }
  return { scope: 'unknown' }
}
