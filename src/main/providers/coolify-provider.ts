import type {
  CloudDeploymentContainer,
  CloudDeploymentDeployment,
  CloudDeploymentProviderKind,
  CloudDeploymentStatus
} from '../../lib/types'
import type {
  CloudDeploymentProviderInfo,
  DeploymentProvider,
  DeploymentProviderContext
} from '../deployment-provider.interface'
import { COOLIFY_BASE_URL_ENV, resolveCoolifyBaseUrl } from './base-url'

/** Human-readable platform name surfaced by the Cloud Deployments panel. */
export const COOLIFY_DISPLAY_NAME = 'Coolify'

/** Path prefix all Coolify API v1 operations live under. */
export const COOLIFY_API_PREFIX = '/api/v1'

/** Network timeout so a slow instance never hangs the UI. */
const COOLIFY_FETCH_TIMEOUT_MS = 15_000

/** Cap on the raw deployment/runtime log text streamed into the app (roughly 200 KB). */
const MAX_CONTAINER_LOG_BYTES = 200_000

/** Runtime log lines requested when no deployment log is available. */
const DEFAULT_LOG_LINES = 200

/** How many recent deployments the detail view surfaces at once. */
const CloudDeploymentDeploymentLimit = 10

/** Sanitized provider failure that preserves the HTTP status for IPC handling. */
export class CoolifyProviderError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'CoolifyProviderError'
  }
}

/**
 * Coolify-first REST adapter for the normalized cloud deployment model.
 *
 * This is the reference `DeploymentProvider` implementation. All Coolify-specific
 * endpoint paths, field names, and status vocabularies are contained here and are
 * never leaked into the normalized `CloudDeploymentContainer` model.
 *
 * Auth and base-URL contract:
 * - The bearer token is resolved from the credential store by main and passed via
 *   {@link DeploymentProviderContext}; it is never serialized across IPC or logged.
 * - The base URL is the user-supplied verified URL (context wins), falling back to
 *   the `CODEINOVEN_COOLIFY_BASE_URL` env contract from `base-url.ts`. The adapter
 *   never invents a host; when neither is configured, operations fail with a clear
 *   error instead of guessing.
 *
 * Endpoint assumptions (Coolify API v1, grounded in the published OpenAPI spec):
 * - `GET /applications` lists applications; `GET /applications/{uuid}` reads one.
 * - `GET /deployments/applications/{uuid}?take=1&skip=0` lists an application's
 *   deployments (newest first), each carrying a `logs` string and a deployment
 *   `status`. The published spec mislabels that endpoint's response as the
 *   `Application` schema, so records are only trusted as deployments when they
 *   carry deployment-shaped fields.
 * - `GET /applications/{uuid}/logs?lines=200` returns `{ logs: string }` runtime
 *   container output, used as a fallback when no deployment record exists.
 */
export class CoolifyProvider implements DeploymentProvider {
  readonly kind: CloudDeploymentProviderKind = 'coolify'
  /** Normalized user-supplied base URL (host-level, no trailing slash). */
  private readonly baseUrl: string | null
  /** Effective API endpoint prefix, always under `/api/v1`. */
  private readonly apiBaseUrl: string | null

  constructor(private readonly context: DeploymentProviderContext) {
    this.baseUrl = normalizeBaseUrl(context.baseUrl) ?? resolveCoolifyBaseUrl()
    this.apiBaseUrl = this.baseUrl ? toApiBaseUrl(this.baseUrl) : null
  }

  async listContainers(): Promise<CloudDeploymentContainer[]> {
    const response = await this.request('/applications', { method: 'GET' })
    const items = Array.isArray(response) ? response : []
    const projectsByName = await this.projectNamesByUuid()
    return items.flatMap((item): CloudDeploymentContainer[] => {
      const mapped = this.toApplicationContainer(item, projectsByName)
      return mapped ? [mapped] : []
    })
  }

  /**
   * Latest snapshot for one container. The application read is authoritative for
   * identity/timestamps; when a recent deployment record exists its build status
   * and log win over the coarse runtime state, so a failed build still surfaces.
   */
  async getStatus(containerId: string): Promise<CloudDeploymentContainer | null> {
    const application = await this.request(`/applications/${encodeURIComponent(containerId)}`, {
      method: 'GET'
    }).catch((failure: unknown) => {
      if (failure instanceof CoolifyProviderError && failure.status === 404) return null
      throw failure
    })
    if (application === null) return null
    const container = this.toApplicationContainer(application)
    if (!container) return null
    const [latest] = await this.fetchDeployments(containerId)
    if (!latest) return container
    return {
      ...container,
      status: latest.status,
      ...(latest.updatedAt !== undefined ? { updatedAt: latest.updatedAt } : {}),
      ...(latest.log !== undefined ? { log: latest.log } : {})
    }
  }

