import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import {
  CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS,
  type CloudDeploymentContainer,
  type CloudDeploymentProviderKind,
  type CloudDeploymentResult
} from '$shared/types'

/** How long a cached overview or container status is served without refetching. */
const OVERVIEW_CACHE_TTL_MS = 60_000

/** Container status changes as a deployment runs, so poll it on the same cadence as the overview. */
const STATUS_CACHE_TTL_MS = 60_000

/** Logs change rarely and are heavy — hold them a little longer. */
const LOG_CACHE_TTL_MS = 5 * 60_000

/**
 * How long a failed request is remembered before it may be tried again.
 *
 * A failure caches nothing, so without this the panel's periodic poll would
 * re-run the same doomed request on every tick. Explicit refresh (`force`)
 * always ignores the cooldown, so the user is never locked out.
 */
const ERROR_COOLDOWN_MS = 120_000

/** Human-readable platform names, used only for the not-implemented-yet toast. */
const PROVIDER_DISPLAY_NAMES: Readonly<Record<CloudDeploymentProviderKind, string>> = {
  coolify: 'Coolify',
  netlify: 'Netlify',
  railway: 'Railway',
  vercel: 'Vercel',
  dokploy: 'Dokploy',
  custom: 'Custom'
}

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

interface CacheEntry<T> {
  value: T
  fetchedAt: number
}

/**
 * Stale-while-revalidate cache store for cloud deployment status and logs,
 * mirroring `gitState`'s deployment caches: fresh cache renders instantly, and
 * an entry older than its TTL is revalidated in the background. Failures enter
 * a per-key cooldown so a doomed request is not repeated on every poll, and one
 * in-flight request per key is shared by all callers (dedup).
 *
 * Every key is project-scoped so two projects using the same provider and
 * container id never share (or collide) cache, cooldown, or in-flight entries.
 */
export class CloudDeployState {
  /** Cached provider overviews, keyed by `${projectId}/${providerKind}`. */
  overviews: Record<string, CacheEntry<CloudDeploymentResult>> = $state({})

  /** Cached per-container statuses, keyed by `${projectId}/${providerKind}/${containerId}`. */
  containerStatuses: Record<string, CacheEntry<CloudDeploymentContainer>> = $state({})

  /** Cached per-container logs, keyed by `${projectId}/${providerKind}/${containerId}`. */
  containerLogs: Record<string, CacheEntry<{ containerId: string; log: string }>> = $state({})

  /** Epoch ms of the last failure per key. Deliberately plain (not `$state`) —
   *  it only gates fetching, and making it reactive would feed the very effects
   *  that triggered the request. */
  private failures: Record<string, number> = {}

  /** One in-flight request per key, shared so concurrent callers don't double-fetch. */
  private requests: Record<string, Promise<unknown> | undefined> = {}

  /** Last load error, surfaced to the panel when a background revalidate fails. */
  error: string | null = $state(null)

  /** Provider kinds already notified via the not-implemented-yet toast this session. */
  private notifiedNotImplemented: Partial<Record<CloudDeploymentProviderKind, boolean>> = {}

  static overviewKey(projectId: string, providerKind: CloudDeploymentProviderKind): string {
    return `${projectId}/${providerKind}`
  }

  static containerKey(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    containerId: string
  ): string {
    return `${projectId}/${providerKind}/${containerId}`
  }

  /** Drop the entries whose key starts with the given project prefix. */
  private static dropByProjectPrefix<T>(
    record: Record<string, T>,
    projectId: string
  ): Record<string, T> {
    const prefix = `${projectId}/`
    const next: Record<string, T> = {}
    for (const [key, value] of Object.entries(record)) {
      if (!key.startsWith(prefix)) next[key] = value
    }
    return next
  }

