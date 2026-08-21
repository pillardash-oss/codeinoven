import type { ProviderCatalog } from '../../lib/types'
import { Logger } from '../system/logger'

const MODELS_DEV_URL = 'https://models.dev/models.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

interface ContextIndex {
  fetchedAt: number
  byId: Map<string, number>
  byBareId: Map<string, number>
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined

const normalizeId = (value: string): string => value.trim().toLocaleLowerCase()

const bareId = (value: string): string => {
  const normalized = normalizeId(value)
  const separator = normalized.lastIndexOf('/')
  return separator < 0 ? normalized : normalized.slice(separator + 1)
}

/**
 * Build exact-id indexes from models.dev's provider-agnostic catalog. Bare
 * model ids are accepted only when every matching provider reports the same
 * context limit. This avoids assigning a base model's limit to a wrapper whose
 * own catalog reports a different cap.
 */
export function normalizeModelsDevContext(payload: unknown): ContextIndex {
  const root = asRecord(payload)
  const byId = new Map<string, number>()
  const bareCandidates = new Map<string, Set<number>>()
  if (!root) return { fetchedAt: Date.now(), byId, byBareId: new Map() }

  for (const [key, rawModel] of Object.entries(root)) {
    const model = asRecord(rawModel)
    const limit = asRecord(model?.['limit'])
    const context = positiveInteger(limit?.['context'])
    if (!model || context === undefined) continue

    const id = typeof model['id'] === 'string' ? model['id'] : key
    const normalizedId = normalizeId(id)
    if (!normalizedId) continue
    byId.set(normalizedId, context)

    const candidateId = bareId(normalizedId)
    const candidates = bareCandidates.get(candidateId) ?? new Set<number>()
    candidates.add(context)
    bareCandidates.set(candidateId, candidates)
  }

  const byBareId = new Map<string, number>()
  for (const [id, candidates] of bareCandidates) {
    if (candidates.size !== 1) continue
    const context = candidates.values().next().value
    if (context !== undefined) byBareId.set(id, context)
  }
  return { fetchedAt: Date.now(), byId, byBareId }
}

async function fetchModelsDevContext(): Promise<ContextIndex> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(MODELS_DEV_URL, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const index = normalizeModelsDevContext((await response.json()) as unknown)
    if (index.byId.size === 0) throw new Error('models.dev returned no context limits')
    return index
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Supplies current context limits only for models whose harness catalog omitted
 * them. One request is shared across concurrent harness discovery, then cached
 * for the app session so provider-picker refreshes do not add network latency.
 */
export class ModelsDevContextService {
  private index: ContextIndex | null = null
  private pending: Promise<ContextIndex | null> | null = null

  async enrichMissing(catalogs: ProviderCatalog[]): Promise<ProviderCatalog[]> {
    if (
      !catalogs.some((catalog) => catalog.models.some((model) => model.contextWindow === undefined))
    ) {
      return catalogs
    }

    const index = await this.currentIndex()
    if (!index) return catalogs
    return catalogs.map((catalog) => ({
      ...catalog,
      models: catalog.models.map((model) => {
        if (model.contextWindow !== undefined) return model
        const normalizedId = normalizeId(model.id)
        const contextWindow =
          index.byId.get(normalizedId) ?? index.byBareId.get(bareId(normalizedId))
        return contextWindow === undefined ? model : { ...model, contextWindow }
      })
    }))
  }

  private async currentIndex(): Promise<ContextIndex | null> {
    if (this.index && Date.now() - this.index.fetchedAt < CACHE_TTL_MS) return this.index
    if (this.pending) return this.pending

    this.pending = fetchModelsDevContext()
      .then((index) => {
        this.index = index
        return index
      })
      .catch((error: unknown) => {
        Logger.dev('models.dev context metadata unavailable:', error)
        return this.index
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }
}
