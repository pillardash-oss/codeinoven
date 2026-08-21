import { Logger } from '../system/logger'
import type { ProviderCatalog } from '../../lib/types'
import type { ModelPriceEntry } from './pricing'
import { registerModelPricing } from './pricing'
import type { StorageEngine } from '../storage/storage-engine'

/** Static pricing JSON served by LLM Pricing (no key; CC BY 4.0). */
const PRICING_URL = 'https://llmpricing.dev/api/models.json'
const CACHE_FILE = 'model-pricing.json'
const CACHE_VERSION = 2
/** Refresh cadence and cache freshness window. */
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

/**
 * OpenAI-family cache-write price is commonly 1.25x the input price. The source
 * does not publish a cache-write rate, so we derive it as a documented estimate.
 */
const CACHE_WRITE_MULTIPLIER = 1.25

interface PricingCache {
  version: number
  source: string
  fetchedAt: number
  entries: ModelPriceEntry[]
  contexts: ModelContextEntry[]
}

interface ModelContextEntry {
  id: string
  contextWindow: number
}

interface ContextIndex {
  byId: Map<string, number>
  byBareId: Map<string, number>
}

interface RawReference {
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  official?: unknown
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asFinite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const asPositiveInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null

const normalizeId = (value: string): string => value.trim().toLocaleLowerCase()

const bareId = (value: string): string => {
  const normalized = normalizeId(value)
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? normalized : normalized.slice(separator + 1)
}

/**
 * Convert an llmpricing.dev `/api/models.json` payload into registry entries,
 * keeping ONLY each model's official maker price (`reference.official === true`).
 * cache-write and reasoning rates are derived because the source does not
 * publish them. Guarded so a malformed entry is skipped instead of poisoning
 * the cache.
 */
export function normalizePricingEntries(payload: unknown): ModelPriceEntry[] {
  const root = asRecord(payload)
  const models = Array.isArray(root?.['models']) ? root['models'] : []
  const entries: ModelPriceEntry[] = []
  for (const model of models) {
    const record = asRecord(model)
    const reference = asRecord(record?.['reference']) as RawReference | null
    if (!record || !reference || reference['official'] !== true) continue
    const id = typeof record['id'] === 'string' ? record['id'] : ''
    const input = asFinite(reference['input'])
    const output = asFinite(reference['output'])
    if (!id.includes('/') || input === null || output === null) continue
    entries.push({
      id,
      inputUsdPer1M: input,
      outputUsdPer1M: output,
      cacheReadUsdPer1M: asFinite(reference['cacheRead']) ?? 0,
      cacheWriteUsdPer1M: input * CACHE_WRITE_MULTIPLIER,
      reasoningUsdPer1M: output,
      official: true
    })
  }
  return entries
}

/** Keep every valid context limit, including models without official pricing. */
export function normalizeModelContextEntries(payload: unknown): ModelContextEntry[] {
  const root = asRecord(payload)
  const models = Array.isArray(root?.['models']) ? root['models'] : []
  const entries: ModelContextEntry[] = []
  for (const model of models) {
    const record = asRecord(model)
    const id = typeof record?.['id'] === 'string' ? record['id'] : ''
    const contextWindow = asPositiveInteger(record?.['context'])
    if (!id.includes('/') || contextWindow === null) continue
    entries.push({ id, contextWindow })
  }
  return entries
}

function contextIndex(entries: ModelContextEntry[]): ContextIndex {
  const byId = new Map<string, number>()
  const bareCandidates = new Map<string, Set<number>>()
  for (const entry of entries) {
    const id = normalizeId(entry.id)
    if (!id || !Number.isInteger(entry.contextWindow) || entry.contextWindow <= 0) continue
    byId.set(id, entry.contextWindow)
    const modelId = bareId(id)
    const candidates = bareCandidates.get(modelId) ?? new Set<number>()
    candidates.add(entry.contextWindow)
    bareCandidates.set(modelId, candidates)
  }

  const byBareId = new Map<string, number>()
  for (const [id, candidates] of bareCandidates) {
    if (candidates.size !== 1) continue
    const contextWindow = candidates.values().next().value
    if (contextWindow !== undefined) byBareId.set(id, contextWindow)
  }
  return { byId, byBareId }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetches current model pricing from llmpricing.dev, persists a cache file, and
 * populates the synchronous pricing registry used by drivers. All I/O is async
 * and kicked off without blocking boot; the on-disk cache is loaded in the
 * background (so estimates still work offline once loaded), and a background
 * refresh keeps prices current on a 24h TTL.
 */
export class ModelPricingService {
  private timer: ReturnType<typeof setInterval> | null = null
  private started = false
  private loaded = false
  private lastFetchedAt = 0
  private loading: Promise<void> | null = null
  private refreshing: Promise<number> | null = null
  private contexts: ContextIndex = { byId: new Map(), byBareId: new Map() }

  constructor(private readonly storage: StorageEngine) {}

  /** Schedule cache load + refresh in the background. Never blocks boot. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.ensureLoaded().catch((error) => Logger.dev('Pricing load/refresh failed:', error))
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.refreshIfStale().catch((error) => Logger.dev('Pricing refresh failed:', error))
      }, TTL_MS)
      this.timer.unref?.()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const cache = await this.storage.read<PricingCache>(CACHE_FILE)
      if (
        cache &&
        (cache.version === 1 || cache.version === CACHE_VERSION) &&
        Array.isArray(cache.entries)
      ) {
        registerModelPricing(cache.entries)
        this.contexts = contextIndex(Array.isArray(cache.contexts) ? cache.contexts : [])
        this.lastFetchedAt =
          cache.version === CACHE_VERSION && typeof cache.fetchedAt === 'number'
            ? cache.fetchedAt
            : 0
        Logger.dev('Loaded model pricing cache', { count: cache.entries.length })
      }
    } catch {
      // Missing or corrupt cache: no prices yet; the background refresh covers it.
    }
  }

  private async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastFetchedAt < TTL_MS) return
    await this.refresh()
  }

  private ensureLoaded(): Promise<void> {
    if (this.loading) return this.loading
    this.loading = (
      this.loaded ? this.refreshIfStale() : this.loadCache().then(() => this.refreshIfStale())
    )
      .then(() => {
        this.loaded = true
      })
      .catch((error: unknown) => {
        this.loaded = true
        Logger.dev('Model metadata load/refresh failed:', error)
      })
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }

  /**
   * Fill only catalog gaps from the same live metadata payload used for prices.
   * Exact IDs win. A bare model ID is used only when all matching labs publish
   * the same limit, so wrapper-specific caps are never guessed.
   */
  async enrichMissingContext(catalogs: ProviderCatalog[]): Promise<ProviderCatalog[]> {
    if (
      !catalogs.some((catalog) => catalog.models.some((model) => model.contextWindow === undefined))
    ) {
      return catalogs
    }

    await this.ensureLoaded()
    return catalogs.map((catalog) => ({
      ...catalog,
      models: catalog.models.map((model) => {
        if (model.contextWindow !== undefined) return model
        const modelId = normalizeId(model.id)
        const providerModelId = `${normalizeId(model.providerId)}/${modelId}`
        const contextWindow =
          this.contexts.byId.get(providerModelId) ??
          this.contexts.byId.get(modelId) ??
          this.contexts.byBareId.get(bareId(modelId))
        return contextWindow === undefined ? model : { ...model, contextWindow }
      })
    }))
  }

  /** Fetch, normalize, persist, and register fresh pricing. Returns entry count. */
  async refresh(): Promise<number> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const payload = await fetchJson(PRICING_URL)
      const entries = normalizePricingEntries(payload)
      const contexts = normalizeModelContextEntries(payload)
      if (entries.length === 0) throw new Error('Pricing payload contained no priced models')
      if (contexts.length === 0) throw new Error('Pricing payload contained no context limits')
      const fetchedAt = Date.now()
      registerModelPricing(entries)
      this.contexts = contextIndex(contexts)
      await this.storage.write(CACHE_FILE, {
        version: CACHE_VERSION,
        source: PRICING_URL,
        fetchedAt,
        entries,
        contexts
      } satisfies PricingCache)
      this.lastFetchedAt = fetchedAt
      Logger.dev('Refreshed model pricing', { count: entries.length })
      return entries.length
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }
}
