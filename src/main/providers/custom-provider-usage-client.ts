/**
 * Reads account quota telemetry from a custom provider's user-defined usage
 * route (`BaseUrlProvider.usagePath`).
 *
 * Providers backed by a subscription expose very different status contracts —
 * `new-api`/`one-api` deployments answer `${baseURL}/status` with quota
 * objects, OpenAI-compatible gateways answer `${baseURL}/usage` with data
 * arrays, and bespoke proxies answer with flat objects. Rather than rejecting
 * everything that is not one exact schema, this reader recognizes the common
 * shapes and maps whatever it can into `AgentRateLimitWindow`s. A route that
 * parses to nothing yields `null` — the UI simply shows no bars.
 */
import type { AgentRateLimitWindow, AgentUsageCredits, CustomProviderUsage } from '../../lib/types'
import { Logger } from '../system/logger'

const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 30_000
const MAX_WINDOWS = 16
/** Hard cap on JSON bodies so a misbehaving route cannot balloon memory. */
const MAX_BODY_BYTES = 1_000_000

interface CacheEntry {
  expiresAt: number
  value: CustomProviderUsage | null
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CustomProviderUsage | null>>()

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function epochMilliseconds(value: unknown): number | undefined {
  const direct = finiteNumber(value)
  if (direct !== undefined)
    return direct > 1e12 ? direct : direct > 1e9 ? direct * 1_000 : undefined
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function titleCase(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]/gu, ' ')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'Quota'
}

/** Resolve a stored route (absolute URL or root-relative path) against the base URL. */
export function resolveUsageUrl(baseURL: string, usagePath: string): string {
  if (/^https?:\/\//iu.test(usagePath)) return usagePath
  const base = baseURL.replace(/\/+$/u, '')
  return `${base}${usagePath.startsWith('/') ? usagePath : `/${usagePath}`}`
}

interface QuotaCandidate {
  label: string
  used?: number
  limit?: number
  remaining?: number
  usedPercent?: number
  resetsAt?: number
  windowMinutes?: number
}

/** Pull quota fields out of one arbitrary object, tolerating many key spellings. */
function quotaFromObject(entry: Record<string, unknown>, label: string): QuotaCandidate | null {
  const used = finiteNumber(entry['used'] ?? entry['current'] ?? entry['usage'])
  const limit = finiteNumber(entry['limit'] ?? entry['quota'] ?? entry['total'] ?? entry['max'])
  const remaining = finiteNumber(entry['remaining'] ?? entry['left'] ?? entry['available'])
  const usedPercent = finiteNumber(entry['usedPercent'] ?? entry['percent'] ?? entry['utilization'])
  const resetsAt = epochMilliseconds(
    entry['resetsAt'] ?? entry['reset'] ?? entry['resetAt'] ?? entry['expires']
  )
  const windowSeconds = finiteNumber(entry['windowSeconds'])
  const windowMinutes = finiteNumber(entry['windowMinutes'])
  if (
    used === undefined &&
    limit === undefined &&
    remaining === undefined &&
    usedPercent === undefined
  ) {
    return null
  }
  return {
    label,
    ...(used === undefined ? {} : { used }),
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowMinutes !== undefined
      ? { windowMinutes }
      : windowSeconds !== undefined
        ? { windowMinutes: windowSeconds / 60 }
        : {})
  }
}

/** Recursively walk a JSON body and collect every object that looks like a quota. */
function collectQuotas(value: unknown, path: string, out: QuotaCandidate[]): void {
  if (out.length >= MAX_WINDOWS * 4) return
  const entry = record(value)
  if (entry) {
    const name = typeof entry['name'] === 'string' ? entry['name'] : undefined
    const label = name ?? titleCase(path.split('/').pop() ?? 'Quota')
    const candidate = quotaFromObject(entry, label)
    if (candidate) {
      out.push(candidate)
      return
    }
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectQuotas(item, `${path}/${index}`, out))
    return
  }
  if (entry) {
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'data' || key === 'items' || key === 'resources' || key === 'limits') {
        collectQuotas(child, `${path}/${key}`, out)
      } else if (record(child) || Array.isArray(child)) {
        collectQuotas(child, `${path}/${key}`, out)
      }
    }
  }
}

