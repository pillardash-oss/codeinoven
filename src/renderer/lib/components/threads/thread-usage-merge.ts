import type {
  AgentContextUsage,
  AgentMessage,
  AgentRateLimitWindow,
  ThreadContextUsage
} from '$shared/types'

/** Project conversation occupancy without transferring another provider's accounting. */
export function composerContextUsage(
  displayed: AgentContextUsage | undefined,
  messages: readonly AgentMessage[],
  snapshot: ThreadContextUsage | undefined,
  selection: { harnessId: string; providerId: string; contextWindow?: number }
): AgentContextUsage | undefined {
  let source: AgentMessage | ThreadContextUsage | undefined
  let contextUsed: number | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    // Never resurrect occupancy from before a compaction boundary.
    if (
      message.origin === 'compaction' ||
      message.parts.some((part) => part.type === 'compaction-summary')
    ) {
      return displayed
    }
    const tokens =
      message.tokens?.total ||
      message.parts.reduce(
        (total, part) => total + (part.type === 'step-finish' ? (part.tokens?.total ?? 0) : 0),
        0
      )
    if (message.contextUsed !== undefined || tokens > 0) {
      source = message
      contextUsed = message.contextUsed ?? tokens
      break
    }
  }
  source ??= snapshot
  contextUsed ??= source?.contextUsed ?? source?.tokens?.total
  const sameProvider =
    source?.harnessId === selection.harnessId && source?.providerId === selection.providerId
  /**
   * The selected model's window outranks anything recorded earlier. A snapshot
   * or an older turn describes whatever model (and account) wrote it, which is
   * how a thread on a 500k model rendered 100% over a 272k window. A recorded
   * window only stands in for a model whose harness states none.
   */
  const contextWindow =
    selection.contextWindow ?? (sameProvider ? source?.contextWindow : undefined)
  // A settled reading keeps its occupancy but not its window: the resolved
  // window, and a percent recomputed from it, are what the meter must show.
  const settled = sameProvider && displayed?.contextUsed !== undefined
  const used = settled ? displayed.contextUsed : (contextUsed ?? displayed?.contextUsed)
  if (used === undefined && contextWindow === undefined) return displayed
  return {
    ...(displayed ?? { costUsd: 0, rateLimits: [] }),
    ...(used === undefined ? {} : { contextUsed: used }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    contextEstimated: settled
      ? displayed.contextEstimated === true
      : !sameProvider || source?.contextEstimated === true,
    ...(used !== undefined && contextWindow !== undefined && contextWindow > 0
      ? { contextPercent: (used / contextWindow) * 100 }
      : {})
  }
}

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
