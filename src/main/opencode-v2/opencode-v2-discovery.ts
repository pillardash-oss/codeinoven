import { createHash } from 'node:crypto'
import { createWorkQueue } from '../../lib/bounded-work'
import { homedir } from 'node:os'
import { OPENCODE_COMMAND } from '../../lib/opencode-version'
import { Logger } from '../system/logger'
import type {
  OpenCodeV2AgentEntry,
  OpenCodeV2Catalog,
  OpenCodeV2DiscoveryResult,
  OpenCodeV2ModelEntry,
  OpenCodeV2ProviderEntry,
  OpenCodeV2ServerIdentity,
  ProviderCatalog
} from '../../lib/types'
import { OpenCodeV2Client, OpenCodeV2RequestError } from './opencode-v2-client'
import { startOpenCodeV2Server, type OpenCodeV2ServerHandle } from './opencode-v2-server'
import { mapOpenCodeV2Catalogs } from '../drivers/opencode-v2/v2-catalog'

/** The canonical command every OpenCode install provides. */
export { OPENCODE_COMMAND }

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Unwrap the `{ location, data }` envelope every list endpoint returns. */
function listData(value: unknown): unknown[] {
  return asArray(asRecord(value)?.['data'])
}

/** Map `GET /api/info` into the server identity, or `null` when malformed. */
export function mapOpenCodeV2ServerIdentity(value: unknown): OpenCodeV2ServerIdentity | null {
  const record = asRecord(value)
  const version = asString(record?.['version'])
  const pid = asNumber(record?.['pid'])
  if (!record || !version || pid === undefined) return null
  const urls = asArray(record['urls']).filter((url): url is string => typeof url === 'string')
  return { version, pid, urls }
}

/** Map `GET /api/provider` entries, dropping anything without a stable id/name. */
export function mapOpenCodeV2Providers(value: unknown): OpenCodeV2ProviderEntry[] {
  const providers: OpenCodeV2ProviderEntry[] = []
  for (const item of listData(value)) {
    const record = asRecord(item)
    const id = asString(record?.['id'])
    const name = asString(record?.['name'])
    if (!id || !name) continue
    const activation = asString(record?.['activation'])
    providers.push({
      id,
      name,
      activation:
        activation === 'auto' || activation === 'enabled' || activation === 'disabled'
          ? activation
          : 'auto',
      package: asString(record?.['package']) ?? '',
      ...(asString(record?.['integrationID'])
        ? { integrationId: asString(record?.['integrationID']) as string }
        : {})
    })
  }
  return providers
}

/** Map `GET /api/model` entries, dropping anything without a stable id. */
export function mapOpenCodeV2Models(value: unknown): OpenCodeV2ModelEntry[] {
  const models: OpenCodeV2ModelEntry[] = []
  for (const item of listData(value)) {
    const record = asRecord(item)
    const id = asString(record?.['id'])
    const name = asString(record?.['name'])
    if (!record || !id || !name) continue
    const capabilities = asRecord(record['capabilities'])
    const limit = asRecord(record['limit'])
    const status = asString(record['status'])
    models.push({
      id,
      modelId: asString(record['modelID']) ?? id,
      providerId: asString(record['providerID']) ?? '',
      name,
      ...(asString(record['family']) ? { family: asString(record['family']) as string } : {}),
      status:
        status === 'alpha' || status === 'beta' || status === 'deprecated' ? status : 'active',
      enabled: asBoolean(record['enabled']) ?? true,
      contextLimit: asNumber(limit?.['context']) ?? 0,
      outputLimit: asNumber(limit?.['output']) ?? 0,
      tools: asBoolean(capabilities?.['tools']) ?? false,
      inputs: asArray(capabilities?.['input']).filter(
        (entry): entry is string => typeof entry === 'string'
      ),
      outputs: asArray(capabilities?.['output']).filter(
        (entry): entry is string => typeof entry === 'string'
      )
    })
  }
  return models
}

/** Map `GET /api/agent` entries, dropping anything without a stable id/name. */
export function mapOpenCodeV2Agents(value: unknown): OpenCodeV2AgentEntry[] {
  const agents: OpenCodeV2AgentEntry[] = []
  for (const item of listData(value)) {
    const record = asRecord(item)
    const id = asString(record?.['id'])
    const name = asString(record?.['name'])
    if (!record || !id || !name) continue
    const mode = asString(record['mode'])
    agents.push({
      id,
      name,
      ...(asString(record['description'])
        ? { description: asString(record['description']) as string }
        : {}),
      mode: mode === 'subagent' || mode === 'primary' ? mode : 'all',
      hidden: asBoolean(record['hidden']) ?? false
    })
  }
  return agents
}

/**
 * Read a complete catalog from a running server. The caller owns the handle's
 * lifetime; this function only issues reads.
 */
export async function readOpenCodeV2Catalog(
  handle: OpenCodeV2ServerHandle,
  signal?: AbortSignal
): Promise<
  | { ok: true; catalog: OpenCodeV2Catalog }
  | {
      ok: false
      reason: 'unreachable' | 'unsupported-version'
      detail: string
      /** The failure is the location still activating, so a retry can succeed. */
      retryable?: boolean
    }
