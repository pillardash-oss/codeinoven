import type { SecretVault } from '../storage/secret-vault'
import type { UtilityRegistryService } from './utility-registry-service'

/** Valid OS environment variable name. */
export const AGENT_SECRET_ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export interface AgentSecretStoreRequest {
  environmentVariable: string
  value: string
  /** Human label shown on the card, reused as the credential label. */
  label: string
  /** Bind the value to an installed utility as its credential, when named. */
  utilityId?: string
}

export interface AgentSecretStoreResult {
  environmentVariable: string
  /** Utility the value was attached to as a credential, when one was named. */
  boundUtilityId?: string
}

/**
 * Turns a `cio_ask_secret` submission into vault-backed state.
 *
 * A secret collected for a capability is stored exactly the way the Utilities
 * page stores it: the value goes to the encrypted vault and only the reference
 * reaches the registry, so the MCP launch resolves it into the process
 * environment and it survives an app restart. Plaintext is never returned; the
 * caller already holds it transiently for the harness environment round-trip.
 */
export class AgentSecretService {
  constructor(
    private readonly vault: SecretVault,
    private readonly registry: UtilityRegistryService
  ) {}

  async store(request: AgentSecretStoreRequest): Promise<AgentSecretStoreResult> {
    if (!AGENT_SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(request.environmentVariable)) {
      throw new TypeError(`Secret environment variable is invalid: ${request.environmentVariable}`)
    }
    if (!request.value) throw new TypeError('Secret value must not be empty')
    if (!request.utilityId) return { environmentVariable: request.environmentVariable }
    await this.bindUtilityCredential(request)
    return {
      environmentVariable: request.environmentVariable,
      boundUtilityId: request.utilityId
    }
  }

  /**
   * Attach (or rotate) a utility credential exactly as the Utilities page does:
   * the value goes to the vault and only the reference is written to the
   * registry, so the MCP launch resolves it into the process environment.
   */
  private async bindUtilityCredential(request: AgentSecretStoreRequest): Promise<void> {
    const utilityId = request.utilityId
    if (!utilityId) throw new TypeError('A utility id is required to bind a credential')
    const utility = await this.registry.get(utilityId)
    if (!utility) throw new Error(`Utility not found: ${utilityId}`)
    const credentialId = credentialIdFor(request.environmentVariable)
    const existing = utility.credentials.find((credential) => credential.id === credentialId)
    const secretRef = await this.vault.save(request.value, existing?.secretRef)
    const credentials = utility.credentials.filter((credential) => credential.id !== credentialId)
    credentials.push({
      id: credentialId,
      label: request.label,
      secretRef,
      required: false,
      environmentVariable: request.environmentVariable
    })
    await this.registry.update(utilityId, { credentials })
  }
}

/** Credential id derived from the environment variable, matching the editor. */
function credentialIdFor(environmentVariable: string): string {
  const id = environmentVariable
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
  return id || 'agent-secret'
}
