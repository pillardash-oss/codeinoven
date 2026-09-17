import type { AgentRateLimitWindow, AgentTokenUsage, AgentUsageCredits } from '../../../lib/types'
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

export function tokenUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberProperty(usage, 'input_tokens', 'inputTokens') ?? 0
  const output = numberProperty(usage, 'output_tokens', 'outputTokens') ?? 0
  const cacheRead = numberProperty(usage, 'cache_read_input_tokens', 'cacheReadInputTokens') ?? 0
  const cacheWrite =
    numberProperty(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0
  const outputDetails = record(usage['output_tokens_details'] ?? usage['outputTokensDetails'])
  const reasoning =
    numberProperty(usage, 'reasoning_tokens', 'reasoningTokens') ??
    numberProperty(outputDetails ?? {}, 'thinking_tokens', 'thinkingTokens') ??
    0
  const total =
    numberProperty(usage, 'total_tokens', 'totalTokens') ?? input + output + cacheRead + cacheWrite
  return total > 0 ? { input, output, reasoning, cacheRead, cacheWrite, total } : undefined
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

export function aggregateModelUsage(value: unknown): {
  tokens?: AgentTokenUsage
  cost?: number
  contextWindow?: number
} {
  const entries = modelUsageRecords(value)
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let contextWindow: number | undefined
  for (const entry of entries) {
    input += numberProperty(entry, 'inputTokens', 'input_tokens') ?? 0
    output += numberProperty(entry, 'outputTokens', 'output_tokens') ?? 0
    reasoning += numberProperty(entry, 'reasoningTokens', 'reasoning_tokens') ?? 0
    cacheRead += numberProperty(entry, 'cacheReadInputTokens', 'cache_read_input_tokens') ?? 0
    cacheWrite +=
      numberProperty(entry, 'cacheCreationInputTokens', 'cache_creation_input_tokens') ?? 0
    cost += numberProperty(entry, 'costUSD', 'costUsd', 'cost_usd') ?? 0
    const candidateWindow = numberProperty(entry, 'contextWindow', 'context_window')
    if (candidateWindow !== undefined) contextWindow = Math.max(contextWindow ?? 0, candidateWindow)
  }
  const total = input + output + reasoning + cacheRead + cacheWrite
  return {
    ...(total > 0 ? { tokens: { input, output, reasoning, cacheRead, cacheWrite, total } } : {}),
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
