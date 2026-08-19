import type { CloudDeploymentProviderKind } from '../../lib/types'
import { CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES } from '../../lib/types'
import type { DeploymentProvider, DeploymentProviderContext } from './deployment-provider.interface'
import { NotImplementedProvider } from './not-implemented-provider'
import { createCoolifyProvider } from './coolify-provider'

/** Constructs a `DeploymentProvider` adapter for a resolved credential/URL context. */
export type DeploymentProviderFactory = (context: DeploymentProviderContext) => DeploymentProvider

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

registerDeploymentProvider('coolify', createCoolifyProvider)

/** Register (or replace) the adapter factory for a provider kind. */
export function registerDeploymentProvider(
  kind: CloudDeploymentProviderKind,
  factory: DeploymentProviderFactory
): void {
  registry.set(kind, factory)
}

/**
 * Resolve a `DeploymentProvider` for a kind, falling back to the stub.
 * Callers that already hold a verified base URL / vaulted token pass them via
 * `context` so the adapter can authenticate; callers without one (e.g. the
 * config flows) resolve with an empty context and the adapter degrades safely.
 */
export function resolveDeploymentProvider(
  kind: CloudDeploymentProviderKind,
  context: DeploymentProviderContext = {}
): DeploymentProvider {
  const factory = registry.get(kind) ?? (() => new NotImplementedProvider(kind))
  return factory(context)
}
