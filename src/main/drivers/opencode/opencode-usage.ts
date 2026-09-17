import type { AgentTokenUsage, NormalizedUsage } from '../../../lib/types'
import { numberValue, recordValue } from './opencode-values'

/** Map OpenCode accounting into the canonical normalized contract and display aggregates. */
export function mapOpenCodeUsage(raw: unknown): {
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
  const rawTotal = numberValue(tokens['total'])
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined ||
    rawTotal !== undefined
  if (!reported) return { aggregateTokens: undefined, normalizedUsage: undefined }
  // OpenCode exposes uncached input and cache reads/writes as separate token
  // categories. Cache reads can legitimately exceed input on a well-cached
  // turn, so subtracting them would erase the actual uncached input.
  const uncachedInput = input ?? null
  const normalizedUsage: NormalizedUsage = {
    uncachedInput,
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...tokens },
    rawTotal: rawTotal ?? null,
    // OpenCode's current SDK does not define a total. Preserve one when an older
    // or provider-specific payload supplies it without assuming its semantics.
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'provider_defined'
  }
  const aggregateTokens: AgentTokenUsage | undefined =
    rawTotal === undefined
      ? undefined
      : {
          input: input ?? 0,
          output: output ?? 0,
          reasoning: reasoning ?? 0,
          cacheRead: cachedInput ?? 0,
          cacheWrite: cacheWrite ?? 0,
          total: rawTotal
        }
  return { aggregateTokens, normalizedUsage }
}
