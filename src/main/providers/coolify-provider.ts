import type {
  CloudDeploymentContainer,
  CloudDeploymentDeployment,
  CloudDeploymentLogSource,
  CloudDeploymentProviderKind,
  CloudDeploymentStatus
} from '../../lib/types'
import { load as parseYaml } from 'js-yaml'
import type {
  CloudDeploymentProviderInfo,
  DeploymentProvider,
  DeploymentProviderContext
} from './deployment-provider.interface'
import { COOLIFY_BASE_URL_ENV, resolveCoolifyBaseUrl } from './base-url'
import { capDeploymentLogPayload, MAX_DEPLOYMENT_LOG_CHARACTERS } from './deployment-log-cap'

/** Human-readable platform name surfaced by the Cloud Deployments panel. */
export const COOLIFY_DISPLAY_NAME = 'Coolify'

/** Path prefix all Coolify API v1 operations live under. */
export const COOLIFY_API_PREFIX = '/api/v1'

/** Network timeout so a slow instance never hangs the UI. */
const COOLIFY_FETCH_TIMEOUT_MS = 15_000

/** Cap on the raw deployment/runtime log text streamed into the app (roughly 200 KB). */
const MAX_CONTAINER_LOG_BYTES = MAX_DEPLOYMENT_LOG_CHARACTERS

/** Runtime log lines requested when no deployment log is available. */
const DEFAULT_LOG_LINES = 200

