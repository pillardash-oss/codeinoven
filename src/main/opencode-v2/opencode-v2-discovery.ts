import { homedir } from 'node:os'
import { Logger } from '../system/logger'
import type {
  OpenCodeV2AgentEntry,
  OpenCodeV2Catalog,
  OpenCodeV2DiscoveryResult,
  OpenCodeV2ModelEntry,
  OpenCodeV2ProviderEntry,
  OpenCodeV2ServerIdentity
} from '../../lib/types'
import { OpenCodeV2Client } from './opencode-v2-client'
import { startOpenCodeV2Server, type OpenCodeV2ServerHandle } from './opencode-v2-server'

/** The CLI command that ships OpenCode V2 (the package also installs `opencode`). */
export const OPENCODE_V2_COMMAND = 'opencode2'

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
  handle: OpenCodeV2ServerHandle
): Promise<
  | { ok: true; catalog: OpenCodeV2Catalog }
  | { ok: false; reason: 'unreachable' | 'unsupported-version'; detail: string }
> {
  try {
    const client = new OpenCodeV2Client(handle)
    const [info, providers, models, agents] = await Promise.all([
      client.json('/api/info'),
      client.json('/api/provider'),
      client.json('/api/model'),
      client.json('/api/agent')
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
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Spawn a private V2 server, read its catalog, and always tear the server down.
 * The server is short-lived and private (`--port 0`), so a discovery run cannot
 * collide with the user's own background service or another run.
 */
export async function discoverOpenCodeV2Catalog(
  options: {
    command?: string
    cwd?: string
    env?: NodeJS.ProcessEnv
  } = {}
): Promise<OpenCodeV2DiscoveryResult> {
  const command = options.command ?? OPENCODE_V2_COMMAND
  let handle: OpenCodeV2ServerHandle
  try {
    handle = await startOpenCodeV2Server({
      command,
      cwd: options.cwd ?? homedir(),
      ...(options.env ? { env: options.env } : {})
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const missing = /ENOENT|not found/u.test(detail)
    Logger.dev('opencode2 discovery server failed to start:', detail)
    return { ok: false, reason: missing ? 'not-installed' : 'unreachable', detail }
  }

  try {
    const result = await readOpenCodeV2Catalog(handle)
    return result.ok ? result : { ok: false, reason: result.reason, detail: result.detail }
  } finally {
    await handle.close()
  }
}
