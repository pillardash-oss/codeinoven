import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentRateLimitWindow } from '../../lib/types'
import { Logger } from '../system/logger'
import { mapOpenCodeAccountUsage, OPENCODE_ACCOUNT_USAGE_ENDPOINT } from './opencode-provider-usage'
import { apiKeyFromOpenCodeAuth, openCodeAuthPaths, stringValue } from './opencode/opencode-values'

const ACCOUNT_USAGE_TIMEOUT_MS = 10_000

/** Credential store the detected OpenCode line keeps its keys in. */
export type OpenCodeCredentialLine = 'v1' | 'v2'

/** OpenCode's account-wide quota windows, or null when the key has no plan. */
export interface OpenCodeAccountUsage {
  rateLimits: AgentRateLimitWindow[]
}

/**
 * Integration ids the usage endpoint accepts, most specific first. OpenCode Go
 * is the subscription whose caps the endpoint reports; the plain `opencode`
 * (Zen) key is only a fallback for accounts that also hold Go.
 */
const CREDENTIAL_PRIORITY = ['opencode-go', 'opencode'] as const

/**
 * Directories an OpenCode install may keep state in, most specific first.
 * `XDG_DATA_HOME` is what an isolated account container sets, so a managed
 * account is read from its own directory before the user's default home.
 */
export function openCodeDataDirectories(environment: NodeJS.ProcessEnv): string[] {
  const home = homedir()
  return [
    ...(environment['XDG_DATA_HOME'] ? [join(environment['XDG_DATA_HOME'], 'opencode')] : []),
    ...(environment['LOCALAPPDATA'] ? [join(environment['LOCALAPPDATA'], 'opencode')] : []),
    join(home, '.local', 'share', 'opencode'),
    join(home, '.opencode', 'data')
  ].filter((path, index, all) => all.indexOf(path) === index)
}

/**
 * Credential databases to try, `OPENCODE_DB` first when it is set. OpenCode V2
 * stores credentials in SQLite and partitions the store by release channel
 * (`opencode.db`, `opencode-next.db`), so every channel is a candidate.
 */
export async function openCodeCredentialDatabasePaths(
  environment: NodeJS.ProcessEnv
): Promise<string[]> {
  const explicit = environment['OPENCODE_DB']
  if (explicit) return [explicit]
  const databases: string[] = []
  for (const directory of openCodeDataDirectories(environment)) {
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch {
      continue
    }
    for (const name of entries.sort()) {
      if (/^opencode.*\.db$/u.test(name)) databases.push(join(directory, name))
    }
  }
  return databases
}

/**
 * A stored V2 credential is a JSON string. `{"type":"key","key":"..."}` yields
 * its key; an OAuth credential has no key to send as a Bearer token.
 */
export function openCodeApiKeyFromCredentialValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const record = parsed as Record<string, unknown>
  if (record['type'] !== 'key') return undefined
  const key = record['key']
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

interface CredentialRow {
  integrationId: string
  value: string
  active: number
  updatedAt: number
}

/** The slice of a SQLite connection this reader needs. */
interface CredentialStore {
  prepare(sql: string): { all(): unknown }
  close(): void
}

type CredentialStoreConstructor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => CredentialStore

async function openCredentialStore(databasePath: string): Promise<CredentialStore | undefined> {
  let constructor: CredentialStoreConstructor
  try {
    const module = (await import('better-sqlite3')) as unknown
    const candidate =
      module !== null && typeof module === 'object' && 'default' in module
        ? (module as { default: unknown }).default
        : module
    if (typeof candidate !== 'function') return undefined
    constructor = candidate as CredentialStoreConstructor
  } catch (error) {
    Logger.dev('OpenCode V2 credential store unavailable:', error)
    return undefined
  }
  try {
    return new constructor(databasePath, { readonly: true, fileMustExist: true })
  } catch {
    // A missing or locked store simply means no key to read.
    return undefined
  }
}

async function readV2CredentialRows(databasePath: string): Promise<CredentialRow[]> {
  const database = await openCredentialStore(databasePath)
  if (!database) return []
  try {
    const rows = database
      .prepare(
        'SELECT integration_id AS integrationId, value, active, time_updated AS updatedAt FROM credential'
      )
      .all()
    return Array.isArray(rows) ? (rows as CredentialRow[]) : []
  } catch {
    // A store written by a different schema is not a reason to fail a read.
    return []
  } finally {
    database.close()
  }
}

/** V1 keys: an environment override, injected auth content, then `auth.json`. */
async function openCodeV1ApiKey(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const environmentKey = stringValue(environment['OPENCODE_API_KEY'])
  if (environmentKey) return environmentKey

  const authContent = stringValue(environment['OPENCODE_AUTH_CONTENT'])
  if (authContent) {
    try {
      const key = apiKeyFromOpenCodeAuth(JSON.parse(authContent) as unknown)
      if (key) return key
    } catch {
      // Fall back to OpenCode's persisted auth file.
    }
  }

  // A managed account must answer from its own container: its `XDG_DATA_HOME`
  // is set by the registry, and falling through to the default home would
  // report another account's quota under this one.
  for (const path of openCodeAuthPaths(environment, { scopedToDataHome: true })) {
    try {
      const key = apiKeyFromOpenCodeAuth(JSON.parse(await readFile(path, 'utf8')) as unknown)
      if (key) return key
    } catch {
      // OpenCode may not use this platform-specific data path.
    }
  }
  return undefined
}

/** V2 keys: an environment override, then the newest active key in its store. */
async function openCodeV2ApiKey(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  const environmentKey = stringValue(environment['OPENCODE_API_KEY'])
  if (environmentKey) return environmentKey

  for (const databasePath of await openCodeCredentialDatabasePaths(environment)) {
    const rows = await readV2CredentialRows(databasePath)
    for (const integrationId of CREDENTIAL_PRIORITY) {
      const candidates = rows
        .filter((row) => row.integrationId === integrationId)
        .sort((left, right) => right.active - left.active || right.updatedAt - left.updatedAt)
      for (const candidate of candidates) {
        const key = openCodeApiKeyFromCredentialValue(candidate.value)
        if (key) return key
      }
    }
  }
  return undefined
}

/**
 * Read the OpenCode account's rolling, weekly, and monthly quota windows.
 *
 * One implementation serves both version lines because the endpoint is
 * account-wide: only the credential source differs (V1's `auth.json`, V2's
 * SQLite store). A key that is missing, rejected, or has no Go subscription
 * reports null, which lets OpenUsage answer the same question instead.
 */
export async function readOpenCodeAccountUsage(
  environment: NodeJS.ProcessEnv,
  line: OpenCodeCredentialLine
): Promise<OpenCodeAccountUsage | null> {
  const apiKey =
    line === 'v2' ? await openCodeV2ApiKey(environment) : await openCodeV1ApiKey(environment)
  if (!apiKey) return null
  try {
    const response = await fetch(OPENCODE_ACCOUNT_USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(ACCOUNT_USAGE_TIMEOUT_MS)
    })
    // A valid Zen key may not belong to an OpenCode Go subscription. Treat both
    // missing access and missing entitlement as unsupported telemetry.
    if (response.status === 401 || response.status === 403) return null
    if (!response.ok) throw new Error(`OpenCode usage request failed (${response.status})`)
    const rateLimits = mapOpenCodeAccountUsage((await response.json()) as unknown)
    return rateLimits.length > 0 ? { rateLimits } : null
  } catch (error) {
    Logger.dev('OpenCode account usage refresh unavailable:', error)
    return null
  }
}