> {
  try {
    const client = new OpenCodeV2Client(handle)
    const [info, providers, models, agents] = await Promise.all([
      client.json('/api/info', { signal }),
      client.json('/api/provider', { signal }),
      client.json('/api/model', { signal }),
      client.json('/api/agent', { signal })
    ])
    const server = mapOpenCodeV2ServerIdentity(info)
    if (!server) {
      return {
        ok: false,
        reason: 'unsupported-version',
        detail: 'Unrecognised OpenCode V2 info payload'
      }
    }
    return {
      ok: true,
      catalog: {
        server,
        providers: mapOpenCodeV2Providers(providers),
        models: mapOpenCodeV2Models(models),
        agents: mapOpenCodeV2Agents(agents),
        fetchedAt: Date.now()
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof Error ? error.message : String(error),
      ...(isActivationPendingError(error) ? { retryable: true } : {})
    }
  }
}

/**
 * How long a freshly spawned discovery server may take to publish its catalog.
 *
 * V2 boots a location (plugins, providers, catalogs) on its first request, so
 * immediately after `serve` starts `/api/provider` and `/api/model` answer
 * empty. A read taken in that window would show the user an empty catalog, so a
 * fresh handle is polled until it settles.
 */
const CATALOG_SETTLE_TIMEOUT_MS = 45_000
const CATALOG_POLL_INTERVAL_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether a failed read only says the location is still activating.
 *
 * V2 answers the first location-scoped request of a fresh server with a
 * retryable `Location plugins did not finish activating` refusal while its
 * plugins boot. That is a first-boot state, never a broken install, so it must
 * be polled through instead of throwing the whole read away   and never logged
 * as a failure with a stack trace.
 */
export function isActivationPendingError(error: unknown): boolean {
  if (!(error instanceof OpenCodeV2RequestError)) return false
  if (error.status === 409 || error.status === 429 || error.status === 503) return true
  return /did not finish activating|still activating|not ready yet/iu.test(error.message)
}

/**
 * Log one compact line per distinct probe failure.
 *
 * A probe that cannot read a catalog repeats on every caller, and a full stack
 * for each attempt flooded the dev log. The message alone is the actionable
 * part, so it is logged once and then suppressed until the repeat is old enough
 * to be news again.
 */
const probeFailures = new Map<string, number>()
const PROBE_FAILURE_LOG_INTERVAL_MS = 10 * 60_000

function logProbeFailure(label: string, error: unknown): void {
  const status = error instanceof OpenCodeV2RequestError ? ` (${error.status})` : ''
  const message = error instanceof Error ? error.message : String(error)
  const line = `${label}${status}: ${message}`
  const now = Date.now()
  const last = probeFailures.get(line)
  if (last !== undefined && now - last < PROBE_FAILURE_LOG_INTERVAL_MS) return
  probeFailures.set(line, now)
  Logger.dev(line)
}

/**
 * Read a catalog, polling through the server's first-boot window.
 *
 * The catalog is considered settled as soon as it exposes any provider or
 * model; a genuinely empty install is returned as-is once the window elapses.
 */
async function readSettledCatalog(
  handle: OpenCodeV2ServerHandle,
  signal?: AbortSignal
): Promise<
  | { ok: true; catalog: OpenCodeV2Catalog }
  | { ok: false; reason: 'unreachable' | 'unsupported-version'; detail: string }
> {
  const deadline = Date.now() + CATALOG_SETTLE_TIMEOUT_MS
  let result = await readOpenCodeV2Catalog(handle, signal)
  while (Date.now() < deadline) {
    const settled =
      result.ok && (result.catalog.providers.length > 0 || result.catalog.models.length > 0)
    const activating = !result.ok && result.retryable === true
    if (!settled && !activating) break
    await delay(CATALOG_POLL_INTERVAL_MS)
    result = await readOpenCodeV2Catalog(handle, signal)
  }
  return result
}

/**
 * Spawn a private V2 server, read its catalog, and always tear the server down.
 * The server is short-lived and private (`--port 0`), so a discovery run cannot
 * collide with the user's own background service or another run.
 */
async function runOpenCodeV2Catalog(
  options: {
    command?: string
    cwd?: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
  } = {}
): Promise<OpenCodeV2DiscoveryResult> {
  const command = options.command ?? OPENCODE_COMMAND
  let handle: OpenCodeV2ServerHandle
  try {
    handle = await startOpenCodeV2Server({
      command,
      signal: options.signal,
      cwd: options.cwd ?? homedir(),
      ...(options.env ? { env: options.env } : {})
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const missing = /ENOENT|not found/u.test(detail)
    logProbeFailure('OpenCode V2 discovery server failed to start', error)
    return { ok: false, reason: missing ? 'not-installed' : 'unreachable', detail }
  }

  try {
    const result = await readSettledCatalog(handle, options.signal)
    return result.ok ? result : { ok: false, reason: result.reason, detail: result.detail }
  } finally {
    await handle.close()
  }
}

/** Probe the provider catalog on an ephemeral server that always gets closed. */
async function runOpenCodeV2ProviderCatalogs(options: {
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<ProviderCatalog[]> {
  let handle: OpenCodeV2ServerHandle
  try {
    handle = await startOpenCodeV2Server(options)
  } catch (error) {
    logProbeFailure('OpenCode V2 provider probe could not start', error)
    return []
  }
  try {
    const client = new OpenCodeV2Client(handle)
    const query = client.locationQuery(options.cwd)
    const deadline = Date.now() + CATALOG_SETTLE_TIMEOUT_MS
    for (;;) {
      options.signal?.throwIfAborted()
      try {
        const [models, providers] = await Promise.all([
          client.json(`/api/model?${query}`, { timeoutMs: 30_000, signal: options.signal }),
          client
            .json(`/api/provider?${query}`, { timeoutMs: 30_000, signal: options.signal })
            .catch(() => null)
        ])
        const catalogs = mapOpenCodeV2Catalogs(models, providers)
        if (catalogs.length > 0) {
          // A read that produced a catalog ends the failure streak, so a later
          // regression is logged again instead of being suppressed as a repeat.
          probeFailures.clear()
          return catalogs
        }
        if (Date.now() >= deadline) return catalogs
      } catch (error) {
        // The first location-scoped read of a fresh server is refused while its
        // plugins activate. Read again instead of discarding the whole probe.
        if (!isActivationPendingError(error) || Date.now() >= deadline) throw error
      }
      await delay(CATALOG_POLL_INTERVAL_MS)
    }
  } catch (error) {
    logProbeFailure('OpenCode V2 provider probe failed', error)
    return []
  } finally {
    await handle.close()
  }
}

// Discovery servers are temporary and can be expensive on low-end Windows.
// The slot covers startup, reads and teardown, even after a picker deadline.
const discoveryQueue = createWorkQueue(1)
const discoveryRequests = new Map<string, Promise<unknown>>()

/**
 * How long a completed discovery may be reused before it runs again.
 *
 * A discovery is not a query: it spawns a private `opencode serve` and tears it
 * down, so the cost is the process boot and its plugin activation, not the read.
 * The provider/model catalog only changes when a provider is installed or a
 * catalog updates, while callers ask for it on every turn and every poll. Without
 * a cache that turned into hundreds of server spawns a day (238-409 in the
 * durable log) competing with the app's own startup work.
 */
const PROVIDER_CATALOG_TTL_MS = 5 * 60_000
const discoveryResults = new Map<string, { at: number; value: unknown }>()

function cachedDiscovery<T>(key: string, ttlMs: number): T | null {
  if (ttlMs <= 0) return null
  const cached = discoveryResults.get(key)
  if (!cached) return null
  if (Date.now() - cached.at >= ttlMs) {
    discoveryResults.delete(key)
    return null
  }
  return cached.value as T
}

function queuedDiscovery<T>(
  kind: string,
  options: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv },
  run: (signal: AbortSignal) => Promise<T>,
  ttlMs = 0
): Promise<T> {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(options.env ?? process.env).sort(([a], [b]) => a.localeCompare(b))
      )
    )
    .digest('hex')
  const key = JSON.stringify([
    kind,
    options.command ?? OPENCODE_COMMAND,
    options.cwd ?? homedir(),
    fingerprint
  ])
  const cached = cachedDiscovery<T>(key, ttlMs)
  if (cached !== null) return Promise.resolve(cached)
  const pending = discoveryRequests.get(key)
  if (pending) return pending as Promise<T>
  const request = discoveryQueue(async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CATALOG_SETTLE_TIMEOUT_MS)
    try {
      return await run(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  })
    .then((value) => {
      // Only completed reads are remembered: a failed spawn is a real signal and
      // must be retried by the next caller rather than served from a cache.
      if (ttlMs > 0) discoveryResults.set(key, { at: Date.now(), value })
      return value
    })
    .finally(() => discoveryRequests.delete(key))
  discoveryRequests.set(key, request)
  return request
}

export function discoverOpenCodeV2Catalog(
  options: { command?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<OpenCodeV2DiscoveryResult> {
  return queuedDiscovery('catalog', options, (signal) =>
    runOpenCodeV2Catalog({ ...options, signal })
  )
}

export function discoverOpenCodeV2ProviderCatalogs(options: {
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
}): Promise<ProviderCatalog[]> {
  return queuedDiscovery(
    'providers',
    options,
    (signal) => runOpenCodeV2ProviderCatalogs({ ...options, signal }),
    PROVIDER_CATALOG_TTL_MS
  )
}

/**
 * Drop every cached discovery so the next read reflects a change this process
 * just made (an install, a provider edit, a version switch).
 */
export function invalidateOpenCodeV2DiscoveryCache(): void {
  discoveryResults.clear()
}