function toWindow(candidate: QuotaCandidate, index: number): AgentRateLimitWindow | null {
  let usedPercent = candidate.usedPercent
  if (
    usedPercent === undefined &&
    candidate.used !== undefined &&
    candidate.limit !== undefined &&
    candidate.limit > 0
  ) {
    usedPercent = (candidate.used / candidate.limit) * 100
  }
  if (
    usedPercent === undefined &&
    candidate.remaining !== undefined &&
    candidate.limit !== undefined &&
    candidate.limit > 0
  ) {
    usedPercent = ((candidate.limit - candidate.remaining) / candidate.limit) * 100
  }
  if (
    usedPercent === undefined &&
    candidate.used === undefined &&
    candidate.limit === undefined &&
    candidate.remaining === undefined
  ) {
    return null
  }
  return {
    id: `custom:${index}`,
    label: candidate.label,
    ...(usedPercent === undefined ? {} : { usedPercent: Math.max(0, Math.min(100, usedPercent)) }),
    ...(candidate.remaining === undefined ? {} : { remaining: candidate.remaining }),
    ...(candidate.limit === undefined ? {} : { limit: candidate.limit }),
    ...(candidate.resetsAt === undefined ? {} : { resetsAt: candidate.resetsAt }),
    ...(candidate.windowMinutes === undefined ? {} : { windowMinutes: candidate.windowMinutes })
  }
}

/** Extract prepaid credits when the body reports a balance-like field. */
function creditsFromBody(body: unknown): AgentUsageCredits | undefined {
  const entry = record(body)
  if (!entry) return undefined
  const balance = finiteNumber(
    entry['balance'] ?? entry['credit'] ?? entry['credits'] ?? entry['quota']
  )
  if (balance === undefined) return undefined
  return { hasCredits: true, balance }
}

function parseUsageBody(body: unknown): CustomProviderUsage['rateLimits'] {
  const candidates: QuotaCandidate[] = []
  collectQuotas(body, '', candidates)
  const windows: AgentRateLimitWindow[] = []
  for (const candidate of candidates) {
    if (windows.length >= MAX_WINDOWS) break
    const mapped = toWindow(candidate, windows.length)
    if (mapped) windows.push(mapped)
  }
  return windows
}

export class CustomProviderUsageClient {
  async read(
    providerId: string,
    harnessId: string,
    baseURL: string,
    usagePath: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined
  ): Promise<CustomProviderUsage | null> {
    const source = resolveUsageUrl(baseURL, usagePath)
    const cacheKey = JSON.stringify([providerId, harnessId, source, apiKey ?? '', headers ?? {}])
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existing = inflight.get(cacheKey)
    if (existing) return existing
    const request = this.fetch(providerId, harnessId, source, apiKey, headers).finally(() =>
      inflight.delete(cacheKey)
    )
    inflight.set(cacheKey, request)
    const value = await request
    if (value) {
      cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value })
    }
    return value
  }

  private async fetch(
    providerId: string,
    harnessId: string,
    source: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined
  ): Promise<CustomProviderUsage | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(source, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...headers
        }
      })
      if (!response.ok) {
        Logger.dev(`Custom provider usage route ${source} returned ${response.status}`)
        return null
      }
      const text = await response.text()
      if (text.length > MAX_BODY_BYTES) {
        Logger.dev(`Custom provider usage route ${source} returned an oversized body`)
        return null
      }
      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        Logger.dev(`Custom provider usage route ${source} returned non-JSON content`)
        return null
      }
      const rateLimits = parseUsageBody(body)
      const credits = creditsFromBody(body)
      if (rateLimits.length === 0 && !credits) return null
      return {
        providerId,
        harnessId,
        rateLimits,
        ...(credits ? { credits } : {}),
        source
      }
    } catch (error) {
      Logger.dev(`Custom provider usage route ${source} failed:`, error)
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
}
