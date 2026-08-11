import type { CloudDeploymentContainer, CloudDeploymentProviderKind } from '../../lib/types'
import { CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES } from '../../lib/types'
import type {
  CloudDeploymentProviderInfo,
  DeploymentProvider,
  DeploymentProviderContext
} from '../deployment-provider.interface'

/** Constructs a `DeploymentProvider` adapter for a resolved credential/URL context. */
export type DeploymentProviderFactory = (context: DeploymentProviderContext) => DeploymentProvider

const PROVIDER_DISPLAY_NAMES: Readonly<Partial<Record<CloudDeploymentProviderKind, string>>> = {
  coolify: 'Coolify',
  netlify: 'Netlify',
  railway: 'Railway',
  vercel: 'Vercel',
  dokploy: 'Dokploy',
  custom: 'Custom'
}

/**
 * Not-implemented-yet adapter. Every provider kind with no working adapter
 * resolves to this stub so the registry always resolves a kind safely. The
 * stub never performs a network call; `getProviderInfo()` marks it
 * `implemented: false` so the renderer surfaces a not-implemented-yet signal.
 */
export class NotImplementedProvider implements DeploymentProvider {
  constructor(readonly kind: CloudDeploymentProviderKind) {}

  async listContainers(): Promise<CloudDeploymentContainer[]> {
    return []
  }

  async getStatus(): Promise<CloudDeploymentContainer | null> {
    return null
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

/**
 * Kind → adapter factory mapping. Every `CloudDeploymentProviderKind` value is
 * seeded with the not-implemented stub at module load, so the registry resolves
 * any kind safely; working adapters (e.g. Coolify) override their kind via
 * {@link registerDeploymentProvider}.
 */
const registry = new Map<CloudDeploymentProviderKind, DeploymentProviderFactory>(
  CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES.map(
    (kind) => [kind, () => new NotImplementedProvider(kind)] as const
  )
)

/** Register (or replace) the adapter factory for a provider kind. */
export function registerDeploymentProvider(
  kind: CloudDeploymentProviderKind,
  factory: DeploymentProviderFactory
): void {
  registry.set(kind, factory)
}

/** Resolve a `DeploymentProvider` for a kind, falling back to the stub. */
export function resolveDeploymentProvider(kind: CloudDeploymentProviderKind): DeploymentProvider {
  const factory = registry.get(kind) ?? (() => new NotImplementedProvider(kind))
  return factory({})
}
