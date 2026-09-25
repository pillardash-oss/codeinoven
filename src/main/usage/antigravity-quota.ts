import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentRateLimitWindow } from '../../lib/types'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { Logger } from '../system/logger'

/**
 * Antigravity plan quota, read straight from Google Cloud Code.
 *
 * `agy` exposes no usage command and its turn payload only carries quota when a
 * turn happens to report one, so an on-demand read has to go to the same service
 * the CLI itself talks to. `retrieveUserQuotaSummary` answers with the merged
 * pools Antigravity meters today (a Gemini pool and a Claude/GPT pool, each with
 * a rolling window), which is the authoritative source; builds without that RPC
 * fall back to the per-model `fetchAvailableModels` snapshot.
 *
 * The read authenticates with the account's own Antigravity OAuth token and
 * refreshes it in memory when it has expired. CodeInOven never writes back to
 * the harness credential store: the CLI refreshes its own token on its next run.
 */

/** Cloud Code base URLs, tried in this order (the daily one serves first). */
const CLOUD_CODE_BASES = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
] as const

const QUOTA_SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary'
const AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Antigravity's installed-application OAuth client, the pair the CLI ships and
 * uses for its refresh grant. Google does not treat an installed-app "secret" as
 * confidential (it is present in every copy of the client), and it is required
 * to exchange the stored refresh token for an access token.
 */
const GOOGLE_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const GOOGLE_CLIENT_SECRET = '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'

/**
 * Cloud Code answers by client identity: with a browser or Go default user
 * agent it routes to the Gemini Code Assist backend, which rejects Antigravity
 * accounts with `403 SUBSCRIPTION_REQUIRED`. This header is what selects
 * Antigravity's own quota service.
 */
const ANTIGRAVITY_USER_AGENT = 'antigravity'

const REQUEST_TIMEOUT_MS = 8_000
/** Treat a token as expired this long before its stated expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000

/** Rolling window length per Cloud Code `window` value, in minutes. */
const WINDOW_MINUTES: Readonly<Record<string, number>> = {
  '5h': 300,
  session: 300,
  daily: 1_440,
  day: 1_440,
  weekly: 10_080,
  week: 10_080,
  monthly: 44_640,
  month: 44_640
}

/** Pool names for bucket ids whose group carries no display name. */
const POOL_BY_BUCKET_PREFIX: ReadonlyArray<[prefix: string, pool: string]> = [
  ['gemini', 'Gemini'],
  ['3p', 'Claude and GPT']
]

const POOL_ORDER = ['Gemini', 'Claude and GPT'] as const

interface AntigravityTokenStore {
  token?: {
    access_token?: string
    refresh_token?: string
    /** ISO-8601 timestamp (the CLI writes an offset-qualified local time). */
    expiry?: string
  }
}

