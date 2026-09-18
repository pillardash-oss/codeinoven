import type {
  AgentRateLimitWindow,
  AgentTokenUsage,
  AgentUsageCredits,
  NormalizedUsage
} from '../../../lib/types'
import type { CliLineParseContext } from '../persistent-cli-driver'
import { epochMilliseconds, numberProperty, record, string } from './claude-values'

/** Claude Code token accounting, context and rate-limit extraction. */

export const CLAUDE_USAGE_TIMEOUT_MS = 12_000

export type ClaudeAccountUsage = {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  contextWindow?: number
  contextUsed?: number
}

/** One Claude usage object's categories, each undefined when it was not reported. */
interface ClaudeUsageFields {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  /** Provider-reported token total, when a compatible payload supplies one. */
  rawTotal?: number
  raw: Record<string, unknown>
}

/**
 * Read the token categories shared by Anthropic `usage`, per-iteration usage
 * entries, and Claude Code `modelUsage` records. Thinking tokens surface either
 * as a top-level `reasoning_tokens` on OpenAI-compatible passthroughs or as
 * `thinking_tokens` under `output_tokens_details` (and as the `thinkingTokens`
 * key on `modelUsage` records).
 */
function usageFields(value: unknown): ClaudeUsageFields | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const outputDetails = record(usage['output_tokens_details'] ?? usage['outputTokensDetails'])
  return {
    input: numberProperty(usage, 'input_tokens', 'inputTokens'),
    output: numberProperty(usage, 'output_tokens', 'outputTokens'),
    cacheRead: numberProperty(usage, 'cache_read_input_tokens', 'cacheReadInputTokens'),
    cacheWrite: numberProperty(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens'),
    reasoning:
      numberProperty(usage, 'reasoning_tokens', 'reasoningTokens') ??
      numberProperty(usage, 'thinking_tokens', 'thinkingTokens') ??
      numberProperty(outputDetails ?? {}, 'thinking_tokens', 'thinkingTokens'),
    rawTotal: numberProperty(usage, 'total_tokens', 'totalTokens'),
    raw: usage
  }
}

/**
 * Parse a Claude usage object into the shared aggregate shape.
 *
 * Anthropic reports `input_tokens` exclusive of both cache categories, so the
 * cache counts sit beside the input and are additive rather than a subset of
 * it; `aggregateModelUsage` treats them the same way. Thinking tokens are a
 * SUBSET of the reported output: Anthropic surfaces them as `thinking_tokens`
 * under `output_tokens_details` (or as a top-level `reasoning_tokens` on
 * OpenAI-compatible passthroughs), so the synthesized total counts them only
 * through `output` and never adds them a second time. A provider-reported
 * `total_tokens` is used as-is when a compatible payload carries one.
 */
export function tokenUsage(value: unknown): AgentTokenUsage | undefined {
  const fields = usageFields(value)
  if (!fields) return undefined
  const input = fields.input ?? 0
  const output = fields.output ?? 0
  const reasoning = fields.reasoning ?? 0
  const cacheRead = fields.cacheRead ?? 0
  const cacheWrite = fields.cacheWrite ?? 0
  const total = fields.rawTotal ?? input + output + cacheRead + cacheWrite
  return total > 0 ? { input, output, reasoning, cacheRead, cacheWrite, total } : undefined
}

/**
 * Map a Claude usage object into the canonical normalized contract.
 *
 * Anthropic reports the prompt cache as separate additive categories beside
 * `input_tokens` (verified against the usage schema and the Anthropic message
 * accounting that maps `input_tokens`, `cache_read_input_tokens` and
 * `cache_creation_input_tokens` independently), so uncached input is the
 * reported input with no cache subtraction. Thinking tokens share the output
 * details and are carried as their own category. Claude's native usage defines
 * no token total; a `total_tokens` supplied by a compatible payload is
 * preserved as `rawTotal` and, because the categories it would cover include
 * the cache counts, declared `includes_cache`. Without one the semantics are
 * `unavailable`.
 */
