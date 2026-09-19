import type { AgentTokenUsage, NormalizedUsage } from '../../../lib/types'
import { numberValue, record } from './cline-values'

/**
 * One iteration's usage as Cline reports it on its `usage` agent event.
 *
 * Cline emits this event on every iteration of a run, so it is the only live
 * telemetry a long turn has. Cline reports deltas beside run-cumulative
 * totals; only the deltas describe one iteration, and therefore only the
 * deltas can answer how much of the context window that iteration occupied.
 */
export interface ClineStepUsage {
  tokens: AgentTokenUsage
  normalizedUsage: NormalizedUsage
  /**
   * Prompt tokens the provider processed for this iteration: uncached input
   * plus the prompt cache read and written for it. This is the real context
   * occupancy of the iteration, not an estimate.
   */
  contextUsed: number
  /** Provider-reported cost of this iteration alone, when it is non-zero. */
  cost?: number
}

/**
 * Map one Cline per-iteration `usage` event into live telemetry.
 *
 * The provider-specific payload reports `inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens` and `cost` as deltas for the
 * iteration, with `total*` fields carrying the run-cumulative counters. A
 * provider that reports nothing usable   no input and no output   yields
 * undefined rather than a fabricated zero reading.
 */
export function mapClineStepUsage(value: unknown): ClineStepUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['inputTokens'])
  const output = numberValue(usage['outputTokens'])
  if (input === undefined && output === undefined) return undefined
  const reasoning = numberValue(usage['reasoningTokens']) ?? 0
  const cacheRead = numberValue(usage['cacheReadTokens']) ?? 0
  const cacheWrite = numberValue(usage['cacheWriteTokens']) ?? 0
  const uncachedInput = input ?? 0
  const generated = output ?? 0
  const contextUsed = uncachedInput + cacheRead + cacheWrite
  const cost = numberValue(usage['cost'])
  return {
    tokens: {
      input: uncachedInput,
      output: generated,
      reasoning,
      cacheRead,
      cacheWrite,
      total: uncachedInput + generated + reasoning + cacheRead + cacheWrite
    },
    normalizedUsage: {
      uncachedInput,
      cachedInput: cacheRead,
      cacheWrite,
      output: generated,
      reasoning: reasoning > 0 ? reasoning : null,
      rawProviderUsage: { ...usage },
      // The event's `total*` counters describe the whole run, not this
      // iteration, so there is no provider total this reading can claim.
      rawTotal: null,
      totalSemantics: 'unavailable'
    },
    contextUsed,
    ...(cost === undefined || cost === 0 ? {} : { cost })
  }
}

/**
 * Effective context window Cline reports for the model a run used.
 *
 * Cline's run result carries the model definition it resolved, including the
 * window it is compacting against. `contextWindow` is the model's total
 * window and `maxInputTokens` its prompt cap; the former is the honest
 * denominator for an occupancy meter, so the input cap is only a fallback.
 */
export function clineModelContextWindow(value: unknown): number | undefined {
  const model = record(value)
  const info = record(model?.['info'])
  const contextWindow = numberValue(info?.['contextWindow'])
  if (contextWindow !== undefined && contextWindow > 0) return contextWindow
  const maxInputTokens = numberValue(info?.['maxInputTokens'])
  return maxInputTokens !== undefined && maxInputTokens > 0 ? maxInputTokens : undefined
}

/**
 * Parse a Cline per-turn usage object into the shared aggregate shape.
 *
 * `run_result.usage` sums every iteration of a run, so it is the billed token
 * total for the turn and never the occupancy of a single provider request;
 * live occupancy comes from the per-iteration `usage` event via
 * `mapClineStepUsage`. The aggregate total sums every reported category.
 * Cline's usage object has no token total of its own, so the synthesized sum is
 * the only comparable figure; a `totalTokens` supplied by a provider-specific
 * payload is preserved on the normalized payload as `rawTotal` rather than
 * mistaken for the turn total.
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