  /** Keep only the entries whose key starts with the given project prefix. */
  private static keepByProjectPrefix<T>(
    record: Record<string, T>,
    projectId: string
  ): Record<string, T> {
    const prefix = `${projectId}/`
    const next: Record<string, T> = {}
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith(prefix)) next[key] = value
    }
    return next
  }

  /** True while a key is inside its post-failure cooldown. */
  private coolingDown(key: string): boolean {
    const failedAt = this.failures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < ERROR_COOLDOWN_MS) return true
    delete this.failures[key]
    return false
  }

  private markFailure(key: string): void {
    this.failures[key] = Date.now()
  }

  private dedupe<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.requests[key] as Promise<T> | undefined
    if (existing) return existing
    const request = loader()
    this.requests[key] = request
    // A `.then` with both branches (rather than `.finally`) so a rejected
    // request never leaves an unhandled rejection from the cleanup chain.
    request.then(
      () => {
        if (this.requests[key] === request) delete this.requests[key]
      },
      () => {
        if (this.requests[key] === request) delete this.requests[key]
      }
    )
    return request
  }

  /**
   * Guard against querying a provider backed by the not-implemented stub.
   * Returns `true` when the kind is stubbed, surfacing a not-implemented-yet
   * toast once per session and skipping the IPC round trip entirely, so no
   * adapter network call is ever made for these kinds.
   */
  private handleNotImplemented(providerKind: CloudDeploymentProviderKind): boolean {
    if (!CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(providerKind)) return false
    this.error = null
    if (!this.notifiedNotImplemented[providerKind]) {
      this.notifiedNotImplemented = { ...this.notifiedNotImplemented, [providerKind]: true }
      const name = PROVIDER_DISPLAY_NAMES[providerKind]
      toast.message(`${name} deployments aren't available yet`, {
        description: 'This provider will be supported in a future update.'
      })
    }
    return true
  }

  /**
   * Load the provider overview, serving cache first.
   *
   * Returns immediately when fresh cache exists; otherwise fetches and updates
   * the cache. `force` bypasses both the TTL and the failure cooldown (explicit
   * refresh). Failures rethrow so the caller can surface a tailored message
   * while any stale cache stays on screen.
   */
  async ensureOverview(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    force = false
  ): Promise<CloudDeploymentResult | null> {
    if (this.handleNotImplemented(providerKind)) return null
    const key = CloudDeployState.overviewKey(projectId, providerKind)
    const cached = this.overviews[key]
    if (!force && cached && Date.now() - cached.fetchedAt < OVERVIEW_CACHE_TTL_MS) {
      return cached.value
    }
    if (!force && this.coolingDown(key)) return cached?.value ?? null
    return this.dedupe(key, () => this.loadOverview(projectId, providerKind, key))
  }

  private async loadOverview(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    key: string
  ): Promise<CloudDeploymentResult | null> {
    try {
      const result = await invoke('cloudDeploy:overview', projectId, providerKind)
      this.overviews = { ...this.overviews, [key]: { value: result, fetchedAt: Date.now() } }
      delete this.failures[key]
      this.error = null
      return result
    } catch (reason) {
      this.markFailure(key)
      this.error = errorMessage(reason, 'Deployment overview could not be loaded')
      throw reason
    }
  }

  /**
   * Load one container's latest status, serving cache first (same pattern).
   * Returns null when the provider cannot resolve the container.
   */
  async ensureContainerStatus(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    containerId: string,
    force = false
  ): Promise<CloudDeploymentContainer | null> {
    if (this.handleNotImplemented(providerKind)) return null
    const key = CloudDeployState.containerKey(projectId, providerKind, containerId)
    const cached = this.containerStatuses[key]
    if (!force && cached && Date.now() - cached.fetchedAt < STATUS_CACHE_TTL_MS) {
      return cached.value
    }
    if (!force && this.coolingDown(key)) return cached?.value ?? null
    return this.dedupe(key, () =>
      this.loadContainerStatus(projectId, providerKind, containerId, key)
    )
  }

  private async loadContainerStatus(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    containerId: string,
    key: string
  ): Promise<CloudDeploymentContainer | null> {
    try {
      const container = await invoke(
        'cloudDeploy:containerStatus',
        projectId,
        providerKind,
        containerId
      )
      if (container) {
        this.containerStatuses = {
          ...this.containerStatuses,
          [key]: { value: container, fetchedAt: Date.now() }
        }
        delete this.failures[key]
      }
      this.error = null
      return container
    } catch (reason) {
      this.markFailure(key)
      this.error = errorMessage(reason, 'Container status could not be loaded')
      throw reason
    }
  }

  /**
   * Load a container's latest deployment log, serving cache first. Logs hold a
   * longer TTL than the other caches.
   */
  async ensureContainerLog(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    containerId: string,
    force = false
  ): Promise<{ containerId: string; log: string } | null> {
    if (this.handleNotImplemented(providerKind)) return null
    const key = CloudDeployState.containerKey(projectId, providerKind, containerId)
    const cached = this.containerLogs[key]
    if (!force && cached && Date.now() - cached.fetchedAt < LOG_CACHE_TTL_MS) {
      return cached.value
    }
    if (!force && this.coolingDown(key)) return cached?.value ?? null
    return this.dedupe(key, () => this.loadContainerLog(projectId, providerKind, containerId, key))
  }

  private async loadContainerLog(
    projectId: string,
    providerKind: CloudDeploymentProviderKind,
    containerId: string,
    key: string
  ): Promise<{ containerId: string; log: string } | null> {
    try {
      const result = await invoke('cloudDeploy:containerLog', projectId, providerKind, containerId)
      this.containerLogs = {
        ...this.containerLogs,
        [key]: { value: result, fetchedAt: Date.now() }
      }
      delete this.failures[key]
      this.error = null
      return result
    } catch (reason) {
      this.markFailure(key)
      this.error = errorMessage(reason, 'Container log could not be loaded')
      throw reason
    }
  }

  /**
   * Push an updated snapshot for a configured container into the cache so the
   * panel reflects a status change without waiting for the next poll. Clears any
   * failure cooldown for the key.
   */
  setContainerStatus(projectId: string, container: CloudDeploymentContainer): void {
    const key = CloudDeployState.containerKey(projectId, container.providerKind, container.id)
    this.containerStatuses = {
      ...this.containerStatuses,
      [key]: { value: container, fetchedAt: Date.now() }
    }
    delete this.failures[key]
  }

  /**
   * Clear the store's project-scoped data. With no argument, drops every cached
   * overview/status/log, cooldown marker, and in-flight request (a full reset on
   * session teardown). When a `projectId` is given, only that project's entries
   * are dropped so switching away from a project never leaves stale panels, while
   * other projects keep their hot cache.
   */
  reset(projectId?: string): void {
    if (projectId === undefined) {
      this.overviews = {}
      this.containerStatuses = {}
      this.containerLogs = {}
      this.failures = {}
      this.requests = {}
      this.notifiedNotImplemented = {}
      this.error = null
      return
    }
    this.overviews = CloudDeployState.dropByProjectPrefix(this.overviews, projectId)
    this.containerStatuses = CloudDeployState.dropByProjectPrefix(this.containerStatuses, projectId)
    this.containerLogs = CloudDeployState.dropByProjectPrefix(this.containerLogs, projectId)
    this.failures = CloudDeployState.dropByProjectPrefix(this.failures, projectId)
    this.requests = CloudDeployState.dropByProjectPrefix(this.requests, projectId)
  }

  /**
   * Re-scope the store to one active project: drop every project's cached data
   * except `projectId`'s, so the active project keeps its fresh cache while stale
   * entries from previously viewed projects are never rendered. Called when the
   * active project changes.
   */
  ensureProject(projectId: string): void {
    this.overviews = CloudDeployState.keepByProjectPrefix(this.overviews, projectId)
    this.containerStatuses = CloudDeployState.keepByProjectPrefix(this.containerStatuses, projectId)
    this.containerLogs = CloudDeployState.keepByProjectPrefix(this.containerLogs, projectId)
    this.failures = CloudDeployState.keepByProjectPrefix(this.failures, projectId)
    this.requests = CloudDeployState.keepByProjectPrefix(this.requests, projectId)
    this.error = null
  }
}

export const cloudDeployState = new CloudDeployState()
