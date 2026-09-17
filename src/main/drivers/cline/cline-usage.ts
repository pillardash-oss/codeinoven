import type { AgentTokenUsage } from '../../../lib/types'
import { numberValue, record } from './cline-values'

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
