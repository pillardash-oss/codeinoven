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
    rateLimits: incoming.rateLimits?.length ? incoming.rateLimits : previous.rateLimits,
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

/**
 * Overlay authoritative harness-reported rate-limit windows on the windows
 * already reported by message data. A window is matched by its duration when
 * known, otherwise by label; the reported window keeps its own id so the UI
 * keeps treating it as the same row.
 */
export function mergeRateLimitWindows(
  reported: readonly AgentRateLimitWindow[],
  authoritative: readonly AgentRateLimitWindow[]
): AgentRateLimitWindow[] {
  const merged = [...reported]
  for (const incoming of authoritative) {
    const match = merged.findIndex(
      (candidate) =>
        (incoming.windowMinutes !== undefined &&
          candidate.windowMinutes === incoming.windowMinutes) ||
        candidate.label.toLowerCase() === incoming.label.toLowerCase()
    )
    if (match === -1) {
      merged.push(incoming)
    } else {
      const current = merged[match]
      if (current) merged[match] = { ...current, ...incoming, id: current.id }
    }
  }
  return merged
}