/** Access token minted by a refresh, reused until it expires. */
let cachedAccessToken: { token: string; expiresAt: number } | null = null

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function epochMilliseconds(value: unknown): number | undefined {
  const text = stringValue(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Percent consumed from a `remainingFraction`, at 0.1% precision.
 *  The provider reports the fraction, so the percent is derived and rounded —
 *  raw float noise (`41.838240000000006`) would be persisted otherwise. */
function usedPercentFor(remainingFraction: number): number {
  const percent = Math.max(0, Math.min(100, (1 - remainingFraction) * 100))
  return Math.round(percent * 10) / 10
}

/** `Gemini Models` → `Gemini`, so a pool label reads like a name, not a section. */
function cleanGroupName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.replace(/\s+models?$/iu, '').trim() || undefined
}

function poolNameFor(bucketId: string | undefined, groupName: string | undefined): string {
  if (groupName !== undefined) return groupName
  const normalized = bucketId?.toLocaleLowerCase('en-US')
  const match = POOL_BY_BUCKET_PREFIX.find(([prefix]) => normalized?.startsWith(prefix) === true)
  return match?.[1] ?? 'Antigravity'
}

/** Window wording and length for a Cloud Code `window` value. */
function windowCopy(window: string | undefined): { label?: string; minutes?: number } {
  const normalized = window?.trim().toLocaleLowerCase('en-US')
  if (normalized === undefined || normalized.length === 0) return {}
  const minutes = WINDOW_MINUTES[normalized]
  if (minutes === 300) return { label: '5-hour limit', minutes }
  if (minutes === 1_440) return { label: 'daily limit', minutes }
  if (minutes === 10_080) return { label: 'weekly limit', minutes }
  if (minutes === 44_640) return { label: 'monthly limit', minutes }
  return { label: `${normalized} window` }
}

/**
 * `retrieveUserQuotaSummary` → one window per metered pool bucket. Accepts both
 * the bare payload (`groups`) and the language-server envelope
 * (`response.groups`).
 *
 * Returns `null` when the body is not a summary at all, so the caller can fall
 * back to the per-model snapshot. A parsed summary is authoritative even when it
 * is empty: the fallback pools coarse model quotas and must never be used to
 * dress up a body the provider already answered properly.
 */
export function mapAntigravityQuotaSummary(value: unknown): AgentRateLimitWindow[] | null {
  const root = record(value)
  if (!root) return null
  const envelope = record(root['response']) ?? root
  const groups = envelope['groups']
  if (!Array.isArray(groups)) return null
  const windows: AgentRateLimitWindow[] = []
  const seen = new Set<string>()
  for (const rawGroup of groups) {
    const group = record(rawGroup)
    if (!group) continue
    const groupName = cleanGroupName(stringValue(group['displayName']))
    const buckets = Array.isArray(group['buckets']) ? group['buckets'] : []
    for (const rawBucket of buckets) {
      const bucket = record(rawBucket)
      if (!bucket) continue
      const remainingFraction = finiteNumber(bucket['remainingFraction'])
      if (remainingFraction === undefined) continue
      const bucketId = stringValue(bucket['bucketId'])
      const id = bucketId ?? `${groupName ?? 'pool'}-${windows.length}`
      if (seen.has(id)) continue
      seen.add(id)
      const { label, minutes } = windowCopy(stringValue(bucket['window']))
      const pool = poolNameFor(bucketId, groupName)
      const resetsAt = epochMilliseconds(bucket['resetTime'])
      windows.push({
        id: `antigravity:${id}`,
        label: label === undefined ? pool : `${pool} ${label}`,
        usedPercent: usedPercentFor(remainingFraction),
        ...(minutes === undefined ? {} : { windowMinutes: minutes }),
        ...(resetsAt === undefined ? {} : { resetsAt })
      })
    }
  }
  return windows
}

/**
 * `fetchAvailableModels` fallback → the worst remaining fraction per pool.
 * Every model in a pool shares the pool's limit, so the lowest fraction is what
 * the account can still spend. Internal models (autocomplete and tab previews)
 * are dropped: they are not selectable workload and would skew the pool.
 */
export function mapAntigravityModelQuotas(value: unknown): AgentRateLimitWindow[] {
  const models = record(record(value)?.['models'])
  if (!models) return []
  const pools = new Map<string, { remainingFraction: number; resetsAt?: number }>()
  for (const rawModel of Object.values(models)) {
    const model = record(rawModel)
    if (!model || model['isInternal'] === true) continue
    const quota = record(model['quotaInfo'])
    const remainingFraction = finiteNumber(quota?.['remainingFraction'])
    if (quota === null || remainingFraction === undefined) continue
    const provider = `${stringValue(model['apiProvider']) ?? ''} ${stringValue(model['modelProvider']) ?? ''}`
    const pool = /GEMINI/iu.test(provider) ? POOL_ORDER[0] : POOL_ORDER[1]
    const resetsAt = epochMilliseconds(quota['resetTime'])
    const existing = pools.get(pool)
    if (existing && existing.remainingFraction <= remainingFraction) continue
    pools.set(pool, { remainingFraction, ...(resetsAt === undefined ? {} : { resetsAt }) })
  }
  return POOL_ORDER.flatMap((pool) => {
    const entry = pools.get(pool)
    if (!entry) return []
    return [
      {
        id: `antigravity:${pool}`,
        label: `${pool} limit`,
        usedPercent: usedPercentFor(entry.remainingFraction),
        ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt })
      }
    ]
  })
}

/** Location of the CLI's OAuth token, honoring a HOME override from the caller. */
export function antigravityTokenPath(environment: NodeJS.ProcessEnv): string {
  const home = environment['HOME'] ?? environment['USERPROFILE'] ?? homedir()
  return join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}

