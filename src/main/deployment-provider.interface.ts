import type {
  CloudDeploymentContainer,
  CloudDeploymentDeployment,
  CloudDeploymentProviderKind
} from '../lib/types'

/** Static, provider-agnostic metadata about a deployment provider adapter. */
export interface CloudDeploymentProviderInfo {
  /** Discriminates which platform this provider reaches. */
  kind: CloudDeploymentProviderKind
  /** Human-readable platform name shown in the Cloud Deployments panel. */
  name: string
  /** Whether this adapter performs real queries; false marks a not-implemented stub. */
  implemented: boolean
  /** Verified base URL the provider is reached at, when one is configured. */
  baseUrl?: string
}

/** Options the registry passes when constructing a provider adapter. */
export interface DeploymentProviderContext {
  /** Verified provider base URL resolved from config; never invented. */
  baseUrl?: string
  /** Vaulted provider token resolved by main; never serialized across IPC. */
  token?: string
}

/**
 * Provider-agnostic cloud deployment surface. Each platform (Coolify today;
 * Netlify, Railway, Vercel, and Dokploy later) plugs in behind this interface
 * with its own REST adapter, mirroring the `GitProvider` pattern. The Coolify
 * adapter is the reference implementation.
 */
export interface DeploymentProvider {
  /** Discriminator identifying the platform this adapter talks to. */
  readonly kind: CloudDeploymentProviderKind
  /** List the provider's containers/applications normalized to the shared model. */
  listContainers(): Promise<CloudDeploymentContainer[]>
  /** Latest snapshot for one container, or null when the provider cannot resolve it. */
  getStatus(containerId: string): Promise<CloudDeploymentContainer | null>
  /**
   * List the most recent deployments/builds for a container, newest first.
   * The UI shows a bounded window (e.g. the last ten).
   */
  listDeployments(containerId: string): Promise<CloudDeploymentDeployment[]>
  /** Capped raw log text for a deployment, or the latest when no id is given. */
  getLogs(containerId: string, deploymentId?: string): Promise<string>
  /** Static metadata about the adapter itself. */
  getProviderInfo(): CloudDeploymentProviderInfo
}