  /** Capped raw log text for a deployment, or the latest deployment when no id is given. */
  async getLogs(containerId: string, deploymentId?: string): Promise<string> {
    const deployments = await this.fetchDeployments(containerId)
    const target = deploymentId
      ? deployments.find((deployment) => deployment.id === deploymentId)
      : deployments[0]
    if (target?.log) return target.log
    // No deployment log available — fall back to the runtime container output.
    const response = await this.request(
      `/applications/${encodeURIComponent(containerId)}/logs?lines=${DEFAULT_LOG_LINES}`,
      { method: 'GET' }
    )
    const record = this.asRecord(response)
    const logs = typeof record['logs'] === 'string' ? record['logs'] : ''
    return this.capLog(logs)
  }

  /** List the most recent deployments/builds for an application, newest first. */
  async listDeployments(containerId: string): Promise<CloudDeploymentDeployment[]> {
    const deployments = await this.fetchDeployments(containerId)
    return deployments.slice(0, CloudDeploymentDeploymentLimit)
  }

  getProviderInfo(): CloudDeploymentProviderInfo {
    return {
      kind: 'coolify',
      name: COOLIFY_DISPLAY_NAME,
      implemented: true,
      ...(this.baseUrl ? { baseUrl: this.baseUrl } : {})
    }
  }

  /** Fetch deployment records for an application, newest first, or [] when absent. */
  private async fetchDeployments(containerId: string): Promise<CloudDeploymentDeployment[]> {
    const response = await this.request(
      `/deployments/applications/${encodeURIComponent(containerId)}?take=${CloudDeploymentDeploymentLimit}&skip=0`,
      { method: 'GET' }
    ).catch((failure: unknown) => {
      // The per-application deployment list is not present on every Coolify
      // version; a missing route degrades gracefully instead of failing the read.
      if (
        failure instanceof CoolifyProviderError &&
        (failure.status === 404 || failure.status === 405)
      ) {
        return []
      }
      throw failure
    })
    // Some Coolify versions wrap the list in a `{ data: [...] }` envelope.
    const items = Array.isArray(response)
      ? response
      : Array.isArray((response as Record<string, unknown>)['data'])
        ? ((response as Record<string, unknown>)['data'] as unknown[])
        : []
    const deployments: CloudDeploymentDeployment[] = []
    for (const item of items) {
      const deployment = this.toDeployment(item)
      if (deployment) deployments.push(deployment)
    }
    return deployments
  }

  /** Map an `Application` payload to the normalized container model. */
  private toApplicationContainer(
    payload: unknown,
    projectsByName?: Map<string, string>
  ): CloudDeploymentContainer | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const uuid = this.readString(record, 'uuid')
    if (!uuid) return null
    const fqdn = this.readString(record, 'fqdn')
    const rawStatus = this.readString(record, 'status')
    const projectUuid = this.readString(record, 'project_uuid')
    const project =
      this.readString(record, 'project_name') ??
      (projectUuid ? (projectsByName?.get(projectUuid) ?? undefined) : undefined)
    return {
      id: uuid,
      label: this.readString(record, 'name') ?? fqdn ?? uuid,
      providerKind: 'coolify',
      status: mapApplicationStatus(rawStatus),
      url: fqdn ?? undefined,
      ...(project ? { project } : {}),
      createdAt: this.parseEpochMs(this.readString(record, 'created_at')),
      updatedAt: this.parseEpochMs(this.readString(record, 'updated_at'))
    }
  }

  /** Build a `project_uuid -> name` map from the projects endpoint. */
  private async projectNamesByUuid(): Promise<Map<string, string>> {
    try {
      const response = await this.request('/projects', { method: 'GET' })
      const items = Array.isArray(response) ? response : []
      const map = new Map<string, string>()
      for (const item of items) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        const uuid = this.readString(record, 'uuid')
        const name = this.readString(record, 'name')
        if (uuid && name) map.set(uuid, name)
      }
      return map
    } catch {
      // The project list is an enrichment only — never fail the container list
      // because of it.
      return new Map()
    }
  }

  /**
   * Map a deployment-queue payload to the normalized deployment model, or null
   * when the record is not deployment-shaped (the published spec mislabels this
   * endpoint's response as `Application`, so defensive identity checks apply).
   */
  private toDeployment(payload: unknown): CloudDeploymentDeployment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readString(record, 'deployment_uuid')
    const isDeploymentShaped =
      id !== null ||
      typeof record['application_name'] === 'string' ||
      typeof record['logs'] === 'string' ||
      typeof record['commit'] === 'string' ||
      typeof record['commit_message'] === 'string'
    if (!isDeploymentShaped) return null
    const rawStatus = this.readString(record, 'status')
    if (!rawStatus) return null
    const deployment: CloudDeploymentDeployment = {
      id: id ?? rawStatus,
      status: mapDeploymentStatus(rawStatus)
    }
    const log = typeof record['logs'] === 'string' ? record['logs'] : undefined
    if (log) deployment.log = this.capLog(log)
    const updatedAt = this.parseEpochMs(this.readString(record, 'updated_at'))
    if (updatedAt !== undefined) deployment.updatedAt = updatedAt
    const commit = this.readString(record, 'commit')
    if (commit) deployment.commit = commit
    return deployment
  }

  /** Perform a JSON fetch against the Coolify API, sanitizing errors. */
  private async request(
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown> | unknown[]> {
    const apiBaseUrl = this.requireApiBaseUrl()
    const token = this.context.token
    if (!token) {
      throw new CoolifyProviderError(401, 'Coolify API token is not configured')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), COOLIFY_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...init.headers
        },
        signal: controller.signal
      })
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new CoolifyProviderError(response.status, message)
      }
      if (response.status === 204) return {}
      return (await response.json()) as Record<string, unknown> | unknown[]
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Coolify request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  /** Read a provider error body's `message`/`error` field without touching headers. */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body['message'] === 'string') return body['message'].slice(0, 500)
      if (typeof body['error'] === 'string') return body['error'].slice(0, 500)
    } catch {
      // Non-JSON error body — fall through to the status-only message.
    }
    return ''
  }

  private requireApiBaseUrl(): string {
    const apiBaseUrl = this.apiBaseUrl
    if (apiBaseUrl) return apiBaseUrl
    throw new CoolifyProviderError(
      0,
      `Coolify base URL is not configured; set ${COOLIFY_BASE_URL_ENV} or supply a verified base URL`
    )
  }

  private asRecord(payload: Record<string, unknown> | unknown[]): Record<string, unknown> {
    return Array.isArray(payload) ? {} : payload
  }

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private parseEpochMs(value: string | null): number | undefined {
    if (!value) return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  private capLog(log: string): string {
    if (log.length <= MAX_CONTAINER_LOG_BYTES) return log
    return log.slice(0, MAX_CONTAINER_LOG_BYTES)
  }
}

