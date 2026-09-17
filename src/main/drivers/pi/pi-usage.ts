import type {
  AgentMessage,
  AgentRateLimitWindow,
  AgentTokenUsage,
  NormalizedUsage,
  SessionAgentEvent
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import type { PersistentCliSession } from '../persistent-cli-driver'
import type { PiRpcClient } from '../pi-rpc-client'
import { numberValue, record } from './pi-values'

/** Pi token, cost, context, and provider rate-limit accounting. */

/**
 * Parse a Pi token/cost accounting object into the shared usage shape.
 *
 * The aggregate total sums every reported category, including `reasoning`,
 * which Pi reports on its own field beside `output` (the shared accumulator in
 * `pi-compaction-extension.ts` carries it as a separate field too). Pi's own
 * `totalTokens` for the turn is preserved on the normalized payload as
 * `rawTotal` rather than being trusted as the display total, so this aggregate
 * never drops a billed category.
 */
function mapPiUsage(value: unknown): AgentTokenUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['input']) ?? 0
  const output = numberValue(usage['output']) ?? 0
  const cacheRead = numberValue(usage['cacheRead']) ?? 0
  const cacheWrite = numberValue(usage['cacheWrite']) ?? 0
  const reasoning = numberValue(usage['reasoning']) ?? 0
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
 * Map a Pi turn's usage into the canonical normalized contract.
 *
 * Pi reports the prompt cache as separate categories beside the uncached
 * input, which its own cache statistics treat as disjoint parts of one prompt
 * (`promptTokens = input + cacheRead + cacheWrite`), so `input` is the uncached
 * remainder and no subtraction is needed. Pi also reports its own `totalTokens`
 * for the turn; the composition of that total is the provider's business, so it
 * is recorded as `rawTotal` with `provider_defined` semantics instead of being
 * asserted as cache-inclusive, and the whole raw object is kept so the
 * provider's own evidence survives alongside the normalized categories.
 */
function mapPiNormalizedUsage(value: unknown): NormalizedUsage | undefined {
  const usage = record(value)
  if (!usage) return undefined
  const input = numberValue(usage['input'])
  const output = numberValue(usage['output'])
  const reasoning = numberValue(usage['reasoning'])
  const cachedInput = numberValue(usage['cacheRead'])
  const cacheWrite = numberValue(usage['cacheWrite'])
  const rawTotal = numberValue(usage['totalTokens']) ?? numberValue(usage['total'])
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
    totalSemantics: rawTotal === undefined ? 'unavailable' : 'provider_defined'
  }
}

/** Extract assistant cost in USD from a Pi usage object. */
function mapPiCost(value: unknown): number | undefined {
  const usage = record(value)
  const cost = record(usage?.['cost'])
  if (typeof cost?.['total'] === 'number') return cost['total']
  if (typeof usage?.['total'] === 'number') return usage['total']
  return undefined
}

/**
 * Matches the error pi's `get_session_stats` RPC returns when its stats walk
 * crashes on an assistant history entry that carries no `usage` object
 * (pi's addUsageToTotals reads `usage.input` unguarded, pi 0.85.1 and
 * earlier). In such sessions the RPC fails identically on every call, so the
 * driver falls back to mirrored per-message accounting instead of retrying.
 */
function isUsagelessAssistantStatsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /cannot read properties of undefined \(reading 'input'\)/iu.test(error.message)
  )
}

/** Sum the per-message cost mirrored into a session's assistant messages so
 *  sessions with a broken native stats RPC still receive cumulative cost. */
function mirroredSessionCost(session: PersistentCliSession): number | undefined {
  let total: number | undefined
  let unmirrored = false
  for (const message of session.messages) {
    if (message.role !== 'assistant') continue
    if (typeof message.cost === 'number') total = (total ?? 0) + message.cost
    else unmirrored = true
  }
  // Costless assistant turns (aborted, errored, or pre-usage mirrors) make a
  // partial sum misleading but still better than nothing; both stay falsy
  // when nothing was reported at all.
  if (unmirrored && total === undefined) return undefined
  return total
}

/** Last provider-reported context occupancy from the session's mirrored
 *  assistant messages: the final turn's usage total (input + cache + output)
 *  is the prompt size the provider actually processed, so it is the honest
 *  occupancy signal when pi's own contextUsage stats cannot answer (gateway
 *  models pi has no contextWindow for, broken stats RPC, post-compaction
 *  silence). Errored/aborted turns report zero usage and are skipped. */
function mirroredContextUsed(messages: readonly AgentMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    if (message.error !== undefined) continue
    const total = message.tokens?.total
    if (typeof total === 'number' && Number.isFinite(total) && total > 0) return total
  }
  return undefined
}

/** Numeric header value ('1234' → 1234); non-numeric returns undefined. */
function headerNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse a rate-limit reset value. Providers send either a relative duration
 * ('1s', '6m0s', '1h0m30s') or an absolute ISO timestamp; both resolve to an
 * absolute reset epoch, undefined when unparseable.
 */
