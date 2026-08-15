import type { Database } from '../database'
import type {
  AccountActivityDay,
  AccountUsageBreakdown,
  AccountUsageSummary,
  AgentMessage,
  AgentTokenUsage,
  HarnessModelUsage,
  HarnessUsage,
  LocalProfileAnalytics,
  LocalProfileAnalyticsRange,
  LocalProfileProjectBreakdown,
  LocalProfileUsageBreakdown,
  SyncedDeviceProject,
  ThinkingLevel,
  UsageCacheHitBreakdown,
  UsageEfficiencyKpis,
  UsageEvent
} from '../../../lib/types'

interface HarnessUsageRow {
  project_id: string
  thread_id: string
  harness_id: string
  provider_id: string
  model_id: string | null
  thinking_level: string | null
  message_count: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  tokens_total: number
  duration_ms: number
  first_used_at: number
  last_used_at: number
}

interface HarnessModelUsageRow {
  thread_id: string
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string | null
  message_count: number
  cost_usd: number
  tokens_in: number
  tokens_out: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  tokens_total: number
  duration_ms: number
  first_used_at: number
  last_used_at: number
}

interface UsageAggregateRow {
  id: string
  message_count: number
  cost_usd: number
  tokens_total: number
  duration_ms: number
}

interface LocalUsageAggregateRow extends UsageAggregateRow {
  harness_id: string | null
  provider_id: string | null
  thinking_level: string | null
}

interface LocalProjectAggregateRow extends UsageAggregateRow {
  name: string
  color: string | null
  icon_type: string | null
  icon: string | null
  thread_count: number
  active_days: number
  last_active_at: number
}

/**
 * Auxiliary utility features whose usage is recorded in `usage_events` but is
 * NOT already represented by an assistant `agent_messages` row (so adding them
 * to the profile totals never double-counts an agent turn). Web and
 * computer-use tool calls are excluded because their tokens ride inside the
 * parent agent turn.
 */
const PROFILE_UTILITY_FEATURES = ['image_descriptor', 'memory', 'title', 'search_nudge'] as const

/** Upper bound for profile analytics result sets (worker bounded reads). */
const ANALYTICS_MAX_ROWS = 100_000

function tokensFromRow(
  row: Pick<
    HarnessUsageRow | HarnessModelUsageRow,
    | 'tokens_in'
    | 'tokens_out'
    | 'tokens_reasoning'
    | 'tokens_cache_read'
    | 'tokens_cache_write'
    | 'tokens_total'
  >
): AgentTokenUsage {
  return {
    input: row.tokens_in,
    output: row.tokens_out,
    reasoning: row.tokens_reasoning,
    cacheRead: row.tokens_cache_read,
    cacheWrite: row.tokens_cache_write,
    total: row.tokens_total
  }
}

function rowToHarnessUsage(row: HarnessUsageRow): HarnessUsage {
  return {
    projectId: row.project_id,
    threadId: row.thread_id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level as ThinkingLevel } : {}),
    messageCount: row.message_count,
    costUsd: row.cost_usd,
    tokens: tokensFromRow(row),
    durationMs: row.duration_ms,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at
  }
}

function rowToHarnessModelUsage(row: HarnessModelUsageRow): HarnessModelUsage {
  return {
    threadId: row.thread_id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level as ThinkingLevel } : {}),
    messageCount: row.message_count,
    costUsd: row.cost_usd,
    tokens: tokensFromRow(row),
    durationMs: row.duration_ms,
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at
  }
}

/** Sum of step-finish cost parts on an assistant message, mirroring the renderer. */
function messageCost(message: AgentMessage): number | null {
  let stepCost = 0
  let hasStepCost = false
  for (const part of message.parts) {
    if (part.type === 'step-finish' && typeof part.cost === 'number') {
      stepCost += part.cost
      hasStepCost = true
    }
  }
  return message.cost ?? (hasStepCost ? stepCost : null)
}

export interface UsageCostCoverage {
  knownUsd: number
  estimatedUsd: number
  unavailableEvents: number
  totalEvents: number
}

export class HarnessUsageRepo {
  constructor(private db: Database) {}

