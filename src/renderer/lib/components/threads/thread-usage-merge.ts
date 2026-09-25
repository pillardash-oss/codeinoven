import type { AgentContextUsage, AgentRateLimitWindow } from '$shared/types'

/**
 * Merging rules for usage data that arrives from more than one source.
 *
 * A thread's context usage is assembled from persisted snapshots, live session
 * events, and harness quota reads, so each field needs a stated precedence rule
 * instead of blind overwrites. Keeping those rules in one place makes the
 * precedence auditable.
 */

/**
 * Window ids used by the retired synthetic usage-limit bar. The generator is
 * gone, but thread snapshots persisted before its removal still carry the
 * window, so every read filters it out instead of resurrecting a fabricated
 * "Reset time unavailable" row in the battery.
 */
const LEGACY_SYNTHETIC_WINDOW_ID_PREFIX = 'provider-issue:'

/** Keep only provider-reported quota windows; drop legacy synthetic rows. */
export function providerReportedWindows(
  limits: readonly AgentRateLimitWindow[]
): AgentRateLimitWindow[] {
  return limits.filter((limit) => !limit.id.startsWith(LEGACY_SYNTHETIC_WINDOW_ID_PREFIX))
}

/**
 * Layer an incoming context usage report over the previously displayed one.
 * Every field falls back to the previous value when the incoming report omits
 * it, so a partial update can never blank the battery or the quota popover.
 */
export function mergeContextUsage(
  previous: AgentContextUsage | undefined,
  incoming: AgentContextUsage
): AgentContextUsage {
  if (!previous) return incoming
  return {
    ...previous,
    ...incoming,
    tokens: incoming.tokens ?? previous.tokens,
    costUsd: incoming.costUsd ?? previous.costUsd,
    contextUsed: incoming.contextUsed ?? previous.contextUsed,
    contextEstimated:
      incoming.contextUsed !== undefined
        ? incoming.contextEstimated === true
        : previous.contextEstimated === true,
    contextWindow: incoming.contextWindow ?? previous.contextWindow,
    contextPercent: incoming.contextPercent ?? previous.contextPercent,
    rateLimits: providerReportedWindows(
      incoming.rateLimits?.length ? incoming.rateLimits : (previous.rateLimits ?? [])
    ),
    ...(incoming.credits
      ? { credits: incoming.credits }
      : previous.credits
        ? { credits: previous.credits }
        : {}),
    ...(incoming.bankedResets
      ? { bankedResets: incoming.bankedResets }
      : previous.bankedResets
        ? { bankedResets: previous.bankedResets }
        : {})
  }
}