/** Coolify build pack that runs a whole docker-compose file as one resource. */
const DOCKER_COMPOSE_BUILD_PACK = 'dockercompose'

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
 *   container output, used as a fallback when no deployment record exists. A
 *   docker-compose resource runs several containers, and without a
 *   `service_name` Coolify serves exactly one of them (the first that is
 *   running), so the adapter asks for a named service whenever the panel picked
 *   one from the container's `logSources`.
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
    const projectResolver = await this.projectResolver()
    return items.flatMap((item): CloudDeploymentContainer[] => {
      const mapped = this.toApplicationContainer(item, projectResolver)
      return mapped ? [mapped] : []
    })
  }

  /**
   * Latest snapshot for one container. The application read is authoritative for
   * identity/timestamps and the live runtime state (`runtimeStatus`); the latest
   * deployment record supplies the last deployment outcome (`status`) and log, so
   * a failed build surfaces without being mistaken for the container being down.
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
    const logSources = this.readComposeLogSources(application)
    const [latest] = await this.fetchDeployments(containerId, 'latest')
    const withSources = logSources.length > 1 ? { ...container, logSources } : container
    if (!latest) return withSources
    return {
      ...withSources,
      status: latest.status,
      ...(latest.updatedAt !== undefined ? { updatedAt: latest.updatedAt } : {}),
      ...(latest.log !== undefined ? { log: latest.log } : {})
    }
  }

  /**
   * Capped raw log text for a deployment, or the latest deployment when no id
   * is given, or one container's runtime output when `serviceName` is set.
   */
  async getLogs(containerId: string, deploymentId?: string, serviceName?: string): Promise<string> {
    // A named compose service is a runtime read: the deployment record holds the
    // whole stack's build log, never one container's output.
    if (serviceName) return this.runtimeLogs(containerId, serviceName)
    // One deployment's log is asked for at a time, so read that deployment
    // instead of pulling every log in the history just to drop all but one.
    if (deploymentId) {
      const single = await this.readDeploymentLog(deploymentId)
      if (single !== null) return single
    }
    const deployments = await this.fetchDeployments(containerId, deploymentId ? 'all' : 'latest')
    const target = deploymentId
      ? deployments.find((deployment) => deployment.id === deploymentId)
      : deployments[0]
    if (target?.log) return target.log
    // No deployment log available   fall back to the runtime container output.
    return this.runtimeLogs(containerId)
  }

  /**
   * Read an application's runtime container output. With `serviceName` Coolify
   * filters to that compose service's container; without it Coolify serves the
   * first running container of the stack.
   */
  private async runtimeLogs(containerId: string, serviceName?: string): Promise<string> {
    const serviceQuery = serviceName ? `&service_name=${encodeURIComponent(serviceName)}` : ''
    const response = await this.request(
      `/applications/${encodeURIComponent(containerId)}/logs?lines=${DEFAULT_LOG_LINES}${serviceQuery}`,
      { method: 'GET' }
    )
    const record = this.asRecord(response)
    const logs = typeof record['logs'] === 'string' ? record['logs'] : ''
    return this.capLog(logs)
  }

  /**
   * The containers inside a docker-compose resource, in the order the compose
   * file declares them.
   *
   * Coolify's compose resources carry the file it deploys in `docker_compose`
   * (already parsed, plain text) and the user's original in `docker_compose_raw`,
   * so the service names are read from those services. Anything that is not a
   * compose resource   or a file that does not parse   reports no streams, which
   * keeps a single-container deployment on its deployment log alone.
   */
  private readComposeLogSources(payload: unknown): CloudDeploymentLogSource[] {
    if (typeof payload !== 'object' || payload === null) return []
    const record = payload as Record<string, unknown>
    const buildPack = this.readString(record, 'build_pack')
    const composeFile =
      this.readString(record, 'docker_compose') ?? this.readString(record, 'docker_compose_raw')
    if (!composeFile) return []
    if (buildPack !== null && buildPack !== DOCKER_COMPOSE_BUILD_PACK) return []
    let services: unknown
    try {
      const parsed: unknown = parseYaml(composeFile)
      if (typeof parsed !== 'object' || parsed === null) return []
      services = (parsed as Record<string, unknown>)['services']
    } catch {
      return []
    }
    if (typeof services !== 'object' || services === null || Array.isArray(services)) return []
    const names = Object.keys(services as Record<string, unknown>).filter(
      (name) => name.trim() !== ''
    )
    return names.map((name) => ({ id: name, label: name }))
  }

  /**
   * Capped log of one deployment read on its own, or null when this Coolify
   * version does not serve that route (older builds 404/405 it) so the caller
   * can fall back to the per-application deployment list.
   */
  private async readDeploymentLog(deploymentId: string): Promise<string | null> {
    const response = await this.request(`/deployments/${encodeURIComponent(deploymentId)}`, {
      method: 'GET'
    }).catch((failure: unknown) => {
      if (
        failure instanceof CoolifyProviderError &&
        (failure.status === 404 || failure.status === 405)
      ) {
        return null
      }
      throw failure
    })
    if (response === null) return null
    const record = this.asRecord(response)
    const logs = typeof record['logs'] === 'string' ? record['logs'] : ''
    return logs ? this.capLog(logs) : null
  }

  /**
   * List the most recent deployments/builds for an application, newest first.
   * The history rows only need metadata, so no logs ride along.
   */
  async listDeployments(containerId: string): Promise<CloudDeploymentDeployment[]> {
    const deployments = await this.fetchDeployments(containerId, 'none')
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

  /**
   * Fetch deployment records for an application, newest first, or [] when absent.
   *
   * `logSelection` decides which records carry their (capped) log, because a
   * history of ten deployments would otherwise pull ten logs over IPC for the
   * one the detail view actually opens.
   */
  private async fetchDeployments(
    containerId: string,
    logSelection: 'none' | 'latest' | 'all'
  ): Promise<CloudDeploymentDeployment[]> {
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
    // The endpoint returns `{ count, deployments: [...] }`; some versions also
    // wrap in `{ data: [...] }` or return a bare array. Handle all shapes.
    const record = Array.isArray(response) ? {} : (response as Record<string, unknown>)
    const items = Array.isArray(response)
      ? response
      : Array.isArray(record['deployments'])
        ? (record['deployments'] as unknown[])
        : Array.isArray(record['data'])
          ? (record['data'] as unknown[])
          : []
    const deployments: CloudDeploymentDeployment[] = []
    for (const item of items) {
      const needsLog =
        logSelection === 'all' || (logSelection === 'latest' && deployments.length === 0)
      const deployment = this.toDeployment(item, needsLog)
      if (deployment) deployments.push(deployment)
    }
    return deployments
  }

  /** Map an `Application` payload to the normalized container model. */
  private toApplicationContainer(
    payload: unknown,
    projectResolver?: CloudDeploymentProjectResolver
  ): CloudDeploymentContainer | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const uuid = this.readString(record, 'uuid')
    if (!uuid) return null
    const fqdn = this.readString(record, 'fqdn')
    const urls = this.readDomains(record)
    const rawStatus = this.readString(record, 'status')
    const projectUuid = this.readString(record, 'project_uuid')
    const environmentId =
      typeof record['environment_id'] === 'number' ? record['environment_id'] : undefined
    const project =
      this.readString(record, 'project_name') ??
      projectResolver?.resolveProject(projectUuid ?? null, environmentId)
    return {
      id: uuid,
      label: this.readString(record, 'name') ?? fqdn ?? uuid,
      providerKind: 'coolify',
      // The application read carries no deployment record, so the last deployment
      // outcome is unknown here; getStatus() refines it from the deployment list.
      status: 'unknown',
      runtimeStatus: mapApplicationStatus(rawStatus),
      url: fqdn ?? undefined,
      ...(urls.length > 0 ? { urls } : {}),
      ...(project ? { project } : {}),
      createdAt: this.parseEpochMs(this.readString(record, 'created_at')),
      updatedAt: this.parseEpochMs(this.readString(record, 'updated_at'))
    }
  }

  /**
   * Collect every domain Coolify reports for an application. Coolify may expose
   * them as a single `fqdn` (occasionally comma-separated) and/or an array in
   * `fqdns`/`domains`. Each entry is trimmed of whitespace and a trailing
   * slash, and the list is deduplicated while preserving order.
   */
  private readDomains(record: Record<string, unknown>): string[] {
    const collected: string[] = []
    const push = (value: unknown): void => {
      if (typeof value !== 'string') return
      for (const raw of value.split(',')) {
        const domain = raw.trim().replace(/\/+$/u, '')
        if (domain) collected.push(domain)
      }
    }
    const arrayValue = record['fqdns'] ?? record['domains']
    if (Array.isArray(arrayValue)) {
      for (const item of arrayValue) push(item)
    }
    const single = this.readString(record, 'fqdn')
    if (single) push(single)
    const seen = new Set<string>()
    const unique: string[] = []
    for (const domain of collected) {
      if (!seen.has(domain)) {
        seen.add(domain)
        unique.push(domain)
      }
    }
    return unique
  }

  /**
   * Build a resolver that maps an application to its Coolify project name.
   *
   * Coolify's `/applications` list returns each application's `environment_id`
   * but not the project name or `project_uuid`. To recover the project we load
   * `/projects` (project uuid + name) and, for each project, its environments
   * (`/projects/{uuid}/environments` → environment `id` + `project_id`). The
   * resolver then maps an application by its `environment_id` (via project_id)
   * or directly by `project_uuid` when a version exposes it.
   */
  private async projectResolver(): Promise<CloudDeploymentProjectResolver> {
    const resolver = new CloudDeploymentProjectResolver()
    try {
      const projectsResponse = await this.request('/projects', { method: 'GET' })
      const projects = Array.isArray(projectsResponse) ? projectsResponse : []
      await Promise.all(
        projects.map(async (projectItem) => {
          if (typeof projectItem !== 'object' || projectItem === null) return
          const project = projectItem as Record<string, unknown>
          const projectUuid = this.readString(project, 'uuid')
          const projectId = typeof project['id'] === 'number' ? project['id'] : undefined
          const projectName = this.readString(project, 'name')
          if (projectUuid && projectName) resolver.addProjectUuid(projectUuid, projectName)
          if (projectId === undefined || !projectUuid || !projectName) return
          const envsResponse = await this.request(
            `/projects/${encodeURIComponent(projectUuid)}/environments`,
            { method: 'GET' }
          ).catch(() => [])
          const environments = Array.isArray(envsResponse) ? envsResponse : []
          for (const envItem of environments) {
            if (typeof envItem !== 'object' || envItem === null) continue
            const env = envItem as Record<string, unknown>
            const environmentId = typeof env['id'] === 'number' ? env['id'] : undefined
            if (environmentId !== undefined) resolver.addEnvironment(environmentId, projectName)
          }
        })
      )
    } catch {
      // Project resolution is an enrichment only   never fail the container list.
    }
    return resolver
  }

  /**
   * Map a deployment-queue payload to the normalized deployment model, or null
   * when the record is not deployment-shaped (the published spec mislabels this
   * endpoint's response as `Application`, so defensive identity checks apply).
   */
  private toDeployment(payload: unknown, includeLog: boolean): CloudDeploymentDeployment | null {
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
    const log = includeLog && typeof record['logs'] === 'string' ? record['logs'] : undefined
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
        const detail = await this.readErrorMessage(response)
        throw new CoolifyProviderError(
          response.status,
          // Never propagate an empty message: the renderer surfaces this text
          // verbatim, so a status-only failure still explains what happened.
          detail || `Coolify API request failed with HTTP ${response.status}`
        )
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
      // Non-JSON error body   fall through to the status-only message.
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

  /**
   * Trim an oversized log while keeping a payload the renderer can still read.
   * Structured (JSON array) logs keep their newest entries; plain text keeps
   * its leading characters.
   */
  private capLog(log: string): string {
    return capDeploymentLogPayload(log, MAX_CONTAINER_LOG_BYTES)
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

/** Deployment states Coolify reports when a deployment failed or timed out. */
const FAILED_DEPLOYMENT_STATUSES = new Set(['failed', 'error', 'timeout', 'timed_out'])

/**
 * Deployment states Coolify reports when a deployment was stopped before it
 * finished. A cancellation is reported as its own outcome, never as a failure:
 * the run did not break, somebody ended it.
 */
const CANCELLED_DEPLOYMENT_STATUSES = new Set([
  'cancelled',
  'canceled',
  'cancelled-by-user',
  'cancelled-by-something'
])

/**
 * Map a Coolify application runtime status to the normalized model. Coolify does
 * not expose deployment build state in the application list, so this only ever
 * feeds `runtimeStatus` (whether the container is up); {@link CoolifyProvider.getStatus}
 * refines the deployment outcome separately from the latest deployment record.
 */
function mapApplicationStatus(raw: string | null): CloudDeploymentStatus {
  const value = applicationRuntimeState(raw)
  if (BUILDING_APPLICATION_STATUSES.has(value)) return 'building'
  if (SUCCESS_APPLICATION_STATUSES.has(value)) return 'success'
  if (FAILED_APPLICATION_STATUSES.has(value)) return 'failed'
  return 'unknown'
}

/**
 * Extract the runtime state segment from a Coolify application `status`.
 *
 * Coolify always renders an application's runtime state as a compound string
 * that appends the container health, for example `running:healthy`,
 * `exited:unhealthy`, or the older `running (healthy)` form. Only the segment
 * before the separator says whether the container is up, so that is the part
 * this adapter maps; the health suffix stays Coolify's own presentation and is
 * deliberately not folded into the normalized runtime model.
 */
function applicationRuntimeState(raw: string | null): string {
  const value = (raw ?? '').trim().toLowerCase()
  return (value.split(/[:(]/u, 1)[0] ?? '').trim()
}

/** Map a Coolify deployment-queue status to the normalized model. */
function mapDeploymentStatus(raw: string | null): CloudDeploymentStatus {
  const value = (raw ?? '').toLowerCase()
  if (BUILDING_DEPLOYMENT_STATUSES.has(value)) return 'building'
  if (SUCCESS_DEPLOYMENT_STATUSES.has(value)) return 'success'
  if (CANCELLED_DEPLOYMENT_STATUSES.has(value)) return 'cancelled'
  if (FAILED_DEPLOYMENT_STATUSES.has(value)) return 'failed'
  return 'unknown'
}

/**
 * Resolves an application to its Coolify project name. Coolify's application
 * list carries only `environment_id`; project names are recovered by mapping
 * `environment_id -> project_id -> project name` via `/projects` and each
 * project's `/environments`.
 */
class CloudDeploymentProjectResolver {
  private readonly byProjectUuid = new Map<string, string>()
  private readonly byEnvironmentId = new Map<number, string>()

  addProjectUuid(projectUuid: string, name: string): void {
    this.byProjectUuid.set(projectUuid, name)
  }

  addEnvironment(environmentId: number, projectName: string): void {
    this.byEnvironmentId.set(environmentId, projectName)
  }

  resolveProject(
    projectUuid: string | null,
    environmentId: number | undefined
  ): string | undefined {
    if (projectUuid) {
      const byUuid = this.byProjectUuid.get(projectUuid)
      if (byUuid) return byUuid
    }
    if (environmentId !== undefined) {
      const byEnvironment = this.byEnvironmentId.get(environmentId)
      if (byEnvironment) return byEnvironment
    }
    return undefined
  }
}
