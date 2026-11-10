import type { SecretOwnerHint, SecretOwnerLookup } from './secret-inventory'
import type { StoredSecretSummary } from './secret-store'
import type { UtilityRegistryService } from '../utilities/utility-registry-service'

/** What the lookup needs to name an owner it can reach. */
export interface SecretOwnerLookupDependencies {
  /** Installed capabilities, which own their own credentials. */
  utilities?: UtilityRegistryService
  /** Project names, for a credential keyed by project id. */
  projectName?: (projectId: string) => Promise<string | null>
  /** Thread titles, for a secret one conversation collected. */
  threadTitle?: (threadId: string) => Promise<string | null>
}

/**
 * Name the owner of a stored value, so the Secrets page can say what a row
 * belongs to instead of showing a ref.
 *
 * Every lookup is best effort: a capability that was uninstalled, a project that
 * was archived or a thread that was deleted leaves the secret behind, and the
 * row still has to be listed so the user can remove it.
 */
export function createSecretOwnerLookup(
  dependencies: SecretOwnerLookupDependencies
): SecretOwnerLookup {
  return async (summary: StoredSecretSummary): Promise<SecretOwnerHint> => {
    if (!summary.ownerId) return {}
    if (summary.scope === 'utility') {
      const utility = await dependencies.utilities?.get(summary.ownerId).catch(() => null)
      const credential = utility?.credentials.find((entry) => entry.secretRef === summary.ref)
      if (!utility) return {}
      return {
        utilityName: utility.name,
        ...(credential?.label ? { credentialLabel: credential.label } : {}),
        ...(credential?.environmentVariable ? { variable: credential.environmentVariable } : {})
      }
    }
    if (summary.scope === 'git') {
      const projectName = await dependencies.projectName?.(summary.ownerId).catch(() => null)
      return projectName ? { projectName } : {}
    }
    if (summary.scope === 'agent') {
      const threadTitle = await dependencies.threadTitle?.(summary.ownerId).catch(() => null)
      return threadTitle ? { threadTitle } : {}
    }
    return {}
  }
}
