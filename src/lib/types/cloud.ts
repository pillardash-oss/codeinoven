/** Provider-agnostic deployment hosts the Cloud Deployments panel can reach. */
export type CloudDeploymentProviderKind =
  'coolify' | 'netlify' | 'railway' | 'vercel' | 'dokploy' | 'custom'

/** Every `CloudDeploymentProviderKind` as a runtime array   single source for schema enums. */
export const CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES: readonly CloudDeploymentProviderKind[] = [
  'coolify',
  'netlify',
  'railway',
  'vercel',
  'dokploy',
  'custom'
]

/**
 * Provider kinds backed by the not-implemented stub (v1 is Coolify-only).
 * Attempting to query these must surface a not-implemented-yet signal and must
 * never trigger a network call. Single source shared by main and renderer.
 */
export const CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS: readonly CloudDeploymentProviderKind[] = [
  'netlify',
  'railway',
  'vercel',
  'dokploy'
]

/** Latest build/run state of a cloud deployment container. */
export type CloudDeploymentStatus = 'building' | 'success' | 'failed' | 'unknown'

/**
 * One deployment/build record for a cloud deployment container. The detail view
 * shows the last several of these so the user can compare a passing vs failing
 * run and open the build log for any of them.
 */
export interface CloudDeploymentDeployment {
  /** Provider-side deployment id (e.g. a Coolify deployment_uuid). */
  id: string
  /** Latest known status of this deployment/build. */
  status: CloudDeploymentStatus
  /** Epoch ms this deployment was last updated. */
  updatedAt?: number
  /** Commit hash the deployment built, when the provider reports it. */
  commit?: string
  /** Capped raw build log for this deployment, when available. */
  log?: string
}

/** One provider-agnostic cloud deployment container/application mapping. */
export interface CloudDeploymentContainer {
  /** Stable container identity the provider adapter can query by. */
  id: string
  /** User-supplied custom label shown in the panel. */
  label: string
  /** Provider that owns this container. */
  providerKind: CloudDeploymentProviderKind
  /** Global provider account this container is monitored through. When unset,
   *  the project's active account for the provider kind is used (legacy single
   *  active account model). Set when a container is added while browsing a
   *  specific account so a second account of the same kind keeps working
   *  independently of the active-account switch. */
  accountId?: string
  /** Latest known deployment/build status. */
  status: CloudDeploymentStatus
  /** Live URL of the deployed application, when known. */
  url?: string
  /** All known live URLs/domains for the deployed application, when the
   *  provider exposes more than one (e.g. multiple Coolify FQDNs). */
  urls?: string[]
  /** Coolify project (or provider grouping) this container belongs to, when known. */
  project?: string
  /** Epoch ms the container was first seen. */
  createdAt?: number
  /** Epoch ms of the last status change. */
  updatedAt?: number
  /** Capped raw log text for the latest deployment, when available. */
  log?: string
}

/**
 * A cloud deployment provider account in the global registry. Accounts are
 * created once, labelled by the user, and can be attached to any project.
 * They are NOT scoped to a project: the same account (e.g. one Coolify
 * instance, or one Vercel team) is reused across every project that uses it.
 */
export interface CloudDeploymentProviderAccount {
  /** Stable account identity, unique across the whole registry. */
  id: string
  /** User-supplied label shown in the panel (e.g. 'Coolify   Personal'). */
  label: string
  /** Provider this account authenticates. */
  providerKind: CloudDeploymentProviderKind
  /** Opaque SecretVault reference for the stored token; never carries plaintext. */
  secretRef: string
  /** Verified base URL the provider is reached at (e.g. the Coolify host), when known. */
  baseUrl?: string
  /** Whether this account currently holds a stored credential. */
  configured: boolean
  /** Whether this account is enabled for use. Disabled accounts are skipped by monitoring. */
  enabled: boolean
  /** Epoch ms the account was first created. */
  createdAt: number
  /** Epoch ms the account's credential was last stored or rotated. */
  updatedAt: number
}

/**
 * The global cloud deployment provider account registry. Persisted by main,
 * independent of any project. Keyed by account id.
 */
export interface CloudDeploymentAccountRegistry {
  accounts: CloudDeploymentProviderAccount[]
}

/**
 * A project's attachment to a provider's accounts. A project can attach
 * several accounts of the same provider and pick one active for monitoring.
 */
export interface CloudDeploymentProjectProviderAccounts {
  /** Ids of the global accounts attached to this project for this provider. */
  attachedAccountIds: string[]
  /** Id of the active attached account for this provider, or null when none. */
  activeAccountId: string | null
}

/** One project's selected providers and their labelled container mappings. */
export interface CloudDeploymentProjectConfig {
  /** Provider kinds selected for this project. */
  providers: CloudDeploymentProviderKind[]
  /** Container mappings configured for this project, with user labels. */
  containers: CloudDeploymentContainer[]
  /** Per-provider account attachments (which global accounts this project uses). */
  providerAccounts?: Partial<
    Record<CloudDeploymentProviderKind, CloudDeploymentProjectProviderAccounts>
  >
}

/**
 * Per-project cloud deployment configuration, persisted by main, never in the
 * repo. Accounts themselves live in the global `CloudDeploymentAccountRegistry`
 * (see `cloudDeploy:listAccounts`); this config only records which accounts the
 * project attaches and which is active per provider.
 */
export interface CloudDeploymentConfig {
  version: 3
  projectId: string
  /** Selected providers plus labelled container mappings and account attachments. */
  project: CloudDeploymentProjectConfig
  /** Epoch ms of the last configuration change. */
  updatedAt: number
}

/** Read-only provider-agnostic deployment snapshot for a project. */
export interface CloudDeploymentOverview {
  containers: CloudDeploymentContainer[]
  fetchedAt: number
}

/**
 * Cloud deployment overview IPC result. `hasDeployments` is derived from the
 * snapshot and drives whether the Cloud Deployments panel is shown at all.
 */
export interface CloudDeploymentResult extends CloudDeploymentOverview {
  hasDeployments: boolean
  /** Actionable provider/credential access failure returned without rejecting IPC. */
  accessError?: string
}

/** One entry from `git stash list`, e.g. `stash@{0}`. */
export interface GitStashEntry {
  /** Reflog selector, e.g. `stash@{0}`. */
  id: string
  /** Stash message, e.g. `WIP on main: abc1234 feat: thing`. */
  message: string
  /** Branch the stash was created on, when derivable. */
  branch: string | null
  /** Unix timestamp of the stash commit. */
  date: number
}
