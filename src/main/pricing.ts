import type { AgentTokenUsage } from '../lib/types'

/**
 * Per-model USD price per 1M tokens. Rates are representative published prices
 * used only to ESTIMATE cost when a harness reports tokens but no dollar figure.
 * They are never treated as authoritative provider billing.
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

const prices: Record<string, ModelPrice> = {
  'gpt-5.2-pro': {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.125,
    cacheWriteUsdPer1M: 1.5625,
    reasoningUsdPer1M: 10
  },
  'gpt-5.1': {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.125,
    cacheWriteUsdPer1M: 1.5625,
    reasoningUsdPer1M: 10
  },
  'gpt-5': {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.125,
    cacheWriteUsdPer1M: 1.5625,
    reasoningUsdPer1M: 10
  },
  'gpt-5-mini': {
    inputUsdPer1M: 0.25,
    outputUsdPer1M: 2,
    cacheReadUsdPer1M: 0.025,
    cacheWriteUsdPer1M: 0.3125,
    reasoningUsdPer1M: 2
  },
  'gpt-5-nano': {
    inputUsdPer1M: 0.05,
    outputUsdPer1M: 0.4,
    cacheReadUsdPer1M: 0.005,
    cacheWriteUsdPer1M: 0.0625,
    reasoningUsdPer1M: 0.4
  },
  codex: {
    inputUsdPer1M: 2,
    outputUsdPer1M: 12,
    cacheReadUsdPer1M: 0.2,
    cacheWriteUsdPer1M: 2.5,
    reasoningUsdPer1M: 12
  },
  'codex-mini': {
    inputUsdPer1M: 0.5,
    outputUsdPer1M: 3,
    cacheReadUsdPer1M: 0.05,
    cacheWriteUsdPer1M: 0.625,
    reasoningUsdPer1M: 3
  },
  'gpt-4.1': {
    inputUsdPer1M: 2,
    outputUsdPer1M: 8,
    cacheReadUsdPer1M: 0.5,
    cacheWriteUsdPer1M: 2.5,
    reasoningUsdPer1M: 8
  },
  'gpt-4.1-mini': {
    inputUsdPer1M: 0.4,
    outputUsdPer1M: 1.6,
    cacheReadUsdPer1M: 0.1,
    cacheWriteUsdPer1M: 0.5,
    reasoningUsdPer1M: 1.6
  },
  'gpt-4o': {
    inputUsdPer1M: 2.5,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 1.25,
    cacheWriteUsdPer1M: 3.125,
    reasoningUsdPer1M: 10
  },
  'gpt-4o-mini': {
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
    cacheReadUsdPer1M: 0.075,
    cacheWriteUsdPer1M: 0.1875,
    reasoningUsdPer1M: 0.6
  },
  'gpt-4-turbo': {
    inputUsdPer1M: 10,
    outputUsdPer1M: 30,
    cacheReadUsdPer1M: 1,
    cacheWriteUsdPer1M: 12.5,
    reasoningUsdPer1M: 30
  },
  'gpt-4': {
    inputUsdPer1M: 30,
    outputUsdPer1M: 60,
    cacheReadUsdPer1M: 15,
    cacheWriteUsdPer1M: 37.5,
    reasoningUsdPer1M: 60
  },
  o4: {
    inputUsdPer1M: 1.1,
    outputUsdPer1M: 4.4,
    cacheReadUsdPer1M: 0.11,
    cacheWriteUsdPer1M: 1.375,
    reasoningUsdPer1M: 4.4
  },
  o3: {
    inputUsdPer1M: 2,
    outputUsdPer1M: 8,
    cacheReadUsdPer1M: 0.2,
    cacheWriteUsdPer1M: 2.5,
    reasoningUsdPer1M: 8
  },
  o1: {
    inputUsdPer1M: 15,
    outputUsdPer1M: 60,
    cacheReadUsdPer1M: 1.5,
    cacheWriteUsdPer1M: 18.75,
    reasoningUsdPer1M: 60
  },
  'gpt-3.5': {
    inputUsdPer1M: 0.5,
    outputUsdPer1M: 1.5,
    cacheReadUsdPer1M: 0.05,
    cacheWriteUsdPer1M: 0.625,
    reasoningUsdPer1M: 1.5
  },
  openai: {
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
    cacheReadUsdPer1M: 0.125,
    cacheWriteUsdPer1M: 1.5625,
    reasoningUsdPer1M: 10
  },
  anthropic: {
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
    cacheReadUsdPer1M: 0.3,
    cacheWriteUsdPer1M: 3.75,
    reasoningUsdPer1M: 15
  },
  claude: {
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
    cacheReadUsdPer1M: 0.3,
    cacheWriteUsdPer1M: 3.75,
    reasoningUsdPer1M: 15
  }
}

/**
 * Longest-prefix match against known model ids, falling back to the provider's
 * generic entry. Prefixes that are pure substrings of a more specific known
 * model are matched by length so `gpt-5.6-sol` resolves to `gpt-5` and not a
 * worse generic match.
 */
function resolvePrice(
  modelId: string | null | undefined,
  providerId: string | null | undefined
): ModelPrice | null {
  if (modelId) {
    const normalized = modelId.trim().toLowerCase()
    let best: ModelPrice | null = null
    let bestLength = -1
    for (const [prefix, price] of Object.entries(prices)) {
      if (normalized.startsWith(prefix) && prefix.length > bestLength) {
        best = price
        bestLength = prefix.length
      }
    }
    if (best) return best
  }
  if (providerId) {
    const provider = providerId.trim().toLowerCase()
    const price = prices[provider]
    if (price) return price
  }
  return null
}

const clampNonNegative = (value: number): number => Math.max(0, value)

/**
 * Estimate a token cost in USD from a reported token breakdown when the harness
 * provides no dollar figure. Returns null when neither the model nor the
 * provider has pricing data so we never fabricate a number blindly.
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