/** Constructor-shape factory matching the provider registry's `DeploymentProviderFactory`. */
export function createCoolifyProvider(context: DeploymentProviderContext): DeploymentProvider {
  return new CoolifyProvider(context)
}

/** Normalize a user-supplied base URL, or null when empty. */
function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed ? trimmed.replace(/\/+$/u, '') : null
}

/** Ensure the API endpoint prefix resolves under `/api/v1` exactly once. */
function toApiBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/u, '')
  if (/\/api\/v1$/u.test(normalized)) return normalized
  return `${normalized}${COOLIFY_API_PREFIX}`
}

/** Application runtime states Coolify reports while the container is up. */
const SUCCESS_APPLICATION_STATUSES = new Set(['running', 'healthy', 'up', 'started', 'degraded'])

/** Application runtime states Coolify reports while a container is (re)starting/building. */
const BUILDING_APPLICATION_STATUSES = new Set([
  'queued',
  'starting',
  'restarting',
  'building',
  'pulling',
  'updating',
  'deploying'
])

/** Application runtime states Coolify reports when the container is down or failing. */
const FAILED_APPLICATION_STATUSES = new Set([
  'exited',
  'stopped',
  'dead',
  'failed',
  'error',
  'unhealthy',
  'not_found',
  'oops'
])

/** Deployment states Coolify reports while a deployment is queued or executing. */
const BUILDING_DEPLOYMENT_STATUSES = new Set([
  'queued',
  'in_progress',
  'running',
  'building',
  'pulling',
  'updating'
])

/** Deployment states Coolify reports when a deployment completed successfully. */
const SUCCESS_DEPLOYMENT_STATUSES = new Set(['finished', 'success', 'completed', 'done'])

/** Deployment states Coolify reports when a deployment failed, timed out, or was cancelled. */
const FAILED_DEPLOYMENT_STATUSES = new Set([
  'failed',
  'error',
  'timeout',
  'timed_out',
  'cancelled',
  'cancelled-by-user',
  'cancelled-by-something'
])

/**
 * Map a Coolify application runtime status to the normalized model. Coolify does
 * not expose deployment build state in the application list, so the coarse runtime
 * state stands in here; {@link CoolifyProvider.getStatus} refines it with the
 * latest deployment record when one exists.
 */
function mapApplicationStatus(raw: string | null): CloudDeploymentStatus {
  const value = (raw ?? '').toLowerCase()
  if (BUILDING_APPLICATION_STATUSES.has(value)) return 'building'
  if (SUCCESS_APPLICATION_STATUSES.has(value)) return 'success'
  if (FAILED_APPLICATION_STATUSES.has(value)) return 'failed'
  return 'unknown'
}

/** Map a Coolify deployment-queue status to the normalized model. */
function mapDeploymentStatus(raw: string | null): CloudDeploymentStatus {
  const value = (raw ?? '').toLowerCase()
  if (BUILDING_DEPLOYMENT_STATUSES.has(value)) return 'building'
  if (SUCCESS_DEPLOYMENT_STATUSES.has(value)) return 'success'
  if (FAILED_DEPLOYMENT_STATUSES.has(value)) return 'failed'
  return 'unknown'
}