function headerResetAt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (/^\d/u.test(value)) {
    let seconds = 0
    for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)([hms])/gu)) {
      const n = Number(amount)
      if (!Number.isFinite(n)) return undefined
      seconds += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n
    }
    if (seconds > 0) return Date.now() + seconds * 1_000
    return undefined
  }
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : undefined
}

/** Build a usage bar window from remaining/limit header pairs. */
function windowFromHeaders(
  id: string,
  label: string,
  headers: Record<string, string>,
  remainingKey: string,
  limitKey: string,
  resetKey?: string,
  extra?: Partial<AgentRateLimitWindow>
): AgentRateLimitWindow | null {
  const remaining = headerNumber(headers[remainingKey])
  const limit = headerNumber(headers[limitKey])
  if (remaining === undefined && limit === undefined) return null
  const usedPercent =
    remaining !== undefined && limit !== undefined && limit > 0
      ? Math.min(100, Math.max(0, ((limit - remaining) / limit) * 100))
      : undefined
  const resetsAt = resetKey ? headerResetAt(headers[resetKey]) : undefined
  if (remaining === undefined && limit === undefined && resetsAt === undefined) return null
  return {
    id,
    label,
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...extra
  }
}

/**
 * The pi provider id the captured headers came from, taken from the usage
 * extension's payload (`ctx.model.provider`   the same id space as thread
 * settings' providerId). Used to key persisted windows per provider.
 */
function piUsageProviderId(payload: unknown): string | undefined {
  const provider = record(payload)?.['provider']
  return typeof provider === 'string' && provider.length > 0 ? provider : undefined
}

/**
 * Map the usage extension's captured provider response headers into display
 * usage bars. Recognizes the Anthropic subscription unified windows (5-hour,
 * 7-day, with overage state), Anthropic per-minute request/token buckets, and
 * the OpenAI-compatible `x-ratelimit-*` family (OpenAI, OpenRouter, most
 * base-URL providers). Unrecognized headers are ignored.
 */
export function mapPiRateLimitHeaders(payload: unknown): AgentRateLimitWindow[] {
  const envelope = record(payload)
  const headers = record(envelope?.['headers'])
  if (!headers) return []
  const stringHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') stringHeaders[key.toLowerCase()] = value
  }
  const windows: AgentRateLimitWindow[] = []

  // Anthropic subscription unified windows   the quota Claude Pro/Max usage
  // bars show. Status and overage fields live on the 5-hour window, matching
  // how Claude Code surfaces them.
  const unifiedStatus = stringHeaders['anthropic-ratelimit-unified-5h-status']
  const fiveHour = windowFromHeaders(
    'pi-unified-5h',
    '5-hour limit',
    stringHeaders,
    'anthropic-ratelimit-unified-5h-remaining',
    'anthropic-ratelimit-unified-5h-limit',
    'anthropic-ratelimit-unified-5h-reset',
    {
      windowMinutes: 300,
      ...(unifiedStatus !== undefined ? { status: unifiedStatus } : {}),
      ...(stringHeaders['anthropic-ratelimit-unified-overage-status'] !== undefined
        ? { overageStatus: stringHeaders['anthropic-ratelimit-unified-overage-status'] }
        : {}),
      ...(stringHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] !== undefined
        ? {
            overageDisabledReason:
              stringHeaders['anthropic-ratelimit-unified-overage-disabled-reason']
          }
        : {})
    }
  )
  if (fiveHour) windows.push(fiveHour)
  const sevenDay = windowFromHeaders(
    'pi-unified-7d',
    '7-day limit',
    stringHeaders,
    'anthropic-ratelimit-unified-7d-remaining',
    'anthropic-ratelimit-unified-7d-limit',
    'anthropic-ratelimit-unified-7d-reset',
    { windowMinutes: 10_080 }
  )
  if (sevenDay) windows.push(sevenDay)

  // Anthropic per-minute buckets.
  const requests = windowFromHeaders(
    'pi-requests',
    'Requests',
    stringHeaders,
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-reset'
  )
  if (requests) windows.push(requests)
  const inputTokens = windowFromHeaders(
    'pi-input-tokens',
    'Input tokens',
    stringHeaders,
    'anthropic-ratelimit-input-tokens-remaining',
    'anthropic-ratelimit-input-tokens-limit',
    'anthropic-ratelimit-input-tokens-reset'
  )
  if (inputTokens) windows.push(inputTokens)

  // OpenAI-compatible family (OpenAI, OpenRouter, OpenAI-compatible proxies).
  const openAiRequests = windowFromHeaders(
    'pi-openai-requests',
    'Requests',
    stringHeaders,
    'x-ratelimit-remaining-requests',
    'x-ratelimit-limit-requests',
    'x-ratelimit-reset-requests'
  )
  if (openAiRequests) windows.push(openAiRequests)
  const openAiTokens = windowFromHeaders(
    'pi-openai-tokens',
    'Tokens',
    stringHeaders,
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-reset-tokens'
  )
  if (openAiTokens) windows.push(openAiTokens)

  return windows
}

