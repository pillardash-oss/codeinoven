import type { McpOAuthState, McpOAuthStateStore } from '@earendil-works/pi-mcp/oauth'
import type { SecretVault } from '../../storage/secret-vault'

/**
 * One MCP utility's OAuth state, held in the encrypted vault.
 *
 * Everything the OAuth client persists lives here   the dynamically registered
 * client, the access and refresh tokens, the PKCE verifier, and the discovered
 * authorization server metadata   as ciphertext under the app config root. The
 * utility definition only ever carries display metadata, so exporting, diffing,
 * or rendering a utility can never carry a grant.
 *
 * The vault ref is derived from the utility id, so nothing has to persist a
 * reference: a grant is found again after a restart without the registry being
 * involved.
 */
export class VaultMcpOAuthStateStore implements McpOAuthStateStore {
  constructor(
    private readonly vault: SecretVault,
    private readonly utilityId: string
  ) {}

  async load(): Promise<McpOAuthState | undefined> {
    const stored = await this.vault.resolveMcpOAuthState(this.utilityId)
    if (!stored) return undefined
    try {
      const parsed: unknown = JSON.parse(stored)
      // A state written for another server (a URL the user edited) is dropped
      // here as well as in the OAuth client, so a token can never cross servers
      // even if a caller reads the state directly.
      return isMcpOAuthState(parsed) ? parsed : undefined
    } catch {
      // Unreadable state is treated as absent: the next authorization replaces it.
      return undefined
    }
  }

  async save(state: McpOAuthState): Promise<void> {
    await this.vault.saveMcpOAuthState(this.utilityId, JSON.stringify(state))
  }

  /** Forget the grant, the client registration, and everything discovered for it. */
  async clear(): Promise<void> {
    await this.vault.removeMcpOAuthState(this.utilityId)
  }
}

function isMcpOAuthState(value: unknown): value is McpOAuthState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return typeof state['serverUrl'] === 'string'
}
