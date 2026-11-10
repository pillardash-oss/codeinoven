import type { SecretInventoryEntry } from '../../lib/secrets'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'
import type { OvenRegistry } from '../ovens/oven-registry'
import type { StorageEngine } from '../storage/storage-engine'
import type { UtilityRegistryService } from '../utilities/utility-registry-service'
import { Logger } from '../system/logger'

/** The services that own the references a stored secret points at. */
export interface SecretRevocationDependencies {
  utilities?: UtilityRegistryService
  ovens?: OvenRegistry
  providers?: BaseUrlProviderService
  storage: StorageEngine
}

/**
 * Forget a reference after its value is deleted.
 *
 * Removing a value from the Secrets page is not enough on its own: a capability,
 * a machine or an account that still points at the ref would fail at its next
 * launch with "credential not found", which reads as a broken feature rather
 * than as a credential the user chose to remove. Each owner is therefore asked
 * to let go of the reference, and an owner that cannot be reached leaves a
 * dangling ref that the owner already treats as unconfigured.
 *
 * Owners whose readers test `exists` before resolving (git credentials, media
 * providers, TypeSafe, thread secrets, capability sign-ins) need no pruning: no
 * reference is persisted, or a missing value already reads as "not configured".
 */
export type SecretRevoker = (entry: SecretInventoryEntry) => Promise<void>

export function createSecretRevoker(dependencies: SecretRevocationDependencies): SecretRevoker {
  return async (entry: SecretInventoryEntry): Promise<void> => {
    switch (entry.scope) {
      case 'utility':
        await forgetUtilityCredential(dependencies.utilities, entry)
        return
      case 'cloud-provider':
        await forgetCloudAccountToken(dependencies.storage, entry)
        return
      case 'oven':
        await forgetOvenSecret(dependencies.ovens, entry)
        return
      case 'base-url-provider':
        await forgetProviderKey(dependencies.providers, entry)
        return
      default:
        return
    }
  }
}

async function forgetUtilityCredential(
  utilities: UtilityRegistryService | undefined,
  entry: SecretInventoryEntry
): Promise<void> {
  if (!utilities || !entry.ownerId) return
  const utility = await utilities.get(entry.ownerId).catch(() => null)
  if (!utility) return
  const remaining = utility.credentials.filter((credential) => credential.secretRef !== entry.ref)
  if (remaining.length === utility.credentials.length) return
  await utilities.update(entry.ownerId, { credentials: remaining })
}

async function forgetCloudAccountToken(
  storage: StorageEngine,
  entry: SecretInventoryEntry
): Promise<void> {
  if (!entry.ownerId) return
  const registry = await storage.getCloudDeploymentAccounts()
  const account = registry.accounts.find((candidate) => candidate.id === entry.ownerId)
  if (!account || account.secretRef !== entry.ref) return
  account.secretRef = ''
  account.configured = false
  account.updatedAt = Date.now()
  await storage.saveCloudDeploymentAccounts(registry)
}

async function forgetOvenSecret(
  ovens: OvenRegistry | undefined,
  entry: SecretInventoryEntry
): Promise<void> {
  if (!ovens) return
  const removed = await ovens.forgetSecretRef(entry.ref)
  if (!removed) Logger.dev('A removed Oven credential was no longer referenced:', entry.ref)
}

async function forgetProviderKey(
  providers: BaseUrlProviderService | undefined,
  entry: SecretInventoryEntry
): Promise<void> {
  if (!providers) return
  const all = await providers.listProviders()
  const owner = all.find((provider) => provider.apiKeyRef === entry.ref)
  if (!owner) return
  await providers.updateProvider(owner.harnessId, owner.id, { removeApiKey: true })
}
