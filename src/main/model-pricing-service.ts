import { Logger } from './logger'
import type { ModelPriceEntry } from './pricing'
import { registerModelPricing } from './pricing'
import type { StorageEngine } from './storage-engine'

/** Static pricing JSON served by LLM Pricing (no key; CC BY 4.0). */
const PRICING_URL = 'https://llmpricing.dev/api/models.json'
const CACHE_FILE = 'model-pricing.json'
const CACHE_VERSION = 1
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
  private refreshing = false
  private started = false
  private lastFetchedAt = 0

  constructor(private readonly storage: StorageEngine) {}

  /** Schedule cache load + refresh in the background. Never blocks boot. */
  start(): void {
    if (this.started) return
    this.started = true
    void this.loadCache()
      .then(() => this.refreshIfStale())
      .catch((error) => Logger.dev('Pricing load/refresh failed:', error))
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
      if (cache && cache.version === CACHE_VERSION && Array.isArray(cache.entries)) {
        registerModelPricing(cache.entries)
        this.lastFetchedAt = typeof cache.fetchedAt === 'number' ? cache.fetchedAt : 0
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

  /** Fetch, normalize, persist, and register fresh pricing. Returns entry count. */
  async refresh(): Promise<number> {
    if (this.refreshing) return 0
    this.refreshing = true
    try {
      const payload = await fetchJson(PRICING_URL)
      const entries = normalizePricingEntries(payload)
      if (entries.length === 0) throw new Error('Pricing payload contained no priced models')
      const fetchedAt = Date.now()
      registerModelPricing(entries)
      await this.storage.write(CACHE_FILE, {
        version: CACHE_VERSION,
        source: PRICING_URL,
        fetchedAt,
        entries
      } satisfies PricingCache)
      this.lastFetchedAt = fetchedAt
      Logger.dev('Refreshed model pricing', { count: entries.length })
      return entries.length
    } finally {
      this.refreshing = false
    }
  }
}