  /** Persist one usage attempt. Replaying its stable identity is a no-op. */
  recordEvent(event: UsageEvent): void {
    this.db.run(
      `INSERT OR IGNORE INTO usage_events(
        id, thread_id, parent_turn_id, feature_call_id, attempt, feature,
        harness_id, provider_id, model_id, thinking_level, utility_id, raw_provider_usage_json,
        tokens_uncached_input, tokens_cached_input, tokens_cache_write,
        tokens_output, tokens_reasoning, raw_total, total_semantics,
        cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
        success, retry_cause, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      event.id,
      event.threadId,
      event.parentTurnId,
      event.featureCallId,
      event.attempt,
      event.feature,
      event.harnessId,
      event.providerId,
      event.modelId,
      event.thinkingLevel,
      event.utilityId,
      JSON.stringify(event.rawProviderUsage),
      event.tokens.uncachedInput,
      event.tokens.cachedInput,
      event.tokens.cacheWrite,
      event.tokens.output,
      event.tokens.reasoning,
      event.rawTotal,
      event.totalSemantics,
      event.costUsd,
      event.costStatus,
      event.pricingProvenance === null ? null : JSON.stringify(event.pricingProvenance),
      event.toolFeeUsd,
      event.success ? 1 : 0,
      event.retryCause,
      event.createdAt
    )
  }

  /** Cost totals with explicit coverage; unavailable events never enter USD sums. */
  costCoverage(threadId?: string): UsageCostCoverage {
    const row = this.db.get<{
      known_usd: number
      estimated_usd: number
      unavailable_events: number
      total_events: number
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN cost_status = 'known' THEN cost_usd ELSE 0 END), 0) AS known_usd,
         COALESCE(SUM(CASE WHEN cost_status = 'estimated' THEN cost_usd ELSE 0 END), 0) AS estimated_usd,
         SUM(CASE WHEN cost_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_events,
         COUNT(*) AS total_events
       FROM usage_events
       WHERE (? IS NULL OR thread_id = ?)`,
      threadId ?? null,
      threadId ?? null
    )
    return {
      knownUsd: row?.known_usd ?? 0,
      estimatedUsd: row?.estimated_usd ?? 0,
      unavailableEvents: row?.unavailable_events ?? 0,
      totalEvents: row?.total_events ?? 0
    }
  }

  /** Economically comparable metrics for completed successful user turns. */
  efficiencyKpis(range?: LocalProfileAnalyticsRange): UsageEfficiencyKpis {
    return this.computeEfficiencyKpis(range)
  }

  /** Economically comparable metrics scoped to a single thread's completed turns. */
  efficiencyKpisForThread(threadId: string): UsageEfficiencyKpis {
    return this.computeEfficiencyKpis(undefined, threadId)
  }

