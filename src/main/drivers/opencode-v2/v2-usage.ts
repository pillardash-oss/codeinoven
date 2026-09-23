import type { AgentTokenUsage, NormalizedUsage } from '../../../lib/types'
import { numberValue, recordValue } from './v2-values'

/**
 * Map V2 accounting into the canonical normalized contract and display
 * aggregates.
 *
 * `TokenUsage.Info` is `{input, output, reasoning, cache: {read, write}}` and
 * carries **no total** (V1 reported one; V2 dropped the field). The categories
 * are disjoint exactly as in V1   `reasoning` sits beside `output`, not inside
 * it   so the display aggregate folds reasoning into `output` and sums the
 * reported categories for its total. The canonical contract stays honest about
 * provenance: `rawTotal` is null and `totalSemantics` is `unavailable`, because
 * the provider reported no total of its own.
 */
export function mapOpenCodeV2Usage(raw: unknown): {
  aggregateTokens: AgentTokenUsage | undefined
  normalizedUsage: NormalizedUsage | undefined
} {
  const tokens = recordValue(raw)
  if (!tokens) return { aggregateTokens: undefined, normalizedUsage: undefined }
  const cache = recordValue(tokens['cache'])
  const input = numberValue(tokens['input'])
  const output = numberValue(tokens['output'])
  const reasoning = numberValue(tokens['reasoning'])
  const cachedInput = numberValue(cache?.['read'])
  const cacheWrite = numberValue(cache?.['write'])
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined
  if (!reported) return { aggregateTokens: undefined, normalizedUsage: undefined }

  const normalizedUsage: NormalizedUsage = {
    // V2 exposes uncached input and cache reads/writes as separate categories.
    // A cache read can legitimately exceed the uncached input on a well-cached
    // turn, so subtracting it would erase the actual uncached input.
    uncachedInput: input ?? null,
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...tokens },
    rawTotal: null,
    totalSemantics: 'unavailable'
  }
  const aggregateTokens: AgentTokenUsage = {
    input: input ?? 0,
    // Reasoning is reported beside `output` rather than inside it, so the
    // display total for generated tokens is their sum.
    output: (output ?? 0) + (reasoning ?? 0),
    reasoning: reasoning ?? 0,
    cacheRead: cachedInput ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total: (input ?? 0) + (output ?? 0) + (reasoning ?? 0) + (cachedInput ?? 0) + (cacheWrite ?? 0)
  }
  return { aggregateTokens, normalizedUsage }
}

/** Whether a mapped V2 token payload reported anything at all. */
export function hasOpenCodeV2Usage(raw: unknown): boolean {
  return mapOpenCodeV2Usage(raw).aggregateTokens !== undefined
}
