import type { ThinkingLevel } from './common'

/**
 * Provider-normalized token accounting for one assistant turn or step.
 *
 * `output` is the provider's total generated tokens for the turn and is always
 * INCLUSIVE of `reasoning`: every driver mapper normalizes to that rule, folding
 * a separately reported reasoning count into `output` when the provider treats
 * the two as disjoint (opencode does; pi, codex, claude-code and antigravity
 * report reasoning as a breakdown of output). `reasoning` is therefore
 * informational, and a generated-token total must never be computed as
 * `output + reasoning`. Use `generatedTokens` in `src/lib/usage-rate.ts`.
 */
export interface AgentTokenUsage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Sum of all token categories as accounted for by the provider. */
  total: number
}

/**
 * Every model or utility operation that can persist a usage event.
 *
 * This list is the single source of truth: the union below is derived from it
 * and the `usage_events` CHECK constraint in `src/main/database/schema.ts` is
 * generated from it, so a new feature value cannot be added without the
 * database accepting it.
 */
export const USAGE_EVENT_FEATURES = [
  'main',
  'title',
  'turn_grade',
  'memory',
  'image_descriptor',
  'search_nudge',
  'computer_use',
  'web',
  'audit',
  'assignment',
  /** Work a main turn delegated to a nested sub-agent session. */
  'subagent',
  /**
   * A disposable session that owns no user turn of its own: temporary chats,
   * virtual tasks (PR compose, utility setup), and generated PRD, brainstorm,
   * spec or assignment drafts.
   */
  'ephemeral'
] as const

/** Model or utility operation responsible for one persisted usage event. */
export type UsageEventFeature = (typeof USAGE_EVENT_FEATURES)[number]

/** Whether and how a provider-reported total can be interpreted. */
export type UsageTotalSemantics =
  | 'includes_cache'
  | 'excludes_cache'
  | 'categories_may_overlap'
  | 'provider_defined'
  | 'unavailable'

/** Source used to calculate or verify an event's monetary cost. */
export interface UsagePricingProvenance {
  source: 'provider' | 'model_catalog' | 'utility_catalog' | 'manual'
  sourceId?: string
  currency: 'USD'
  capturedAt: number
}

/** Provider-neutral token categories. Null means the provider did not report the category. */
export interface NormalizedUsageTokens {
  uncachedInput: number | null
  cachedInput: number | null
  cacheWrite: number | null
  output: number | null
  reasoning: number | null
}

/** Canonical provider-neutral usage attached to messages and usage events. */
export interface NormalizedUsage extends NormalizedUsageTokens {
  rawProviderUsage: Record<string, unknown>
  rawTotal: number | null
  totalSemantics: UsageTotalSemantics
}

/** Cost fields preserve the difference between a true zero and missing pricing data. */
export type UsageEventCost =
  | {
      costStatus: 'known' | 'estimated'
      costUsd: number
      pricingProvenance: UsagePricingProvenance
    }
  | {
      costStatus: 'unavailable'
      costUsd: null
      pricingProvenance: null
    }

/** Stable identity and measurements for one model or utility usage attempt. */
export interface UsageEventDetails {
  id: string
  threadId: string
  parentTurnId: string
  /**
   * Project the attempt belongs to. The ledger derives it from the owning
   * thread, so only work with no thread of its own (a disposable session or a
   * virtual task) has to state it. Null and undefined both fall back to the
   * thread lookup.
   */
  projectId?: string | null
  /** Stable caller-provided identity that separates multiple calls of the same feature. */
  featureCallId: string
  attempt: number
  feature: UsageEventFeature
  harnessId: string | null
  /** Credential container that owned the attempt. */
  accountId?: string | null
  providerId: string | null
  modelId: string | null
  /** Reasoning effort in effect when the attempt ran, when known. */
  thinkingLevel: ThinkingLevel | null
  utilityId: string | null
  rawProviderUsage: Record<string, unknown>
  tokens: NormalizedUsageTokens
  /** Accounted token count: provider rawTotal when present, otherwise the sum of reported categories. */
  tokensTotal?: number | null
  rawTotal: number | null
  totalSemantics: UsageTotalSemantics
  toolFeeUsd: number | null
  success: boolean
  retryCause: string | null
  /** Runtime of this usage attempt, measured from its provider timestamps when available. */
  durationMs?: number
  createdAt: number
}