export function mapClaudeNormalizedUsage(value: unknown): NormalizedUsage | undefined {
  const fields = usageFields(value)
  if (!fields) return undefined
  const reported =
    fields.input !== undefined ||
    fields.output !== undefined ||
    fields.reasoning !== undefined ||
    fields.cacheRead !== undefined ||
    fields.cacheWrite !== undefined ||
    fields.rawTotal !== undefined
  if (!reported) return undefined
  return {
    uncachedInput: fields.input ?? null,
    cachedInput: fields.cacheRead ?? null,
    cacheWrite: fields.cacheWrite ?? null,
    output: fields.output ?? null,
    reasoning: fields.reasoning ?? null,
    rawProviderUsage: { ...fields.raw },
    rawTotal: fields.rawTotal ?? null,
    totalSemantics: fields.rawTotal === undefined ? 'unavailable' : 'includes_cache'
  }
}

/**
 * Claude's top-level result usage is cumulative across agent/tool iterations and
 * represents billable processing, not the prompt currently occupying context.
 * The final iteration is the closest provider-reported snapshot of live context.
 */
export function latestIterationContextUsed(value: unknown): number | undefined {
  const usage = record(value)
  const iterations = usage?.['iterations']
  if (!Array.isArray(iterations)) return undefined
  return tokenUsage(iterations.at(-1))?.total
}

export function preserveReasoningUsage(
  reported: AgentTokenUsage | undefined,
  existing: AgentTokenUsage | undefined
): AgentTokenUsage | undefined {
  if (!reported || !existing || existing.reasoning <= reported.reasoning)
    return reported ?? existing
  return { ...reported, reasoning: existing.reasoning }
}

/**
 * Carry a reasoning count preserved from the delta stream onto the normalized
 * payload. Claude's streamed deltas can report the thinking tokens that the
 * final result usage omits, and `preserveReasoningUsage` already keeps that
 * larger count on the display tokens; without this the ledger would record a
 * null reasoning category for a turn that really spent the tokens.
 */
export function preserveNormalizedReasoning(
  normalized: NormalizedUsage | undefined,
  tokens: AgentTokenUsage | undefined
): NormalizedUsage | undefined {
  if (!normalized || !tokens) return normalized
  if (tokens.reasoning <= (normalized.reasoning ?? 0)) return normalized
  return { ...normalized, reasoning: tokens.reasoning }
}

export function modelUsageRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value.map(record).filter((item): item is Record<string, unknown> => item !== null)
  const usage = record(value)
  return usage
    ? Object.values(usage)
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
    : []
}

/**
 * Sum Claude Code's per-model `modelUsage` records into display aggregates and
 * the canonical normalized contract. Each record's `thinkingTokens` is a
 * SUBSET of its `outputTokens` (the same Anthropic breakdown `tokenUsage`
 * encodes), so the synthesized total adds every billed category once and
 * counts reasoning only through `output`. `modelUsage` carries no token total
 * of its own, so `rawTotal` stays null and its semantics are `unavailable`.
 */
export function aggregateModelUsage(value: unknown): {
  tokens?: AgentTokenUsage
  normalizedUsage?: NormalizedUsage
  cost?: number
  contextWindow?: number
} {
  const entries = modelUsageRecords(value)
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let hasInput = false
  let hasOutput = false
  let hasReasoning = false
  let hasCacheRead = false
  let hasCacheWrite = false
  let cost = 0
  let contextWindow: number | undefined
  for (const entry of entries) {
    const fields = usageFields(entry)
    if (fields) {
      if (fields.input !== undefined) {
        input += fields.input
        hasInput = true
      }
      if (fields.output !== undefined) {
        output += fields.output
        hasOutput = true
      }
      if (fields.reasoning !== undefined) {
        reasoning += fields.reasoning
        hasReasoning = true
      }
      if (fields.cacheRead !== undefined) {
        cacheRead += fields.cacheRead
        hasCacheRead = true
      }
      if (fields.cacheWrite !== undefined) {
        cacheWrite += fields.cacheWrite
        hasCacheWrite = true
      }
    }
    cost += numberProperty(entry, 'costUSD', 'costUsd', 'cost_usd') ?? 0
    const candidateWindow = numberProperty(entry, 'contextWindow', 'context_window')
    if (candidateWindow !== undefined) contextWindow = Math.max(contextWindow ?? 0, candidateWindow)
  }
  const total = input + output + cacheRead + cacheWrite
  const reported = hasInput || hasOutput || hasReasoning || hasCacheRead || hasCacheWrite
  const raw = record(value)
  const normalizedUsage: NormalizedUsage | undefined = reported
    ? {
        uncachedInput: hasInput ? input : null,
        cachedInput: hasCacheRead ? cacheRead : null,
        cacheWrite: hasCacheWrite ? cacheWrite : null,
        output: hasOutput ? output : null,
        reasoning: hasReasoning ? reasoning : null,
        rawProviderUsage: raw ? { ...raw } : { modelUsage: value },
        rawTotal: null,
        totalSemantics: 'unavailable'
      }
    : undefined
  return {
    ...(total > 0 ? { tokens: { input, output, reasoning, cacheRead, cacheWrite, total } } : {}),
    ...(normalizedUsage ? { normalizedUsage } : {}),
    ...(cost > 0 ? { cost } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {})
  }
}

