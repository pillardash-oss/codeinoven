import type {
  CloudDeploymentContainer,
  CloudDeploymentDeployment,
  CloudDeploymentProviderKind
} from '../../lib/types'
import type {
  CloudDeploymentProviderInfo,
  DeploymentProvider
} from '../deployment-provider.interface'

/** Human-readable platform names keyed by provider kind. */
export const PROVIDER_DISPLAY_NAMES: Readonly<
  Partial<Record<CloudDeploymentProviderKind, string>>
> = {
  coolify: 'Coolify',
  netlify: 'Netlify',
  railway: 'Railway',
  vercel: 'Vercel',
  dokploy: 'Dokploy',
  custom: 'Custom'
}

/**
 * Not-implemented-yet adapter backing every provider kind that has no working
 * adapter (Netlify, Railway, Vercel, Dokploy, and Custom in v1; the Coolify
 * adapter is the only working provider). The stub NEVER performs a network
 * call. It signals not-implemented through the typed contract:
 *
 * - `listContainers()` resolves to an empty list.
 * - `getStatus()` resolves to `null`.
 * - `getLogs()` resolves to an empty string.
 * - `getProviderInfo()` marks `implemented: false`, the authoritative signal
 *   consumers check before trusting a query result.
 *
 * v1 is Coolify-only by design; these providers are implemented one after
 * another once Coolify is correct, per the user's instruction to stub them.
 */
export class NotImplementedProvider implements DeploymentProvider {
  constructor(readonly kind: CloudDeploymentProviderKind) {}

  async listContainers(): Promise<CloudDeploymentContainer[]> {
    return []
  }

  async getStatus(): Promise<CloudDeploymentContainer | null> {
    return null
  }

  async listDeployments(): Promise<CloudDeploymentDeployment[]> {
    return []
  }

  async getLogs(): Promise<string> {
    return ''
  }

  getProviderInfo(): CloudDeploymentProviderInfo {
    return {
      kind: this.kind,
      name: PROVIDER_DISPLAY_NAMES[this.kind] ?? 'Unknown provider',
      implemented: false
    }
  }
}