/** Durable, replay-safe accounting record for one attempt. */
export type UsageEvent = UsageEventDetails & UsageEventCost

/** One main-agent cache measurement grouped by its telemetry provenance. */
export interface UsageCacheHitBreakdown {
  harnessId: string | null
  providerId: string | null
  modelId: string | null
  mainAttempts: number
  reportedAttempts: number
  uncachedInputTokens: number
  cachedInputTokens: number
  cacheHitRatio: number | null
}

/** Provider-neutral efficiency metrics derived only from normalized usage events. */
export interface UsageEfficiencyKpis {
  successfulTurns: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
  /** Main-agent cache hit ratio; auxiliary model and utility calls are excluded. */
  cacheHitRatio: number | null
  cacheEligibleEvents: number
  cacheReportedEvents: number
  cacheCoverageRatio: number | null
  cacheBreakdown: UsageCacheHitBreakdown[]
  auxiliaryUncachedInputTokens: number
  auxiliaryCachedInputTokens: number
  auxiliaryCacheHitRatio: number | null
  mainAttempts: number
  retryAmplification: number | null
  auxiliaryCostUsd: number
  totalPricedCostUsd: number
  auxiliaryCostShare: number | null
  toolResultTokens: number
  knownCostUsd: number
  estimatedCostUsd: number
  unavailableCostEvents: number
  pricedCostEvents: number
  totalCostEvents: number
  costCoverageRatio: number | null
  perSuccessfulTurn: {
    uncachedInputTokens: number | null
    outputAndReasoningTokens: number | null
    toolResultTokens: number | null
  }
}

/** Optional account quota telemetry exposed by a provider. */
export interface AgentRateLimitWindow {
  id: string
  label: string
  /** Provider-reported access state, such as `allowed` or `rejected`. */
  status?: string
  usedPercent?: number
  remaining?: number
  limit?: number
  resetsAt?: number
  /** Rolling window length in minutes (e.g. 300 for the Codex 5-hour limit). */
  windowMinutes?: number
  /** Model the window applies to, when the provider splits limits per model. */
  model?: string
  overageStatus?: string
  overageDisabledReason?: string
  isUsingOverage?: boolean
}

/** Banked rate-limit resets a user can redeem on demand (currently Codex-only). */
export interface AgentBankedResets {
  /** Number of banked resets available to redeem. */
  availableCount: number
  /** Available credits, when the provider reports individual details. */
  credits?: {
    id: string
    /** Unix milliseconds; null means no expiry, omitted means unavailable. */
    expiresAt?: number | null
  }[]
}

/** Prepaid-credit balance reported alongside quota windows (e.g. Codex credits). */
export interface AgentUsageCredits {
  /** Remaining balance in the provider's credit currency, when metered. */
  balance?: number
  /** True when the account is metered by prepaid credits rather than a plan. */
  hasCredits?: boolean
  /** True when the account reports an unlimited cap. */
  unlimited?: boolean
  /** Provider plan identifier, such as `prolite` for Codex. */
  planType?: string
}

/** Display-ready provider-neutral usage for the active conversation. */
export interface AgentContextUsage {
  contextWindow?: number
  /** Tokens occupying the context when the harness reports that value. */
  contextUsed?: number
  /** True when context occupancy was estimated from the composed request. */
  contextEstimated?: boolean
  contextPercent?: number
  costUsd: number
  /** Per-turn token categories when the harness exposes token accounting. */
  tokens?: AgentTokenUsage
  rateLimits: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported alongside quota windows. */
  credits?: AgentUsageCredits
  /** Banked rate-limit resets available to redeem (currently Codex-only). */
  bankedResets?: AgentBankedResets
}

