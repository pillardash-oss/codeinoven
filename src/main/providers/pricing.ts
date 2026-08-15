import type { AgentTokenUsage } from '../../lib/types'

/**
 * Per-model USD price per 1M tokens, used only to ESTIMATE cost when a harness
 * reports tokens but no dollar figure. Prices come from the live
 * `model-pricing-service` (llmpricing.dev), registered into this module's
 * in-memory registry. They are never treated as authoritative provider billing.
 */
export interface ModelPrice {
  /** Uncached input tokens, USD per 1M. */
  inputUsdPer1M: number
  /** Output tokens, USD per 1M. */
  outputUsdPer1M: number
  /** Cached (cache-read) input tokens, USD per 1M. */
  cacheReadUsdPer1M: number
  /** Cache-write tokens, USD per 1M. */
  cacheWriteUsdPer1M: number
  /** Reasoning tokens, USD per 1M. */
  reasoningUsdPer1M: number
}

/** One registered model with its canonical `lab/model` id. */
export interface ModelPriceEntry extends ModelPrice {
  /** Full canonical id, e.g. `openai/gpt-5-2` (matched case-insensitively). */
  id: string
  /** True when `reference` was flagged as the maker's official price. */
  official?: boolean
}

/** In-memory registry keyed by lowercased canonical `lab/model` id. */
const registry = new Map<string, ModelPriceEntry>()

/**
 * Replace the registry contents. Called by the model-pricing service when it
 * loads the disk cache or finishes a fresh fetch. Callers stay synchronous.
 */
export function registerModelPricing(entries: ModelPriceEntry[]): void {
  registry.clear()
  for (const entry of entries) {
    if (entry.id && entry.id.includes('/')) registry.set(entry.id.toLowerCase(), entry)
  }
}

const clampNonNegative = (value: number): number => Math.max(0, value)

interface Candidate {
  entry: ModelPriceEntry
  /** 1 when the entry's lab matches the requested provider, else 0. */
  sameLab: 0 | 1
  /** 3 exact, 2 runtime-model more specific, 1 registry-model more specific. */
  relation: 0 | 1 | 2 | 3
}

/**
 * Resolve a runtime `(modelId, providerId)` to a price entry. Matches
 * provider-aware (`lab/model`) first, then falls back to a model-id prefix match
 * across labs so custom/base-URL providers that proxy a known model still get a
 * reasonable price. Returns null when nothing matches (offline/unknown).
 */
function resolvePrice(
  modelId: string | null | undefined,
  providerId: string | null | undefined
): ModelPriceEntry | null {
  const model = modelId?.trim().toLowerCase()
  const provider = providerId?.trim().toLowerCase()
  if (!model) return null

  let best: Candidate | null = null
  for (const entry of registry.values()) {
    const slash = entry.id.indexOf('/')
    const lab = entry.id.slice(0, slash)
    const entryModel = entry.id.slice(slash + 1)
    const sameLab = provider !== undefined && provider !== '' && lab === provider ? 1 : 0

    let relation: Candidate['relation'] = 0
    if (entryModel === model) relation = 3
    else if (model.startsWith(entryModel)) relation = 2
    else if (entryModel.startsWith(model)) relation = 1
    if (relation === 0) continue

    const candidate: Candidate = { entry, sameLab, relation }
    if (!best) {
      best = candidate
      continue
    }
    if (candidate.sameLab !== best.sameLab) {
      if (candidate.sameLab > best.sameLab) best = candidate
      continue
    }
    if (candidate.relation !== best.relation) {
      if (candidate.relation > best.relation) best = candidate
      continue
    }
    const candidateLen = candidate.entry.id.length
    const bestLen = best.entry.id.length
    if (candidateLen > bestLen || (candidateLen === bestLen && candidate.entry.official === true)) {
      best = candidate
    }
  }
  return best?.entry ?? null
}

/**
 * Estimate a token cost in USD from a reported token breakdown when the harness
 * provides no dollar figure. Returns null when neither the model nor the
 * provider has pricing data (e.g. no cache and offline), so we never fabricate
 * a number blindly.
 *
 * Codex-style legacy totals report `input` as the cache-inclusive input count,
 * so uncached input is derived by subtracting the cached portion. A malformed
 * cache value exceeding input is clamped rather than producing a negative cost.
 */
export function estimateTokenCostUsd(
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  tokens: AgentTokenUsage | undefined
): number | null {
  if (!tokens) return null
  const price = resolvePrice(modelId, providerId)
  if (!price) return null
  const uncachedInput = clampNonNegative((tokens.input ?? 0) - (tokens.cacheRead ?? 0))
  const costUsd =
    (uncachedInput / 1_000_000) * price.inputUsdPer1M +
    (clampNonNegative(tokens.cacheRead ?? 0) / 1_000_000) * price.cacheReadUsdPer1M +
    (clampNonNegative(tokens.cacheWrite ?? 0) / 1_000_000) * price.cacheWriteUsdPer1M +
    (clampNonNegative(tokens.output ?? 0) / 1_000_000) * price.outputUsdPer1M +
    (clampNonNegative(tokens.reasoning ?? 0) / 1_000_000) * price.reasoningUsdPer1M
  return Math.round(costUsd * 1_000_000) / 1_000_000
}