export {
  mapPiUsage,
  mapPiNormalizedUsage,
  mapPiCost,
  isUsagelessAssistantStatsError,
  mirroredSessionCost,
  mirroredContextUsed,
  headerNumber,
  headerResetAt,
  windowFromHeaders,
  piUsageProviderId
}

/** Everything a usage refresh needs from its host driver. */
export interface PiUsageRefreshContext {
  client: PiRpcClient | null
  sessionStatsBroken: Set<string>
  rateLimits: AgentRateLimitWindow[]
  applyEvent: (session: PersistentCliSession, event: SessionAgentEvent) => void
  emit: (event: SessionAgentEvent) => void
}

/** Attach the final session-stats context usage to the last assistant message. */
export async function refreshSessionUsageFromStats(
  session: PersistentCliSession,
  context: PiUsageRefreshContext
): Promise<void> {
  const client = context.client
  if (!client) return
  const lastAssistant = [...session.messages].reverse().find((message) => {
    return message.role === 'assistant'
  })
  if (!lastAssistant) return
  let stats: Record<string, unknown> | null = null
  if (!context.sessionStatsBroken.has(session.id)) {
    try {
      stats = record(await client.getSessionStats())
    } catch (error) {
      if (isUsagelessAssistantStatsError(error)) {
        // Pi's stats walk crashes on a usage-less assistant entry; remember
        // that so no later refresh re-raises it, and account from the
        // per-message usage already mirrored in this session instead.
        context.sessionStatsBroken.add(session.id)
        stats = null
      } else {
        // A disposed client means the session was torn down mid-refresh   an
        // expected race at turn end, not a failure worth surfacing.
        if (error instanceof Error && error.message === 'Pi process disposed') return
        Logger.dev('Pi session stats refresh failed:', error)
        return
      }
    }
  }
  if (stats === null) {
    applyMirroredUsage(session, lastAssistant, context)
    return
  }
  try {
    const contextUsage = record(stats?.['contextUsage'])
    const cost = typeof stats?.['cost'] === 'number' ? (stats['cost'] as number) : mapPiCost(stats)
    const contextWindow = numberValue(contextUsage?.['contextWindow'])
    // pi's getContextUsage() returns undefined when its session model carries
    // no contextWindow (gateway models missing from pi's registry), and
    // `{ tokens: null }` after a compaction with no post-compaction usage.
    // The provider's own per-turn accounting is still mirrored on the
    // session's assistant messages, and its last total IS the context
    // occupancy (prompt + completion of the last request), so use it rather
    // than reporting nothing and letting a text-only estimate fill the gap.
    const contextUsed =
      numberValue(contextUsage?.['tokens']) ?? mirroredContextUsed(session.messages)
    const rateLimits = context.rateLimits
    if (
      cost === undefined &&
      contextWindow === undefined &&
      contextUsed === undefined &&
      rateLimits.length === 0
    ) {
      return
    }
    const event: SessionAgentEvent = {
      type: 'usage.updated',
      sessionId: session.id,
      messageId: lastAssistant.id,
      // Session stats are CUMULATIVE across the whole session   attaching
      // them as the message's `tokens` made per-message output counts (and
      // any derived tokens/second rate) wildly inflated. Per-message usage
      // was already reported by the message.completed event; this refresh
      // only contributes cost, context occupancy, and rate-limit windows.
      ...(cost !== undefined ? { cost } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(contextUsed !== undefined ? { contextUsed } : {}),
      ...(rateLimits.length > 0 ? { rateLimits } : {})
    }
    context.applyEvent(session, event)
    context.emit(event)
  } catch {
    // Stats-only application cannot fail for a live session; keep the
    // refresh contract non-throwing regardless of malformed stats payloads.
  }
}

/** Emit cumulative cost, context occupancy, and rate-limit windows for a
 *  session whose native stats RPC is broken, using the per-message accounting
 *  the turn events already mirrored into `session.messages`. */
export function applyMirroredUsage(
  session: PersistentCliSession,
  lastAssistant: AgentMessage | undefined,
  context: PiUsageRefreshContext
): void {
  if (!lastAssistant) return
  const cost = mirroredSessionCost(session)
  const contextUsed = mirroredContextUsed(session.messages)
  const rateLimits = context.rateLimits
  if (cost === undefined && contextUsed === undefined && rateLimits.length === 0) return
  const event: SessionAgentEvent = {
    type: 'usage.updated',
    sessionId: session.id,
    messageId: lastAssistant.id,
    ...(cost !== undefined ? { cost } : {}),
    ...(contextUsed !== undefined ? { contextUsed } : {}),
    ...(rateLimits.length > 0 ? { rateLimits } : {})
  }
  context.applyEvent(session, event)
  context.emit(event)
}