/** Per-harness quota telemetry for threads that used more than one harness. */
export interface AgentHarnessUsage {
  harnessId: string
  providerId: string
  modelId?: string
  /** Total USD this harness consumed on the thread, when the harness reports cost. */
  costUsd: number
  /** Latest quota windows reported by this harness on the thread. */
  rateLimits: AgentRateLimitWindow[]
  /** Prepaid-credit balance reported by this harness on the thread. */
  credits?: AgentUsageCredits
  /** Banked rate-limit resets available to redeem (currently Codex-only). */
  bankedResets?: AgentBankedResets
  /** Cumulative token accounting from the harness_usage table, when available. */
  tokens?: AgentTokenUsage
  /** Assistant messages attributed to this harness on the thread. */
  messageCount?: number
  /** Approximate cumulative wall-clock time spent in turns, ms. */
  durationMs?: number
  /** Per-model cost breakdown for this harness on the thread, when available. */
  models?: HarnessModelUsage[]
}

/** Optional harness/provider the quota read should answer for when no thread
 *  row (or live temporary session) exists yet   e.g. the inbox "Start a new
 *  chat" composer before its first turn. */
export interface AgentAccountUsageOverrides {
  harnessId?: string
  providerId?: string
  accountId?: string
}

/** On-demand account quota snapshot for one harness used on a thread. */
export interface AgentAccountUsage {
  harnessId: string
  providerId: string
  accountId?: string
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  /** Banked rate-limit resets available to redeem (currently Codex-only). */
  bankedResets?: AgentBankedResets
  /** Effective model context window (tokens) for the active session, when known. */
  contextWindow?: number
  /** Tokens currently occupying the model context, when known. */
  contextUsed?: number
}

/**
 * Quota telemetry read from one custom provider's user-defined usage route.
 * The route is the provider author's contract   CodeInOven accepts the common
 * OpenAI/`new-api`-style `{ data: [...] }` envelope plus flat quota objects
 * and maps whatever it can recognize into rate-limit windows.
 */
export interface CustomProviderUsage {
  providerId: string
  /** Harness the usage route belongs to. */
  harnessId: string
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  /** Raw endpoint the snapshot came from, for diagnostics. */
  source: string
}

/** Last-known usage snapshot stored with a thread so the meter restores
 *  instantly on mount and is evacuated automatically when the thread row is
 *  deleted. The harness/provider pair guard against showing usage from a
 *  different agent configuration. */
export interface ThreadContextUsage extends AgentContextUsage {
  harnessId: string
  providerId: string
  /** Model the usage was reported under. A snapshot from a different model
   *  carries that model's context window, so it must never seed a meter (or
   *  drive an auto-compaction decision) for the newly selected model. */
  modelId?: string
}

/** One row of cumulative per-harness analytics keyed by (thread, harness, provider). */
export interface HarnessUsage {
  projectId: string
  threadId: string
  harnessId: string
  providerId: string
  /** Last model observed for this harness on the thread. */
  modelId?: string
  /** Last thinking level observed for this harness on the thread. */
  thinkingLevel?: ThinkingLevel
  /** Number of assistant messages attributed to this harness on the thread. */
  messageCount: number
  /** Cumulative USD cost, when the harness reports cost. */
  costUsd: number
  /** Cumulative token accounting across this harness's messages on the thread. */
  tokens: AgentTokenUsage
  /** Approximate cumulative wall-clock time spent in turns attributed to this harness, ms. */
  durationMs: number
  firstUsedAt: number
  lastUsedAt: number
  /** Per-model cost breakdown for this harness on the thread, when available. */
  models?: HarnessModelUsage[]
}

/** One row of cumulative per-model analytics keyed by (thread, harness, provider, model). */
export interface HarnessModelUsage {
  threadId: string
  harnessId: string
  providerId: string
  modelId: string
  /** Reasoning effort of the turns attributed to this model, when known. */
  thinkingLevel?: ThinkingLevel
  /** Number of assistant messages attributed to this model on the thread. */
  messageCount: number
  /** Cumulative USD cost attributed to this model, when the harness reports cost. */
  costUsd: number
  /** Cumulative token accounting across this model's messages on the thread. */
  tokens: AgentTokenUsage
  /** Approximate cumulative wall-clock time spent in turns, ms. */
  durationMs: number
  firstUsedAt: number
  lastUsedAt: number
}

/** One aggregate row shown on the account profile. */
export interface AccountUsageBreakdown {
  id: string
  messageCount: number
  costUsd: number
  tokens: number
}

/** One calendar day containing completed assistant work. */
export interface AccountActivityDay {
  date: string
  messageCount: number
}