type CloudCodeOutcome = { kind: 'ok'; value: unknown } | { kind: 'auth' } | { kind: 'unavailable' }

/** POST one Cloud Code method, degrading to the next base URL on a transport gap. */
async function cloudCodeRequest(
  path: string,
  token: string,
  userAgent: string
): Promise<CloudCodeOutcome> {
  for (const base of CLOUD_CODE_BASES) {
    try {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent
        },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      // A rejected token fails identically on the other base, so stop early.
      if (response.status === 401 || response.status === 403) return { kind: 'auth' }
      if (!response.ok) continue
      return { kind: 'ok', value: (await response.json()) as unknown }
    } catch (error) {
      Logger.dev('Antigravity quota request failed:', error)
    }
  }
  return { kind: 'unavailable' }
}

/** Exchange the stored refresh token for a fresh access token (memory only). */
async function refreshAccessToken(refreshToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) return undefined
    const payload = record((await response.json()) as unknown)
    const accessToken = stringValue(payload?.['access_token'])
    if (accessToken === undefined) return undefined
    const expiresIn = finiteNumber(payload?.['expires_in']) ?? 3_600
    cachedAccessToken = { token: accessToken, expiresAt: Date.now() + expiresIn * 1_000 }
    return accessToken
  } catch (error) {
    Logger.dev('Antigravity token refresh failed:', error)
    return undefined
  }
}

function usableCachedToken(): string | undefined {
  if (!cachedAccessToken) return undefined
  if (cachedAccessToken.expiresAt - TOKEN_EXPIRY_SKEW_MS <= Date.now()) return undefined
  return cachedAccessToken.token
}

function usableStoredToken(store: AntigravityTokenStore): string | undefined {
  const accessToken = stringValue(store.token?.access_token)
  if (accessToken === undefined) return undefined
  const expiry = epochMilliseconds(store.token?.expiry)
  // An undated token is treated as usable: a rejected one still falls through to
  // the refresh path, so the read never depends on the CLI's stamp format.
  if (expiry !== undefined && expiry - TOKEN_EXPIRY_SKEW_MS <= Date.now()) return undefined
  return accessToken
}

async function readTokenStore(path: string): Promise<AntigravityTokenStore | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AntigravityTokenStore
  } catch (error) {
    Logger.dev('Antigravity token store unavailable:', error)
    return null
  }
}

/**
 * The account's current quota, or null when Antigravity cannot report any
 * (not signed in, token revoked, or every endpoint unreachable).
 */
export async function readAntigravityAccountUsage(
  environment: NodeJS.ProcessEnv = {}
): Promise<{ rateLimits: AgentRateLimitWindow[] } | null> {
  const env = buildProcessEnvironment({ ...process.env, ...environment })
  const store = await readTokenStore(antigravityTokenPath(env))
  if (!store) return null
  const refreshToken = stringValue(store.token?.refresh_token)
  let refreshed = false
  let accessToken = usableCachedToken() ?? usableStoredToken(store)
  if (accessToken === undefined && refreshToken !== undefined) {
    accessToken = await refreshAccessToken(refreshToken)
    refreshed = true
  }
  if (accessToken === undefined) return null

  let summary = await cloudCodeRequest(QUOTA_SUMMARY_PATH, accessToken, ANTIGRAVITY_USER_AGENT)
  if (summary.kind === 'auth' && refreshToken !== undefined && !refreshed) {
    const renewed = await refreshAccessToken(refreshToken)
    if (renewed !== undefined) {
      summary = await cloudCodeRequest(QUOTA_SUMMARY_PATH, renewed, ANTIGRAVITY_USER_AGENT)
    }
  }
  if (summary.kind === 'auth') return null
  if (summary.kind === 'ok') {
    const windows = mapAntigravityQuotaSummary(summary.value)
    if (windows) return { rateLimits: windows }
  }

  // A build without the summary RPC: answer from the per-model snapshot instead.
  const models = await cloudCodeRequest(AVAILABLE_MODELS_PATH, accessToken, ANTIGRAVITY_USER_AGENT)
  if (models.kind !== 'ok') return null
  const windows = mapAntigravityModelQuotas(models.value)
  return windows.length > 0 ? { rateLimits: windows } : null
}