  private computeEfficiencyKpis(
    range?: LocalProfileAnalyticsRange,
    threadId?: string
  ): UsageEfficiencyKpis {
    const row = this.db.get<{
      successful_turns: number
      uncached_input: number
      cached_input: number
      main_uncached_input: number
      main_cached_input: number
      cache_reported_events: number
      auxiliary_uncached_input: number
      auxiliary_cached_input: number
      auxiliary_cache_reported_events: number
      output: number
      reasoning: number
      main_attempts: number
      auxiliary_cost: number
      known_cost: number
      estimated_cost: number
      unavailable_cost_events: number
      priced_cost_events: number
      total_cost_events: number
      tool_result_tokens: number
    }>(
      `WITH successful_turns AS (
         SELECT DISTINCT thread_id, parent_turn_id
         FROM usage_events
         WHERE feature IN ('main', 'audit', 'assignment') AND success = 1
           AND (? IS NULL OR created_at >= ?)
           AND (? IS NULL OR created_at < ?)
           AND (? IS NULL OR thread_id = ?)
       ), scoped AS (
         SELECT event.*
         FROM usage_events event
         JOIN successful_turns turn
           ON turn.thread_id = event.thread_id AND turn.parent_turn_id = event.parent_turn_id
       )
       SELECT
         (SELECT COUNT(*) FROM successful_turns) AS successful_turns,
         COALESCE(SUM(tokens_uncached_input), 0) AS uncached_input,
         COALESCE(SUM(tokens_cached_input), 0) AS cached_input,
         COALESCE(SUM(CASE WHEN feature IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN tokens_uncached_input ELSE 0 END), 0) AS main_uncached_input,
         COALESCE(SUM(CASE WHEN feature IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN tokens_cached_input ELSE 0 END), 0) AS main_cached_input,
         COALESCE(SUM(CASE WHEN feature IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN 1 ELSE 0 END), 0) AS cache_reported_events,
         COALESCE(SUM(CASE WHEN feature NOT IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN tokens_uncached_input ELSE 0 END), 0) AS auxiliary_uncached_input,
         COALESCE(SUM(CASE WHEN feature NOT IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN tokens_cached_input ELSE 0 END), 0) AS auxiliary_cached_input,
         COALESCE(SUM(CASE WHEN feature NOT IN ('main', 'audit', 'assignment')
                            AND tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                           THEN 1 ELSE 0 END), 0) AS auxiliary_cache_reported_events,
         COALESCE(SUM(tokens_output), 0) AS output,
         COALESCE(SUM(tokens_reasoning), 0) AS reasoning,
         COALESCE(SUM(CASE WHEN feature IN ('main', 'audit', 'assignment') THEN 1 ELSE 0 END), 0) AS main_attempts,
         COALESCE(SUM(CASE WHEN feature NOT IN ('main', 'audit', 'assignment')
                            AND cost_status <> 'unavailable'
                           THEN cost_usd + COALESCE(tool_fee_usd, 0) ELSE 0 END), 0) AS auxiliary_cost,
         COALESCE(SUM(CASE WHEN cost_status = 'known' THEN cost_usd + COALESCE(tool_fee_usd, 0) ELSE 0 END), 0) AS known_cost,
         COALESCE(SUM(CASE WHEN cost_status = 'estimated' THEN cost_usd + COALESCE(tool_fee_usd, 0) ELSE 0 END), 0) AS estimated_cost,
         COALESCE(SUM(CASE WHEN cost_status = 'unavailable' THEN 1 ELSE 0 END), 0) AS unavailable_cost_events,
         COALESCE(SUM(CASE WHEN cost_status <> 'unavailable' THEN 1 ELSE 0 END), 0) AS priced_cost_events,
         COUNT(*) AS total_cost_events,
         COALESCE(SUM(CASE WHEN feature IN ('web', 'computer_use')
                           THEN COALESCE(tokens_uncached_input, 0) + COALESCE(tokens_output, 0)
                           ELSE 0 END), 0) AS tool_result_tokens
       FROM scoped`,
      range?.startAt ?? null,
      range?.startAt ?? null,
      range?.endAt ?? null,
      range?.endAt ?? null,
      threadId ?? null,
      threadId ?? null
    )
    const successfulTurns = row?.successful_turns ?? 0
    const uncachedInputTokens = row?.uncached_input ?? 0
    const cachedInputTokens = row?.cached_input ?? 0
    const mainUncachedInputTokens = row?.main_uncached_input ?? 0
    const mainCachedInputTokens = row?.main_cached_input ?? 0
    const cacheReportedEvents = row?.cache_reported_events ?? 0
    const auxiliaryUncachedInputTokens = row?.auxiliary_uncached_input ?? 0
    const auxiliaryCachedInputTokens = row?.auxiliary_cached_input ?? 0
    const outputTokens = row?.output ?? 0
    const reasoningTokens = row?.reasoning ?? 0
    const mainAttempts = row?.main_attempts ?? 0
    const knownCostUsd = row?.known_cost ?? 0
    const estimatedCostUsd = row?.estimated_cost ?? 0
    const totalPricedCostUsd = knownCostUsd + estimatedCostUsd
    const pricedCostEvents = row?.priced_cost_events ?? 0
    const totalCostEvents = row?.total_cost_events ?? 0
    const toolResultTokens = row?.tool_result_tokens ?? 0
    const cacheBreakdownRows = this.db.all<{
      harness_id: string | null
      provider_id: string | null
      model_id: string | null
      main_attempts: number
      reported_attempts: number
      uncached_input: number
      cached_input: number
    }>(
      `WITH successful_turns AS (
         SELECT DISTINCT thread_id, parent_turn_id
         FROM usage_events
         WHERE feature IN ('main', 'audit', 'assignment') AND success = 1
           AND (? IS NULL OR created_at >= ?)
           AND (? IS NULL OR created_at < ?)
           AND (? IS NULL OR thread_id = ?)
       ), scoped AS (
         SELECT event.*
         FROM usage_events event
         JOIN successful_turns turn
           ON turn.thread_id = event.thread_id AND turn.parent_turn_id = event.parent_turn_id
       )
       SELECT harness_id, provider_id, model_id,
              COUNT(*) AS main_attempts,
              SUM(CASE WHEN tokens_uncached_input IS NOT NULL AND tokens_cached_input IS NOT NULL
                       THEN 1 ELSE 0 END) AS reported_attempts,
              COALESCE(SUM(CASE WHEN tokens_uncached_input IS NOT NULL
                                  AND tokens_cached_input IS NOT NULL
                                THEN tokens_uncached_input ELSE 0 END), 0) AS uncached_input,
              COALESCE(SUM(CASE WHEN tokens_uncached_input IS NOT NULL
                                  AND tokens_cached_input IS NOT NULL
                                THEN tokens_cached_input ELSE 0 END), 0) AS cached_input
       FROM scoped
       WHERE feature IN ('main', 'audit', 'assignment')
       GROUP BY harness_id, provider_id, model_id
       ORDER BY main_attempts DESC, harness_id ASC, provider_id ASC, model_id ASC`,
      range?.startAt ?? null,
      range?.startAt ?? null,
      range?.endAt ?? null,
      range?.endAt ?? null,
      threadId ?? null,
      threadId ?? null
    )
    const cacheBreakdown: UsageCacheHitBreakdown[] = cacheBreakdownRows.map((entry) => ({
      harnessId: entry.harness_id,
      providerId: entry.provider_id,
      modelId: entry.model_id,
      mainAttempts: entry.main_attempts,
      reportedAttempts: entry.reported_attempts,
      uncachedInputTokens: entry.uncached_input,
      cachedInputTokens: entry.cached_input,
      cacheHitRatio:
        entry.uncached_input + entry.cached_input > 0
          ? entry.cached_input / (entry.uncached_input + entry.cached_input)
          : null
    }))
    return {
      successfulTurns,
      uncachedInputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      cacheHitRatio:
        mainUncachedInputTokens + mainCachedInputTokens > 0
          ? mainCachedInputTokens / (mainUncachedInputTokens + mainCachedInputTokens)
          : null,
      cacheEligibleEvents: mainAttempts,
      cacheReportedEvents,
      cacheCoverageRatio: mainAttempts > 0 ? cacheReportedEvents / mainAttempts : null,
      cacheBreakdown,
      auxiliaryUncachedInputTokens,
      auxiliaryCachedInputTokens,
      auxiliaryCacheHitRatio:
        (row?.auxiliary_cache_reported_events ?? 0) > 0 &&
        auxiliaryUncachedInputTokens + auxiliaryCachedInputTokens > 0
          ? auxiliaryCachedInputTokens / (auxiliaryUncachedInputTokens + auxiliaryCachedInputTokens)
          : null,
      mainAttempts,
      retryAmplification: successfulTurns > 0 ? mainAttempts / successfulTurns : null,
      auxiliaryCostUsd: row?.auxiliary_cost ?? 0,
      totalPricedCostUsd,
      auxiliaryCostShare:
        totalPricedCostUsd > 0 ? (row?.auxiliary_cost ?? 0) / totalPricedCostUsd : null,
      toolResultTokens,
      knownCostUsd,
      estimatedCostUsd,
      unavailableCostEvents: row?.unavailable_cost_events ?? 0,
      pricedCostEvents,
      totalCostEvents,
      costCoverageRatio: totalCostEvents > 0 ? pricedCostEvents / totalCostEvents : null,
      perSuccessfulTurn: {
        uncachedInputTokens: successfulTurns > 0 ? uncachedInputTokens / successfulTurns : null,
        outputAndReasoningTokens:
          successfulTurns > 0 ? (outputTokens + reasoningTokens) / successfulTurns : null,
        toolResultTokens: successfulTurns > 0 ? toolResultTokens / successfulTurns : null
      }
    }
  }

