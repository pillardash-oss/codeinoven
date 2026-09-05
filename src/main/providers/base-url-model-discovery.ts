/** Discovers models from an OpenAI-compatible `/models` endpoint, cached per
 *  base URL + credentials for 24 hours so switching harnesses or reopening
 *  the editor doesn't refire the request on every render. */
import type { DiscoveredBaseUrlModel } from '../../lib/types'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const MAX_DISCOVERED_MODELS = 500

interface CacheEntry {
  fetchedAt: number
  models: DiscoveredBaseUrlModel[]
}

const cache = new Map<string, CacheEntry>()

function cacheKey(
  baseURL: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  modelsPath: string | undefined
): string {
  return JSON.stringify([baseURL, apiKey ?? '', headers ?? {}, modelsPath ?? ''])
}

/** Fetches the provider's model-list route (default `${baseURL}/models`), parsing
 *  the OpenAI `{ data: [{ id, ... }] }` shape. Set `force` to bypass the 24h
 *  cache (used by the model picker's refresh action). */
export async function discoverBaseUrlModels(
  baseURL: string,
  options: {
    apiKey?: string
    headers?: Record<string, string>
    modelsPath?: string
    force?: boolean
  } = {}
): Promise<DiscoveredBaseUrlModel[]> {
  const key = cacheKey(baseURL, options.apiKey, options.headers, options.modelsPath)
  const cached = cache.get(key)
  if (!options.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.models
  }

  const url = resolveModelsUrl(baseURL, options.modelsPath)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        ...options.headers
      }
    })
    if (!response.ok) {
      throw new Error(`Model discovery failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as unknown
    const models = parseModelsResponse(body)
    cache.set(key, { fetchedAt: Date.now(), models })
    return models
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Timed out contacting ${url}`, { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function parseModelsResponse(body: unknown): DiscoveredBaseUrlModel[] {
  const list = extractModelList(body)
  const seen = new Set<string>()
  const models: DiscoveredBaseUrlModel[] = []
  for (const entry of list) {
    if (models.length >= MAX_DISCOVERED_MODELS) break
    if (typeof entry !== 'object' || entry === null) continue
    const raw = entry as Record<string, unknown>
    const id = typeof raw['id'] === 'string' ? raw['id'] : undefined
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : id
    const contextWindow = positiveInteger(
      raw['context_length'] ?? raw['context_window'] ?? raw['contextWindow']
    )
    models.push({ id, name, ...(contextWindow === undefined ? {} : { contextWindow }) })
  }
  return models
}

function extractModelList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (typeof body === 'object' && body !== null) {
    const data = (body as Record<string, unknown>)['data']
    if (Array.isArray(data)) return data
  }
  return []
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/** Resolve the model-list endpoint: an absolute URL wins, otherwise the route is
 *  joined onto the base URL (defaulting to `/models` when unset). */
function resolveModelsUrl(baseURL: string, modelsPath: string | undefined): string {
  const base = baseURL.replace(/\/+$/u, '')
  const route = modelsPath?.trim()
  if (!route) return `${base}/models`
  if (/^https?:\/\//iu.test(route)) return route
  return `${base}${route.startsWith('/') ? route : `/${route}`}`
}