export function rateLimitWindow(
  value: unknown,
  fallbackId = 'claude-rate-limit'
): AgentRateLimitWindow | null {
  const limit = record(value)
  if (!limit) return null
  const status = string(limit['status'])
  const limitType = string(limit['rateLimitType']) ?? string(limit['rate_limit_type'])
  const utilization = numberProperty(limit, 'utilization', 'used_percentage', 'usedPercent')
  const usedPercent =
    utilization === undefined ? undefined : utilization <= 1 ? utilization * 100 : utilization
  const resetsAt = epochMilliseconds(limit['resetsAt'] ?? limit['resets_at'])
  const windowMinutes = numberProperty(limit, 'window_duration_mins', 'windowDurationMins')
  const overageStatus = string(limit['overageStatus']) ?? string(limit['overage_status'])
  const overageDisabledReason =
    string(limit['overageDisabledReason']) ?? string(limit['overage_disabled_reason'])
  const isUsingOverageValue = limit['isUsingOverage'] ?? limit['is_using_overage']
  const isUsingOverage = typeof isUsingOverageValue === 'boolean' ? isUsingOverageValue : undefined
  const id = string(limit['id']) ?? limitType ?? fallbackId ?? status ?? 'claude-rate-limit'
  const label = windowLabel(limitType, windowMinutes, fallbackId)
  // The `get_usage` rate_limits object mixes real windows (five_hour, seven_day,
  // per-model windows) with account-state payloads (extra_usage, limits, spend,
  // member_dashboard_available) that carry no window utilization or reset. Only
  // surface entries that represent an actual quota window so the battery never
  // renders meaningless "usage limit" rows.
  if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
    return null
  }
  return {
    id,
    label,
    ...(status === undefined ? {} : { status }),
    ...(usedPercent === undefined ? {} : { usedPercent: Math.min(100, usedPercent) }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(overageStatus === undefined ? {} : { overageStatus }),
    ...(overageDisabledReason === undefined ? {} : { overageDisabledReason }),
    ...(isUsingOverage === undefined ? {} : { isUsingOverage })
  }
}

/** Human label for a Claude rate-limit type, e.g. `five_hour` → `5-hour`. */
function windowLabel(
  limitType: string | undefined,
  windowMinutes: number | undefined,
  fallbackId?: string
): string {
  if (windowMinutes !== undefined) {
    if (windowMinutes === 300) return '5-hour limit'
    if (windowMinutes === 10_080) return 'Weekly limit'
    if (windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}-day limit`
    if (windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour limit`
    return `${windowMinutes}-minute limit`
  }
  const type = (limitType ?? fallbackId)?.toLowerCase()
  if (type === 'five_hour' || type === '5h' || type === '5hour') return '5-hour limit'
  if (type === 'seven_day' || type === '7day' || type === 'weekly') return 'Weekly limit'
  if (limitType) return limitType.replaceAll('_', ' ')
  return 'usage limit'
}

export function rateLimitWindows(value: unknown): AgentRateLimitWindow[] {
  if (Array.isArray(value)) {
    return value
      .map((item, index) => rateLimitWindow(item, `claude-rate-limit-${index}`))
      .filter((item): item is AgentRateLimitWindow => item !== null)
  }
  const limits = record(value)
  if (!limits) return []
  if ('status' in limits || 'utilization' in limits) {
    const mapped = rateLimitWindow(limits)
    return mapped ? [mapped] : []
  }
  return Object.entries(limits)
    .map(([id, item]) => rateLimitWindow(item, id))
    .filter((item): item is AgentRateLimitWindow => item !== null)
}

export function latestClaudeRateLimits(context: CliLineParseContext): AgentRateLimitWindow[] {
  for (let index = context.session.messages.length - 1; index >= 0; index -= 1) {
    const limits = context.session.messages[index]?.rateLimits
    if (limits && limits.length > 0) return limits
  }
  return []
}
