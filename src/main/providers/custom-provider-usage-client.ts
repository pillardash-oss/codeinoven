/**
 * Reads account quota telemetry from a custom provider's user-defined usage
 * route (`BaseUrlProvider.usagePath`).
 *
 * Providers backed by a subscription expose very different status contracts
 * `new-api`/`one-api` deployments answer `${baseURL}/status` with quota objects,
 * OpenAI-compatible gateways answer `${baseURL}/usage` with data arrays, and
 * bespoke proxies answer with flat objects. Parsing lives in
 * {@link parseProviderUsage}, which applies the provider's selected usage format
 * and falls back to a generic walk. A route that parses to nothing yields `null`
 * the UI simply shows no bars and the editor's preview explains why.
 */
import type { BaseUrlProviderUsageFormat, CustomProviderUsage } from '../../lib/types'
import { Logger } from '../system/logger'
import { parseProviderUsage } from './provider-usage-formats'

const FETCH_TIMEOUT_MS = 8_000
const CACHE_TTL_MS = 30_000
/** Hard cap on JSON bodies so a misbehaving route cannot balloon memory. */
const MAX_BODY_BYTES = 1_000_000

/** One usage read: the mapped snapshot, or a human-readable reason it is empty. */
export interface UsageFetchOutcome {
  usage: CustomProviderUsage | null
  /** Diagnostic for the editor's preview action; absent on a successful read. */
  message?: string
}

interface CacheEntry {
  expiresAt: number
  outcome: UsageFetchOutcome
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<UsageFetchOutcome>>()

/** Resolve a stored route (absolute URL or root-relative path) against the base URL. */
export function resolveUsageUrl(baseURL: string, usagePath: string): string {
  if (/^https?:\/\//iu.test(usagePath)) return usagePath
  const base = baseURL.replace(/\/+$/u, '')
  return `${base}${usagePath.startsWith('/') ? usagePath : `/${usagePath}`}`
}

function cacheKey(
  providerId: string,
  harnessId: string,
  source: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  format: BaseUrlProviderUsageFormat | undefined
): string {
  return JSON.stringify([
    providerId,
    harnessId,
    source,
    apiKey ?? '',
    headers ?? {},
    format ?? 'auto'
  ])
}

export class CustomProviderUsageClient {
  /** Read a provider's usage route, reusing a short-lived cache. */
  async read(
    providerId: string,
    harnessId: string,
    baseURL: string,
    usagePath: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    format?: BaseUrlProviderUsageFormat
  ): Promise<CustomProviderUsage | null> {
    return (
      await this.readOutcome(providerId, harnessId, baseURL, usagePath, apiKey, headers, format)
    ).usage
  }

  /** Read with the diagnostic preserved, bypassing the cache so the editor's
   *  preview always reflects the route as it answers right now. */
  async preview(
    providerId: string,
    harnessId: string,
    baseURL: string,
    usagePath: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    format?: BaseUrlProviderUsageFormat
  ): Promise<UsageFetchOutcome> {
    return this.readOutcome(
      providerId,
      harnessId,
      baseURL,
      usagePath,
      apiKey,
      headers,
      format,
      true
    )
  }

  private async readOutcome(
    providerId: string,
    harnessId: string,
    baseURL: string,
    usagePath: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    format: BaseUrlProviderUsageFormat | undefined,
    force = false
  ): Promise<UsageFetchOutcome> {
    const source = resolveUsageUrl(baseURL, usagePath)
    const key = cacheKey(providerId, harnessId, source, apiKey, headers, format)
    if (!force) {
      const cached = cache.get(key)
      if (cached && cached.expiresAt > Date.now()) return cached.outcome
    }
    const existing = inflight.get(key)
    if (existing) return existing
    const request = this.fetch(providerId, harnessId, source, apiKey, headers, format).finally(() =>
      inflight.delete(key)
    )
    inflight.set(key, request)
    const outcome = await request
    // Only a real snapshot is worth caching; a failure should retry on the next
    // hover instead of pinning "no limits" for the TTL.
    if (outcome.usage) cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, outcome })
    return outcome
  }

  private async fetch(
    providerId: string,
    harnessId: string,
    source: string,
    apiKey: string | undefined,
    headers: Record<string, string> | undefined,
    format: BaseUrlProviderUsageFormat | undefined
  ): Promise<UsageFetchOutcome> {
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
        return {
          usage: null,
          message: `The endpoint answered ${response.status} ${response.statusText}.`
        }
      }
      const text = await response.text()
      if (text.length > MAX_BODY_BYTES) {
        Logger.dev(`Custom provider usage route ${source} returned an oversized body`)
        return { usage: null, message: 'The endpoint returned an oversized response.' }
      }
      let body: unknown
      try {
        body = JSON.parse(text) as unknown
      } catch {
        Logger.dev(`Custom provider usage route ${source} returned non-JSON content`)
        return { usage: null, message: 'The endpoint did not return JSON.' }
      }
      const parsed = parseProviderUsage(format, body)
      if (!parsed) {
        return { usage: null, message: 'No recognizable quota in the response.' }
      }
      return {
        usage: {
          providerId,
          harnessId,
          rateLimits: parsed.rateLimits,
          ...(parsed.credits ? { credits: parsed.credits } : {}),
          source
        }
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Timed out contacting the endpoint.'
          : 'The endpoint could not be reached.'
      Logger.dev(`Custom provider usage route ${source} failed:`, error)
      return { usage: null, message }
    } finally {
      clearTimeout(timeout)
    }
  }
}