  /** Distinct harness ids used across a thread's session, newest activity first. */
  harnessIdsFor(threadId: string): string[] {
    const rows = this.db.all<{ harness_id: string }>(
      `SELECT harness_id FROM harness_usage
       WHERE thread_id = ?
       GROUP BY harness_id
       ORDER BY MAX(last_used_at) DESC`,
      threadId
    )
    return rows.map((row) => row.harness_id)
  }

  /** All cumulative usage rows for one thread, newest activity first. */
  listByThread(projectId: string, threadId: string): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageRow>(
      `SELECT * FROM harness_usage
       WHERE project_id = ? AND thread_id = ?
       ORDER BY last_used_at DESC`,
      projectId,
      threadId
    )
    const usages = rows.map(rowToHarnessUsage)
    const models = this.modelsFor(threadId)
    if (models.length > 0) {
      const byKey = new Map<string, HarnessModelUsage[]>()
      for (const model of models) {
        const key = `${model.harnessId}:${model.providerId}`
        const list = byKey.get(key)
        if (list) list.push(model)
        else byKey.set(key, [model])
      }
      for (const usage of usages) {
        const key = `${usage.harnessId}:${usage.providerId}`
        const modelList = byKey.get(key)
        if (modelList) usage.models = modelList
      }
    }
    return usages
  }

  /** Per-model cumulative usage rows for one thread, cost descending. */
  modelsFor(threadId: string): HarnessModelUsage[] {
    const rows = this.db.all<HarnessModelUsageRow>(
      `SELECT * FROM harness_usage_models
       WHERE thread_id = ?
       ORDER BY cost_usd DESC, last_used_at DESC`,
      threadId
    )
    return rows.map(rowToHarnessModelUsage)
  }

  /** Every cumulative usage row across all threads (for analytics/aggregation). */
  listAll(): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageRow>(
      'SELECT * FROM harness_usage ORDER BY last_used_at DESC'
    )
    return rows.map(rowToHarnessUsage)
  }

  /**
   * Top projects by runtime across the whole database, for the per-device
   * usage snapshot synced to the account profile.
   */
  async projectUsageSummary(): Promise<SyncedDeviceProject[]> {
    const rows = await this.aggregate<{
      project_id: string
      name: string
      message_count: number
      cost_usd: number
      tokens_total: number
      duration_ms: number
      thread_count: number
    }>(
      `SELECT h.project_id AS project_id,
              p.name AS name,
              SUM(h.message_count) AS message_count,
              SUM(h.cost_usd) AS cost_usd,
              SUM(h.tokens_total) AS tokens_total,
              SUM(h.duration_ms) AS duration_ms,
              COUNT(DISTINCT h.thread_id) AS thread_count
       FROM harness_usage h
       JOIN projects p ON p.id = h.project_id
       GROUP BY h.project_id, p.name
       ORDER BY SUM(h.duration_ms) DESC
       LIMIT 10`,
      []
    )
    return rows.map((row) => ({
      id: row.project_id,
      name: row.name,
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms,
      threadCount: row.thread_count
    }))
  }

  /** App-wide totals and ranked breakdowns for the signed-in profile. */
  async profileSummary(): Promise<AccountUsageSummary> {
    const [harnessRows, modelRows, activityRows] = await Promise.all([
      this.aggregate<UsageAggregateRow>(
        `SELECT harness_id AS id,
                SUM(message_count) AS message_count,
                SUM(cost_usd) AS cost_usd,
                SUM(tokens_total) AS tokens_total,
                SUM(duration_ms) AS duration_ms
         FROM harness_usage
         GROUP BY harness_id
         ORDER BY message_count DESC, MAX(last_used_at) DESC`,
        []
      ),
      this.aggregate<UsageAggregateRow>(
        `SELECT model_id AS id,
                SUM(message_count) AS message_count,
                SUM(cost_usd) AS cost_usd,
                SUM(tokens_total) AS tokens_total,
                SUM(duration_ms) AS duration_ms
         FROM harness_usage_models
         GROUP BY model_id
         ORDER BY message_count DESC, MAX(last_used_at) DESC`,
        []
      ),
      this.aggregate<{ date: string; message_count: number }>(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                COUNT(*) AS message_count
         FROM agent_messages
         WHERE role = 'assistant' AND harness_id IS NOT NULL
         GROUP BY date
         ORDER BY date ASC`,
        []
      )
    ])
    const toBreakdown = (row: UsageAggregateRow): AccountUsageBreakdown => ({
      id: row.id,
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total
    })
    const harnesses = harnessRows.map(toBreakdown)
    const models = modelRows.map(toBreakdown)
    const activity: AccountActivityDay[] = activityRows.map((row) => ({
      date: row.date,
      messageCount: row.message_count
    }))
    return {
      messageCount: harnessRows.reduce((sum, row) => sum + row.message_count, 0),
      costUsd: harnessRows.reduce((sum, row) => sum + row.cost_usd, 0),
      tokens: harnessRows.reduce((sum, row) => sum + row.tokens_total, 0),
      durationMs: harnessRows.reduce((sum, row) => sum + row.duration_ms, 0),
      topHarnessId: harnesses[0]?.id ?? null,
      topModelId: models[0]?.id ?? null,
      harnesses,
      models,
      activityDays: activity,
      generatedAt: Date.now()
    }
  }

  /** Range-aware local Profile analytics derived from persisted assistant messages. */
  async profileAnalytics(range: LocalProfileAnalyticsRange): Promise<LocalProfileAnalytics> {
    const aggregateSelect = `COUNT(*) AS message_count,
              SUM(COALESCE(cost, 0)) AS cost_usd,
              SUM(COALESCE(tokens_total, CAST(json_extract(tokens_json, '$.total') AS INTEGER), 0)) AS tokens_total,
              SUM(CASE
                    WHEN completed_at IS NOT NULL AND completed_at > created_at
                    THEN completed_at - created_at
                    ELSE 0
                  END) AS duration_ms`
    const messageRange = `role = 'assistant'
       AND harness_id IS NOT NULL
       AND created_at >= ?
       AND created_at < ?`
    const params = [range.startAt, range.endAt] as const

    const [harnessRows, providerRows, modelRows, projectRows, utilityRows, activityRows] =
      await Promise.all([
        this.aggregate<LocalUsageAggregateRow>(
          `SELECT harness_id AS id,
                  harness_id,
                  NULL AS provider_id,
                  ${aggregateSelect}
           FROM agent_messages
           WHERE ${messageRange}
           GROUP BY harness_id
           ORDER BY message_count DESC, MAX(created_at) DESC`,
          [...params]
        ),
        this.aggregate<LocalUsageAggregateRow>(
          `SELECT provider_id AS id,
                  NULL AS harness_id,
                  provider_id,
                  ${aggregateSelect}
           FROM agent_messages
           WHERE ${messageRange} AND provider_id IS NOT NULL
           GROUP BY provider_id
           ORDER BY message_count DESC, MAX(created_at) DESC`,
          [...params]
        ),
        this.aggregate<LocalUsageAggregateRow>(
          `SELECT model_id AS id,
                  harness_id,
                  provider_id,
                  thinking_level,
                  ${aggregateSelect}
           FROM agent_messages
           WHERE ${messageRange} AND model_id IS NOT NULL
           GROUP BY harness_id, provider_id, model_id, thinking_level
           ORDER BY message_count DESC, MAX(created_at) DESC`,
          [...params]
        ),
        this.aggregate<LocalProjectAggregateRow>(
          `SELECT p.id,
                  p.name,
                  p.color,
                  p.icon_type,
                  p.icon,
                  COUNT(*) AS message_count,
                  SUM(COALESCE(m.cost, 0)) AS cost_usd,
                  SUM(COALESCE(m.tokens_total, CAST(json_extract(m.tokens_json, '$.total') AS INTEGER), 0)) AS tokens_total,
                  SUM(CASE
                        WHEN m.completed_at IS NOT NULL AND m.completed_at > m.created_at
                        THEN m.completed_at - m.created_at
                        ELSE 0
                      END) AS duration_ms,
                  COUNT(DISTINCT t.id) AS thread_count,
                  COUNT(DISTINCT strftime('%Y-%m-%d', m.created_at / 1000, 'unixepoch', 'localtime')) AS active_days,
                  MAX(m.created_at) AS last_active_at
           FROM agent_messages m
           JOIN threads t ON t.id = m.thread_id
           JOIN projects p ON p.id = t.project_id
           WHERE m.role = 'assistant'
             AND m.harness_id IS NOT NULL
             AND m.created_at >= ?
             AND m.created_at < ?
           GROUP BY p.id
           ORDER BY message_count DESC, last_active_at DESC`,
          [...params]
        ),
        this.aggregate<LocalUsageAggregateRow>(
          `SELECT feature AS id,
                  NULL AS harness_id,
                  NULL AS provider_id,
                  COUNT(*) AS message_count,
                  SUM(COALESCE(cost_usd, 0)) AS cost_usd,
                  SUM(COALESCE(tokens_uncached_input, 0) + COALESCE(tokens_cached_input, 0)
                      + COALESCE(tokens_cache_write, 0) + COALESCE(tokens_output, 0)
                      + COALESCE(tokens_reasoning, 0)) AS tokens_total,
                  0 AS duration_ms
           FROM usage_events
           WHERE feature IN (${PROFILE_UTILITY_FEATURES.map(() => '?').join(',')})
             AND created_at >= ?
             AND created_at < ?
           GROUP BY feature
           ORDER BY message_count DESC, feature ASC`,
          [...PROFILE_UTILITY_FEATURES, ...params]
        ),
        this.aggregate<{ date: string; message_count: number }>(
          `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS message_count
           FROM agent_messages
           WHERE ${messageRange}
           GROUP BY date
           ORDER BY date ASC`,
          [...params]
        )
      ])
    const toUsageBreakdown = (row: LocalUsageAggregateRow): LocalProfileUsageBreakdown => ({
      id: row.id,
      ...(row.harness_id ? { harnessId: row.harness_id } : {}),
      ...(row.provider_id ? { providerId: row.provider_id } : {}),
      ...(row.thinking_level ? { thinkingLevel: row.thinking_level as ThinkingLevel } : {}),
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms
    })
    const harnesses = harnessRows.map(toUsageBreakdown)
    const providers = providerRows.map(toUsageBreakdown)
    const models = modelRows.map(toUsageBreakdown)
    const utilities = utilityRows.map(toUsageBreakdown)
    const harnessCost = harnessRows.reduce((sum, row) => sum + row.cost_usd, 0)
    const harnessTokens = harnessRows.reduce((sum, row) => sum + row.tokens_total, 0)
    const utilityCost = utilityRows.reduce((sum, row) => sum + row.cost_usd, 0)
    const utilityTokens = utilityRows.reduce((sum, row) => sum + row.tokens_total, 0)
    const projects: LocalProfileProjectBreakdown[] = projectRows.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.color ? { color: row.color } : {}),
      ...(row.icon_type ? { iconType: row.icon_type } : {}),
      hasCustomIcon: Boolean(row.icon),
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms,
      threadCount: row.thread_count,
      activeDays: row.active_days,
      lastActiveAt: row.last_active_at
    }))
    const activityDays: AccountActivityDay[] = activityRows.map((row) => ({
      date: row.date,
      messageCount: row.message_count
    }))
    return {
      range,
      messageCount: harnessRows.reduce((sum, row) => sum + row.message_count, 0),
      costUsd: harnessCost + utilityCost,
      tokens: harnessTokens + utilityTokens,
      durationMs: harnessRows.reduce((sum, row) => sum + row.duration_ms, 0),
      topHarnessId: harnesses[0]?.id ?? null,
      topProviderId: providers[0]?.id ?? null,
      topModelId: models[0]?.id ?? null,
      harnesses,
      providers,
      models,
      utilities,
      projects,
      activityDays,
      // Feedback scoring and its cost live in TurnFeedbackRepo; the IPC layer
      // overlays them.
      modelPerformance: [],
      feedbackCost: {
        outcomes: 0,
        pricedOutcomes: 0,
        costUsd: 0,
        knownCostUsd: 0,
        estimatedCostUsd: 0,
        tokensTotal: 0
      },
      generatedAt: Date.now()
    }
  }

  /**
   * Run an aggregate read on the maintenance worker connection so large
   * analytics scans never block the Electron main thread (primary-connection
   * fallback for in-memory test databases). Bounded far above any real result
   * set; the caller's SQL must not contain LIMIT.
   */
  private async aggregate<T>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.db.queryViaWorker(sql, params, ANALYTICS_MAX_ROWS)
    return result.rows as T[]
  }

  /**
   * Accumulate one completed turn into the snapshot table. Called at the end of
   * each agent turn (success or failure). Each assistant message is counted once
   * (guarded by the harness_usage_messages ledger), so cost/tokens/duration are
   * added to whatever the thread's harness row already holds — never double
   * counted across retries, compaction, or restart.
   *
   * The ledger is read once up front and every write is batched into a single
   * worker transaction (primary-connection fallback), so the accumulation never
   * blocks the Electron main thread and issues O(messages) statements in one
   * atomic batch instead of a per-message read + writes.
   */
  async accumulateTurn(
    projectId: string,
    threadId: string,
    messages: AgentMessage[]
  ): Promise<{ ok: boolean; error?: string }> {
    const counted = new Set(
      this.db
        .all<{ message_id: string }>(
          'SELECT message_id FROM harness_usage_messages WHERE thread_id = ?',
          threadId
        )
        .map((row) => row.message_id)
    )

    const statements: Array<{ sql: string; params: unknown[] }> = []
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const harnessId = message.harnessId
      if (!harnessId) continue
      if (counted.has(message.id)) continue

      const providerId = message.providerId ?? ''
      const modelId = message.modelId
      const thinkingLevel = message.thinkingLevel ?? null
      const cost = messageCost(message) ?? 0
      const tokens = message.tokens
      const createdAt = message.createdAt
      const completedAt = message.completedAt ?? createdAt
      const duration = completedAt > createdAt ? completedAt - createdAt : 0
      statements.push({
        sql: `INSERT INTO harness_usage(
          project_id, thread_id, harness_id, provider_id, model_id, thinking_level,
          message_count, cost_usd,
          tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
          duration_ms, first_used_at, last_used_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, thread_id, harness_id, provider_id) DO UPDATE SET
          model_id = COALESCE(excluded.model_id, harness_usage.model_id),
          thinking_level = COALESCE(excluded.thinking_level, harness_usage.thinking_level),
          message_count = harness_usage.message_count + excluded.message_count,
          cost_usd = harness_usage.cost_usd + excluded.cost_usd,
          tokens_in = harness_usage.tokens_in + excluded.tokens_in,
          tokens_out = harness_usage.tokens_out + excluded.tokens_out,
          tokens_reasoning = harness_usage.tokens_reasoning + excluded.tokens_reasoning,
          tokens_cache_read = harness_usage.tokens_cache_read + excluded.tokens_cache_read,
          tokens_cache_write = harness_usage.tokens_cache_write + excluded.tokens_cache_write,
          tokens_total = harness_usage.tokens_total + excluded.tokens_total,
          duration_ms = harness_usage.duration_ms + excluded.duration_ms,
          first_used_at = MIN(harness_usage.first_used_at, excluded.first_used_at),
          last_used_at = MAX(harness_usage.last_used_at, excluded.last_used_at)`,
        params: [
          projectId,
          threadId,
          harnessId,
          providerId,
          modelId ?? null,
          thinkingLevel,
          1,
          cost,
          tokens?.input ?? 0,
          tokens?.output ?? 0,
          tokens?.reasoning ?? 0,
          tokens?.cacheRead ?? 0,
          tokens?.cacheWrite ?? 0,
          tokens?.total ?? 0,
          duration,
          createdAt,
          completedAt
        ]
      })
      if (modelId) {
        statements.push({
          sql: `INSERT INTO harness_usage_models(
            thread_id, harness_id, provider_id, model_id, thinking_level,
            message_count, cost_usd,
            tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
            duration_ms, first_used_at, last_used_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id, harness_id, provider_id, model_id, thinking_level) DO UPDATE SET
            message_count = harness_usage_models.message_count + excluded.message_count,
            cost_usd = harness_usage_models.cost_usd + excluded.cost_usd,
            tokens_in = harness_usage_models.tokens_in + excluded.tokens_in,
            tokens_out = harness_usage_models.tokens_out + excluded.tokens_out,
            tokens_reasoning = harness_usage_models.tokens_reasoning + excluded.tokens_reasoning,
            tokens_cache_read = harness_usage_models.tokens_cache_read + excluded.tokens_cache_read,
            tokens_cache_write = harness_usage_models.tokens_cache_write + excluded.tokens_cache_write,
            tokens_total = harness_usage_models.tokens_total + excluded.tokens_total,
            duration_ms = harness_usage_models.duration_ms + excluded.duration_ms,
            first_used_at = MIN(harness_usage_models.first_used_at, excluded.first_used_at),
            last_used_at = MAX(harness_usage_models.last_used_at, excluded.last_used_at)`,
          params: [
            threadId,
            harnessId,
            providerId,
            modelId,
            thinkingLevel ?? '',
            1,
            cost,
            tokens?.input ?? 0,
            tokens?.output ?? 0,
            tokens?.reasoning ?? 0,
            tokens?.cacheRead ?? 0,
            tokens?.cacheWrite ?? 0,
            tokens?.total ?? 0,
            duration,
            createdAt,
            completedAt
          ]
        })
      }
      statements.push({
        sql: 'INSERT OR IGNORE INTO harness_usage_messages(thread_id, message_id) VALUES(?, ?)',
        params: [threadId, message.id]
      })
    }

    if (statements.length === 0) return { ok: true }
    return this.db.transactionViaWorker(statements)
  }

  deleteByThread(threadId: string): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM harness_usage WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM harness_usage_messages WHERE thread_id = ?', threadId)
      this.db.run('DELETE FROM harness_usage_models WHERE thread_id = ?', threadId)
    })
  }

  deleteByProject(projectId: string): void {
    this.db.run('DELETE FROM harness_usage WHERE project_id = ?', projectId)
  }
}
