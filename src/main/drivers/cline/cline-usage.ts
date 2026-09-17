import type { AgentTokenUsage, NormalizedUsage } from '../../../lib/types'
import { numberValue, record } from './cline-values'

/**
 * Parse a Cline per-turn usage object into the shared aggregate shape.
 *
 * The aggregate total sums every reported category. Cline's usage object has no
 * token total of its own, so the synthesized sum is the only comparable figure;
 * a `totalTokens` supplied by a provider-specific payload is preserved on the
 * normalized payload as `rawTotal` rather than mistaken for the turn total.
 */
export function mapClineUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['inputTokens']) ?? 0
  const output = numberValue(usage['outputTokens']) ?? 0
  const reasoning = numberValue(usage['reasoningTokens']) ?? 0
  const cacheRead = numberValue(usage['cacheReadTokens']) ?? 0
  const cacheWrite = numberValue(usage['cacheWriteTokens']) ?? 0
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite
  }
}

/**
 * Map Cline accounting into the canonical normalized contract.
 *
 * Cline reports the prompt cache as separate additive categories beside
 * `inputTokens` (`cacheReadTokens` and `cacheWriteTokens`), matching the
 * Anthropic accounting its CLI maps `input_tokens`,
 * `cache_read_input_tokens` and `cache_creation_input_tokens` into, so
 * uncached input is the reported input with no cache subtraction. Thinking
 * tokens are read from the `reasoningTokens` field when a provider-specific
 * payload reports them. Cline's usage object defines no token total; a total
 * covering the turn would count the cache categories, so a reported
 * `totalTokens` carries `includes_cache` semantics and its absence is
 * `unavailable`.
 */
export function mapClineNormalizedUsage(value: unknown): NormalizedUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['inputTokens'])
  const output = numberValue(usage['outputTokens'])
  const reasoning = numberValue(usage['reasoningTokens'])
  const cachedInput = numberValue(usage['cacheReadTokens'])
  const cacheWrite = numberValue(usage['cacheWriteTokens'])
  const rawTotal = numberValue(usage['totalTokens']) ?? numberValue(usage['total_tokens'])
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined ||
    rawTotal !== undefined
  if (!reported) return undefined
  return {
    uncachedInput: input ?? null,
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...usage },
    rawTotal: rawTotal ?? null,
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'includes_cache'
  }
}
