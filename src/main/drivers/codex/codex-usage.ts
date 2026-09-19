import type {
  AgentBankedResets,
  AgentRateLimitWindow,
  AgentTokenUsage,
  AgentUsageCredits,
  NormalizedUsage
} from '../../../lib/types'
import { numberValue, recordValue, stringValue } from './codex-values'

/** Codex token accounting and account rate-limit normalization. */

/** Map Codex accounting into the canonical normalized contract and display aggregates. */
function mapCodexTokenRecord(value: Record<string, unknown>): {
  aggregateTokens: AgentTokenUsage | undefined
  normalizedUsage: NormalizedUsage | undefined
} {
  const input =
    numberValue(value['inputTokens']) ??
    numberValue(value['input_tokens']) ??
    numberValue(value['input'])
  const output =
    numberValue(value['outputTokens']) ??
    numberValue(value['output_tokens']) ??
    numberValue(value['output'])
  const reasoning =
    numberValue(value['reasoningOutputTokens']) ??
    numberValue(value['reasoning_output_tokens']) ??
    numberValue(value['reasoning'])
  const cachedInput =
    numberValue(value['cachedInputTokens']) ??
    numberValue(value['cached_input_tokens']) ??
    numberValue(value['cacheRead'])
  const cacheWrite =
    numberValue(value['cacheWriteTokens']) ??
    numberValue(value['cache_write_tokens']) ??
    numberValue(value['cacheWrite'])
  const rawTotal = numberValue(value['totalTokens']) ?? numberValue(value['total_tokens'])
  const reported =
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cachedInput !== undefined ||
    cacheWrite !== undefined ||
    rawTotal !== undefined
  if (!reported) return { aggregateTokens: undefined, normalizedUsage: undefined }
  // Codex reports `input` as the cache-inclusive input count, and cached input
  // is a subset of it, so uncached input is the remainder after the reported
  // cache portion is removed. A defensive clamp keeps a malformed cache value
  // that exceeds the input from producing a negative token count; when input is
  // absent uncached input stays null because there is nothing to subtract from.
  const uncachedInput = input === undefined ? null : Math.max(0, input - (cachedInput ?? 0))
  const normalizedUsage: NormalizedUsage = {
    uncachedInput,
    cachedInput: cachedInput ?? null,
    cacheWrite: cacheWrite ?? null,
    output: output ?? null,
    reasoning: reasoning ?? null,
    rawProviderUsage: { ...value },
    rawTotal: rawTotal ?? null,
    // Codex totals its cache-inclusive input (cached input and reasoning are
    // subsets of input/output), so a reported total includes cached tokens.
    // When no total is reported its semantics are unavailable.
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'includes_cache'
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

export function mapCodexUsage(value: unknown):
  | {
      aggregateTokens: AgentTokenUsage | undefined
      normalizedUsage: NormalizedUsage | undefined
      contextWindow?: number
      contextUsed?: number
    }
  | undefined {
  const usage = recordValue(value)
  if (!usage) return undefined

  const tokenUsage = recordValue(usage['tokenUsage']) ?? recordValue(usage['token_usage']) ?? usage
  const last =
    recordValue(tokenUsage['last']) ??
    recordValue(tokenUsage['lastTokenUsage']) ??
    recordValue(tokenUsage['last_token_usage']) ??
    tokenUsage
  const totalUsage =
    recordValue(tokenUsage['total']) ??
    recordValue(tokenUsage['totalUsage']) ??
    recordValue(tokenUsage['total_usage']) ??
    recordValue(tokenUsage['totalTokenUsage']) ??
    recordValue(tokenUsage['total_token_usage'])

  const lastRecord = mapCodexTokenRecord(last)
  const totalRecord = totalUsage ? mapCodexTokenRecord(totalUsage) : undefined
  const selectedRecord = lastRecord.normalizedUsage !== undefined ? lastRecord : totalRecord
  if (!selectedRecord?.normalizedUsage) return undefined

  const contextUsed =
    numberValue(last['inputTokens']) ??
    numberValue(last['input_tokens']) ??
    numberValue(last['input']) ??
    numberValue(tokenUsage['contextUsed']) ??
    numberValue(tokenUsage['context_used']) ??
    totalRecord?.aggregateTokens?.total ??
    numberValue(tokenUsage['totalTokens']) ??
    numberValue(tokenUsage['total_tokens'])
  const contextWindow =
    numberValue(tokenUsage['modelContextWindow']) ??
    numberValue(tokenUsage['model_context_window']) ??
    numberValue(tokenUsage['contextWindow']) ??
    numberValue(tokenUsage['context_window'])
  return {
    aggregateTokens: selectedRecord.aggregateTokens,
    normalizedUsage: selectedRecord.normalizedUsage,
    ...(contextUsed === undefined ? {} : { contextUsed }),
    ...(contextWindow === undefined ? {} : { contextWindow })
  }
}

function rateLimitLabel(window: Record<string, unknown>, fallback: string): string {
  const minutes = numberValue(window['windowDurationMins'])
  if (minutes === 300) return '5-hour limit'
  if (minutes === 10_080) return 'Weekly limit'
  if (minutes !== undefined) {
    if (minutes % 1_440 === 0) return `${minutes / 1_440}-day limit`
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`
    return `${minutes}-minute limit`
  }
  return fallback
}

/**
 * Normalize one Codex `RateLimitSnapshot` window (primary/secondary) plus the
 * per-limit metadata (window length, credits, plan) into the shared shape.
 * `credits.balance` is a decimal string from the server; it is parsed to a
 * number so the battery can render it.
 */
function mapCodexRateLimitSnapshot(
  limitId: string,
  snapshot: Record<string, unknown>,
  modelSuffix: string | undefined
): { rateLimits: AgentRateLimitWindow[]; credits?: AgentUsageCredits } {
  const mapped: AgentRateLimitWindow[] = []
  const primary = recordValue(snapshot['primary'])
  const secondary = recordValue(snapshot['secondary'])
  const windows: Array<[string, Record<string, unknown> | null, string]> = [
    ['primary', primary, 'Primary limit'],
    ['secondary', secondary, 'Secondary limit']
  ]
  for (const [key, window, fallback] of windows) {
    if (!window) continue
    const usedPercent = numberValue(window['usedPercent'])
    const resetsAt = numberValue(window['resetsAt'])
    const windowMinutes = numberValue(window['windowDurationMins'])
    if (usedPercent === undefined && resetsAt === undefined) continue
    const baseLabel = rateLimitLabel(window, fallback)
    mapped.push({
      id: `codex:${limitId}:${key}`,
      label: modelSuffix ? `${modelSuffix} · ${baseLabel}` : baseLabel,
      ...(usedPercent === undefined
        ? {}
        : { usedPercent: Math.max(0, Math.min(100, usedPercent)) }),
      ...(resetsAt === undefined ? {} : { resetsAt: resetsAt * 1_000 }),
      ...(windowMinutes === undefined ? {} : { windowMinutes }),
      ...(modelSuffix === undefined ? {} : { model: modelSuffix })
    })
  }

  const creditsValue = recordValue(snapshot['credits'])
  let credits: AgentUsageCredits | undefined
  if (creditsValue) {
    const hasCredits = creditsValue['hasCredits'] === true
    const unlimited = creditsValue['unlimited'] === true
    const rawBalance = creditsValue['balance']
    const balance =
      typeof rawBalance === 'string' ? Number.parseFloat(rawBalance) : numberValue(rawBalance)
    if (hasCredits || unlimited || balance !== undefined) {
      credits = {
        ...(typeof creditsValue['hasCredits'] === 'boolean' ? { hasCredits } : {}),
        ...(typeof creditsValue['unlimited'] === 'boolean' ? { unlimited } : {}),
        ...(balance !== undefined && Number.isFinite(balance) ? { balance } : {})
      }
    }
  }

  return { rateLimits: mapped, ...(credits ? { credits } : {}) }
}

/**
 * Map Codex's `account/rateLimits/read` payload into display windows. The
 * response carries a backward-compatible single-bucket `rateLimits` view plus a
 * `rateLimitsByLimitId` map for model-specific quotas (e.g. a separate
 * GPT-Codex-Spark limit). Prefer the per-limit map when present so model-scoped
 * windows are never collapsed into the default buckets.
 */
export function mapCodexRateLimits(value: unknown): {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  bankedResets?: AgentBankedResets
} {
  const result = recordValue(value)
  if (!result) return { rateLimits: [] }
  const byLimitId = recordValue(result['rateLimitsByLimitId'])
  const limits = recordValue(result['rateLimits'])
  const mapped: AgentRateLimitWindow[] = []
  let credits: AgentUsageCredits | undefined

  if (byLimitId && Object.keys(byLimitId).length > 0) {
    for (const [limitId, raw] of Object.entries(byLimitId)) {
      const snapshot = recordValue(raw)
      if (!snapshot) continue
      const limitName = stringValue(snapshot['limitName']) ?? limitId
      const modelSuffix = limitId === 'codex' ? undefined : limitName
      const mappedSnapshot = mapCodexRateLimitSnapshot(limitId, snapshot, modelSuffix)
      mapped.push(...mappedSnapshot.rateLimits)
      if (mappedSnapshot.credits) credits = mappedSnapshot.credits
    }
  } else if (limits) {
    const mappedSnapshot = mapCodexRateLimitSnapshot('codex', limits, undefined)
    mapped.push(...mappedSnapshot.rateLimits)
    if (mappedSnapshot.credits) credits = mappedSnapshot.credits
  }

  if (credits) {
    const planType = stringValue(limits?.['planType']) ?? stringValue(result['planType'])
    if (planType) credits = { ...credits, planType }
  }

  // Older app-server versions report only the count. Newer versions include
  // credit details with expiry timestamps in Unix seconds.
  const resetCredits = recordValue(result['rateLimitResetCredits'])
  const availableCount = numberValue(resetCredits?.['availableCount'])
  const rawCredits = resetCredits?.['credits']
  const availableCredits: NonNullable<AgentBankedResets['credits']> = []
  const seenCreditIds = new Set<string>()
  if (Array.isArray(rawCredits)) {
    for (const raw of rawCredits) {
      const credit = recordValue(raw)
      const id = stringValue(credit?.['id'])
      if (!id || credit?.['status'] !== 'available' || seenCreditIds.has(id)) continue
      seenCreditIds.add(id)
      const seconds = numberValue(credit['expiresAt'])
      const expiresAt = seconds !== undefined ? seconds * 1_000 : undefined
      availableCredits.push({
        id,
        ...(credit['expiresAt'] === null
          ? { expiresAt: null }
          : expiresAt !== undefined && Number.isFinite(new Date(expiresAt).getTime())
            ? { expiresAt }
            : {})
      })
    }
  }
  const bankedResets: AgentBankedResets | undefined =
    availableCount !== undefined
      ? { availableCount, ...(Array.isArray(rawCredits) ? { credits: availableCredits } : {}) }
      : undefined

  return {
    rateLimits: mapped,
    ...(credits ? { credits } : {}),
    ...(bankedResets ? { bankedResets } : {})
  }
}
