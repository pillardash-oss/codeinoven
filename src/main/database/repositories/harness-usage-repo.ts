import { RECONCILE_THREAD_CONTEXT_USAGE_SQL } from '../thread-context-usage-sql'
import { Logger } from '../../system/logger'
import { purgeRowsViaWorker, type RowsPurged } from '../worker-purge'
import {
  catalogCostForRun,
  needsCatalogPrice,
  reconcileRecordedCost,
  type UsageCostInput
} from '../../providers/usage-cost-reconcile'
import type { Database } from '../database'
import type {
  AccountActivityDay,
  AgentTokenUsage,
  HarnessModelUsage,
  HarnessUsage,
  LocalProfileAnalytics,
  LocalProfileAnalyticsRange,
  LocalProfileProjectBreakdown,
  LocalProfileUsageDay,
  LocalProfileUsageBreakdown,
  LocalProfileUsageHour,
  ThinkingLevel,
  UsageBearingMessage,
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

/** A `harness_usage` row joined with its ledger cost-status rollup. */
interface HarnessUsageWithCostStatusRow extends HarnessUsageRow {
  priced_cost_events: number
  unavailable_cost_events: number
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

interface LocalUsageDayRow extends UsageAggregateRow {
  date: string
}

interface LocalUsageHourRow extends UsageAggregateRow {
  hour: number
}

/**
 * Auxiliary utility features whose usage is recorded in `usage_events` but is
 * NOT already represented by an assistant `agent_messages` row (so adding them
 * to the profile totals never double-counts an agent turn). Web and
 * computer-use tool calls are excluded because their tokens ride inside the
 * parent agent turn.
 */
const PROFILE_UTILITY_FEATURES = ['image_descriptor', 'memory', 'title', 'search_nudge'] as const

/**
 * Features counted as model work in the profile, daily and hourly totals.
 * `subagent` and `ephemeral` belong here: both are real model calls with their
 * own recorded tokens, and neither is a subset of a parent turn's numbers (a
 * nested worker session and a disposable session are billed separately), so
 * counting them cannot double count anything.
 */
const PROFILE_MODEL_FEATURES = ['main', 'audit', 'assignment', 'subagent', 'ephemeral'] as const

/** Quoted feature list for the profile SQL fragments and the record purges. */
function featureSqlList(features: readonly string[]): string {
  return features.map((feature) => `'${feature}'`).join(',')
}

/** Upper bound for profile analytics result sets (worker bounded reads). */
const ANALYTICS_MAX_ROWS = 100_000

function rollingActivityRange(
  selectedRange: LocalProfileAnalyticsRange
): LocalProfileAnalyticsRange {
  const todayEnd = new Date()
  todayEnd.setHours(0, 0, 0, 0)
  todayEnd.setDate(todayEnd.getDate() + 1)
  const rollingStart = new Date(todayEnd)
  rollingStart.setDate(rollingStart.getDate() - 365)
  const end =
    selectedRange.endAt <= rollingStart.getTime() ? new Date(selectedRange.endAt) : todayEnd
  const start = new Date(end)
  start.setDate(start.getDate() - 365)
  return { startAt: start.getTime(), endAt: end.getTime() }
}

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

/**
 * Return one comparable token count for a persisted snapshot. A provider raw
 * total is authoritative. When it is absent, retain the sum of every reported
 * normalized category so the ledger does not silently discard valid usage;
 * `total_semantics` still records that this fallback was not provider-defined.
 */
function accountedTokenTotal(event: UsageEvent): number | null {
  if (event.tokensTotal !== undefined && event.tokensTotal !== null) return event.tokensTotal
  if (event.rawTotal !== null) return event.rawTotal
  const categories = [
    event.tokens.uncachedInput,
    event.tokens.cachedInput,
    event.tokens.cacheWrite,
    event.tokens.output,
    event.tokens.reasoning
  ]
  const reported = categories.filter((value): value is number => value !== null)
  return reported.length > 0 ? reported.reduce((sum, value) => sum + value, 0) : null
}

/** Integer column value, or null when the cell is not a finite integer. */
function rowInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** Nullable integer column value, preserving an unreported category as null. */
function rowToken(value: unknown): number | null {
  return rowInt(value)
}

/**
 * One ledger row as the inputs the cost reconciliation reads. Numeric columns
 * are re-typed from the worker's untyped row shape here, so no caller has to
 * narrow them again.
 */
function usageCostInputFromRow(row: Record<string, unknown>): UsageCostInput {
  const costStatus = row['cost_status']
  return {
    modelId: typeof row['model_id'] === 'string' ? row['model_id'] : null,
    providerId: typeof row['provider_id'] === 'string' ? row['provider_id'] : null,
    createdAt: rowInt(row['created_at']) ?? 0,
    costStatus:
      costStatus === 'known' || costStatus === 'estimated' || costStatus === 'unavailable'
        ? costStatus
        : 'unavailable',
    costUsd:
      rowInt(row['cost_usd']) ?? (typeof row['cost_usd'] === 'number' ? row['cost_usd'] : null),
    tokens: {
      uncachedInput: rowToken(row['tokens_uncached_input']),
      cachedInput: rowToken(row['tokens_cached_input']),
      cacheWrite: rowToken(row['tokens_cache_write']),
      output: rowToken(row['tokens_output']),
      reasoning: rowToken(row['tokens_reasoning'])
    }
  }
}

function rowToHarnessUsage(
  row: HarnessUsageRow,
  costStatus?: Pick<HarnessUsage, 'pricedCostEvents' | 'unavailableCostEvents'>
): HarnessUsage {
  return {
    projectId: row.project_id,
    threadId: row.thread_id,
    harnessId: row.harness_id,
    providerId: row.provider_id,
    ...(row.model_id ? { modelId: row.model_id } : {}),
    ...(row.thinking_level ? { thinkingLevel: row.thinking_level as ThinkingLevel } : {}),
    messageCount: row.message_count,
    costUsd: row.cost_usd,
    pricedCostEvents: costStatus?.pricedCostEvents ?? 0,
    unavailableCostEvents: costStatus?.unavailableCostEvents ?? 0,
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
function messageCost(message: UsageBearingMessage): number | null {
  let stepCost = 0
  let hasStepCost = false
  for (const part of message.parts ?? []) {
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

  /** Persist one immutable usage attempt. Replaying its stable identity is a no-op. */
  recordEvent(event: UsageEvent): void {
    try {
      const reconciled = reconcileRecordedCost(event)
      this.insertEvent(reconciled)
      this.reconcileContextCost(reconciled)
    } catch (error) {
      Logger.dev('Failed to record usage event; dropping telemetry', {
        feature: event.feature,
        parentTurnId: event.parentTurnId,
        error
      })
    }
  }

  /**
   * Replace one turn's ledger row in place.
   *
   * A user turn can finalize more than once (a resumed or continued turn, or a
   * driver that reports idle per response). Each finalization folds the turn's
   * responses into one aggregate row, so that row must be rewritten from the
   * newest aggregate instead of appended: appending would count the same
   * responses again. `(parent_turn_id, feature)` is what makes a turn's row
   * unique, and only turn-scoped features use this path.
   */
  recordReplacingEvent(event: UsageEvent): void {
    try {
      const reconciled = reconcileRecordedCost(event)
      this.db.transaction(() => {
        this.db.run(
          'DELETE FROM usage_events WHERE parent_turn_id = ? AND feature = ?',
          event.parentTurnId,
          event.feature
        )
        this.insertEvent(reconciled)
      })
      this.reconcileContextCost(reconciled)
    } catch (error) {
      Logger.dev('Failed to replace usage event; dropping telemetry', {
        feature: event.feature,
        parentTurnId: event.parentTurnId,
        error
      })
    }
  }

  private reconcileContextCost(event: UsageEvent): void {
    if (!['main', 'assignment', 'audit'].includes(event.feature)) return
    void this.db
      .executeViaWorker(RECONCILE_THREAD_CONTEXT_USAGE_SQL, [event.threadId])
      .then((result) => {
        if (!result.ok) Logger.error('Thread usage reconciliation failed:', result.error)
      })
      .catch((error: unknown) => Logger.error('Thread usage reconciliation failed:', error))
  }

  /** Insert one event row; the SQL body shared by the append and replace paths. */
  private insertEvent(event: UsageEvent): void {
    this.db.run(
      `INSERT OR IGNORE INTO usage_events(
          id, thread_id, parent_turn_id, project_id, project_name,
          feature_call_id, attempt, feature,
          harness_id, account_id, provider_id, model_id, thinking_level, utility_id, raw_provider_usage_json,
          tokens_uncached_input, tokens_cached_input, tokens_cache_write,
          tokens_output, tokens_reasoning, tokens_total, raw_total, total_semantics,
          cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
          success, retry_cause, duration_ms, created_at
        ) VALUES(
          ?,?,?,
          COALESCE(?, (SELECT project_id FROM threads WHERE id = ?)),
          COALESCE((SELECT name FROM projects WHERE id = ?), (SELECT projects.name FROM threads JOIN projects ON projects.id = threads.project_id WHERE threads.id = ?)),
          ?,?,?,
          ?,?,?,?,?,?,
          ?,
          ?,?,?,?,?,?,?,?,
          ?,?,?,?,
          ?,?,?,?
        )`,
      event.id,
      event.threadId,
      event.parentTurnId,
      event.projectId ?? null,
      event.threadId,
      event.projectId ?? null,
      event.threadId,
      event.featureCallId,
      event.attempt,
      event.feature,
      event.harnessId,
      event.accountId ?? null,
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
      accountedTokenTotal(event),
      event.rawTotal,
      event.totalSemantics,
      event.costUsd,
      event.costStatus,
      event.pricingProvenance === null ? null : JSON.stringify(event.pricingProvenance),
      event.toolFeeUsd,
      event.success ? 1 : 0,
      event.retryCause,
      Math.max(0, Math.floor(event.durationMs ?? 0)),
      event.createdAt
    )
  }

  /** Cost totals with explicit coverage; unavailable events never enter USD sums. */
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

  /**
   * Re-price ledger rows whose cost could not stand on its own when it was written.
   *
   * Rows are left unpriced for two reasons that are fixable later: the price
   * catalog had not loaded yet when the run was recorded (it is fetched in the
   * background, so an early run precedes it), or the provider answered with a
   * zeroed cost object for a model the catalog prices. Both leave tokens in the
   * ledger and no dollars, which is what makes the Usage page read as free.
   *
   * Runs after the catalog is available, bounded per batch, entirely on the
   * maintenance worker connection so the Electron main thread never scans or
   * writes the ledger. A row the catalog still cannot price keeps its recorded
   * status: the cursor advances past it, so a launch never re-derives it.
   */
  async repriceUnpricedEvents(
    options: { batchSize?: number; maxBatches?: number } = {}
  ): Promise<{ scanned: number; updated: number }> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 500))
    const maxBatches = Math.max(1, options.maxBatches ?? 50)
    let scanned = 0
    let updated = 0
    let cursor = 0
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const page = await this.db.queryViaWorker(
        `SELECT rowid AS row_id, id, model_id, provider_id,
                tokens_uncached_input, tokens_cached_input, tokens_cache_write,
                tokens_output, tokens_reasoning, created_at,
                cost_status, cost_usd
         FROM usage_events
         WHERE rowid > ?
           AND (cost_status = 'unavailable' OR (cost_status = 'known' AND cost_usd = 0))
         ORDER BY rowid
         LIMIT ?`,
        [cursor, batchSize],
        batchSize
      )
      if (!page.ok || page.rows.length === 0) break
      scanned += page.rows.length
      const statements: Array<{ sql: string; params: unknown[] }> = []
      for (const row of page.rows) {
        const rowId = rowInt(row['row_id'])
        if (rowId !== null && rowId > cursor) cursor = rowId
        const id = typeof row['id'] === 'string' ? row['id'] : ''
        if (!id) continue
        const candidate = usageCostInputFromRow(row)
        if (!needsCatalogPrice(candidate)) continue
        const correction = catalogCostForRun(candidate)
        if (!correction) continue
        statements.push({
          sql: `UPDATE usage_events
                SET cost_usd = ?, cost_status = 'estimated', pricing_provenance_json = ?
                WHERE id = ?`,
          params: [correction.costUsd, JSON.stringify(correction.pricingProvenance), id]
        })
      }
      if (statements.length > 0) {
        const write = await this.db.transactionViaWorker(statements)
        if (!write.ok) {
          Logger.error('Usage re-pricing batch failed:', write.error)
          break
        }
        updated += statements.length
      }
      if (page.rows.length < batchSize) break
    }
    return { scanned, updated }
  }

  /** Economically comparable metrics for completed successful user turns. */
  efficiencyKpis(range?: LocalProfileAnalyticsRange): Promise<UsageEfficiencyKpis> {
    return this.computeEfficiencyKpis(range)
  }

  /** Economically comparable metrics scoped to a single thread's completed turns. */
  efficiencyKpisForThread(threadId: string): Promise<UsageEfficiencyKpis> {
    return this.computeEfficiencyKpis(undefined, threadId)
  }

  /**
   * Both KPI queries run on the maintenance worker connection so their full
   * `usage_events` scans never block the Electron main thread (primary-
   * connection fallback for in-memory test databases).
   */
  private async computeEfficiencyKpis(
    range?: LocalProfileAnalyticsRange,
    threadId?: string
  ): Promise<UsageEfficiencyKpis> {
    const [row] = await this.aggregate<{
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
      [
        range?.startAt ?? null,
        range?.startAt ?? null,
        range?.endAt ?? null,
        range?.endAt ?? null,
        threadId ?? null,
        threadId ?? null
      ]
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
    const cacheBreakdownRows = await this.aggregate<{
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
      [
        range?.startAt ?? null,
        range?.startAt ?? null,
        range?.endAt ?? null,
        range?.endAt ?? null,
        threadId ?? null,
        threadId ?? null
      ]
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

  /**
   * All cumulative usage rows for one thread, newest activity first.
   *
   * The cost-status rollup rides along in the same statement as a grouped
   * `usage_events` subquery, so this stays a single synchronous read on the
   * thread's indexed ledger rows rather than a second main-thread scan. The
   * subquery groups by provider as well as harness so each row's share is
   * exact and the renderer's per-harness sum over provider rows stays correct.
   */
  listByThread(projectId: string, threadId: string): HarnessUsage[] {
    const rows = this.db.all<HarnessUsageWithCostStatusRow>(
      `SELECT hu.*,
              COALESCE(status.priced_cost_events, 0) AS priced_cost_events,
              COALESCE(status.unavailable_cost_events, 0) AS unavailable_cost_events
       FROM harness_usage hu
       LEFT JOIN (
         SELECT harness_id,
                COALESCE(provider_id, '') AS provider_id,
                SUM(CASE WHEN cost_status <> 'unavailable' THEN 1 ELSE 0 END) AS priced_cost_events,
                SUM(CASE WHEN cost_status = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_cost_events
         FROM usage_events
         WHERE thread_id = ?
         GROUP BY harness_id, COALESCE(provider_id, '')
       ) status
         ON status.harness_id = hu.harness_id AND status.provider_id = hu.provider_id
       WHERE hu.project_id = ? AND hu.thread_id = ?
       ORDER BY hu.last_used_at DESC`,
      threadId,
      projectId,
      threadId
    )
    const usages = rows.map((row) =>
      rowToHarnessUsage(row, {
        pricedCostEvents: row.priced_cost_events,
        unavailableCostEvents: row.unavailable_cost_events
      })
    )
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
    return rows.map((row) => rowToHarnessUsage(row))
  }

  /** Range-aware local Profile analytics derived only from usage snapshots. */
  async profileAnalytics(range: LocalProfileAnalyticsRange): Promise<LocalProfileAnalytics> {
    const activityRange = rollingActivityRange(range)
    const aggregateSelect = `COUNT(*) AS message_count,
              SUM(COALESCE(cost_usd, 0) + COALESCE(tool_fee_usd, 0)) AS cost_usd,
              SUM(COALESCE(tokens_total, 0)) AS tokens_total,
              SUM(duration_ms) AS duration_ms`
    const modelRange = `feature IN (${featureSqlList(PROFILE_MODEL_FEATURES)})
       AND usage_events.created_at >= ?
       AND usage_events.created_at < ?`
    const utilityPlaceholders = PROFILE_UTILITY_FEATURES.map(() => '?').join(',')
    const utilityRange = `feature IN (${utilityPlaceholders})
       AND usage_events.created_at >= ?
       AND usage_events.created_at < ?`
    const profileRange = `(feature IN (${featureSqlList(PROFILE_MODEL_FEATURES)}) OR feature IN (${utilityPlaceholders}))
       AND usage_events.created_at >= ?
       AND usage_events.created_at < ?`
    const params = [range.startAt, range.endAt] as const

    const [
      harnessRows,
      providerRows,
      modelRows,
      thinkingRows,
      projectRows,
      utilityRows,
      activityRows,
      dailyRows,
      hourlyRows
    ] = await Promise.all([
      this.aggregate<LocalUsageAggregateRow>(
        `SELECT harness_id AS id,
                  harness_id,
                  NULL AS provider_id,
                  NULL AS thinking_level,
                  ${aggregateSelect}
           FROM usage_events
           WHERE ${modelRange}
           GROUP BY harness_id
           ORDER BY message_count DESC, MAX(created_at) DESC`,
        [...params]
      ),
      this.aggregate<LocalUsageAggregateRow>(
        `SELECT provider_id AS id,
                  NULL AS harness_id,
                  provider_id,
                  NULL AS thinking_level,
                  ${aggregateSelect}
           FROM usage_events
           WHERE ${modelRange} AND provider_id IS NOT NULL
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
           FROM usage_events
           WHERE ${modelRange} AND model_id IS NOT NULL
           GROUP BY harness_id, provider_id, model_id, thinking_level
           ORDER BY message_count DESC, MAX(created_at) DESC`,
        [...params]
      ),
      this.aggregate<LocalUsageAggregateRow>(
        `SELECT thinking_level AS id,
                  NULL AS harness_id,
                  NULL AS provider_id,
                  thinking_level,
                  ${aggregateSelect}
           FROM usage_events
           WHERE ${modelRange} AND thinking_level IS NOT NULL
           GROUP BY thinking_level
           ORDER BY tokens_total DESC, MAX(created_at) DESC`,
        [...params]
      ),
      this.aggregate<LocalProjectAggregateRow>(
        `SELECT usage_events.project_id AS id,
                  COALESCE(p.name, MAX(usage_events.project_name), usage_events.project_id) AS name,
                  p.color,
                  p.icon_type,
                  p.icon,
                  ${aggregateSelect},
                  COUNT(DISTINCT usage_events.thread_id) AS thread_count,
                  COUNT(DISTINCT strftime('%Y-%m-%d', usage_events.created_at / 1000, 'unixepoch', 'localtime')) AS active_days,
                  MAX(usage_events.created_at) AS last_active_at
           FROM usage_events
           LEFT JOIN projects p ON p.id = usage_events.project_id
           WHERE ${modelRange} AND usage_events.project_id IS NOT NULL
           GROUP BY usage_events.project_id
           ORDER BY message_count DESC, last_active_at DESC`,
        [...params]
      ),
      this.aggregate<LocalUsageAggregateRow>(
        `SELECT feature AS id,
                  NULL AS harness_id,
                  NULL AS provider_id,
                  NULL AS thinking_level,
                  COUNT(*) AS message_count,
                  SUM(COALESCE(cost_usd, 0) + COALESCE(tool_fee_usd, 0)) AS cost_usd,
                  SUM(COALESCE(tokens_total, 0)) AS tokens_total,
                  SUM(duration_ms) AS duration_ms
           FROM usage_events
           WHERE ${utilityRange}
           GROUP BY feature
           ORDER BY message_count DESC, feature ASC`,
        [...PROFILE_UTILITY_FEATURES, ...params]
      ),
      this.aggregate<{ date: string; message_count: number }>(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS message_count
           FROM usage_events
           WHERE ${modelRange}
           GROUP BY date
           ORDER BY date ASC`,
        [activityRange.startAt, activityRange.endAt]
      ),
      this.aggregate<LocalUsageDayRow>(
        `SELECT date AS id,
                  date,
                  SUM(message_count) AS message_count,
                  SUM(cost_usd) AS cost_usd,
                  SUM(tokens_total) AS tokens_total,
                  SUM(duration_ms) AS duration_ms
           FROM (
             SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                    COUNT(*) AS message_count,
                    SUM(COALESCE(cost_usd, 0) + COALESCE(tool_fee_usd, 0)) AS cost_usd,
                    SUM(COALESCE(tokens_total, 0)) AS tokens_total,
                    SUM(duration_ms) AS duration_ms
             FROM usage_events
             WHERE ${profileRange}
             GROUP BY date
           )
           GROUP BY date
           ORDER BY date ASC`,
        [...PROFILE_UTILITY_FEATURES, ...params]
      ),
      this.aggregate<LocalUsageHourRow>(
        `SELECT CAST(hour_key AS INTEGER) AS id,
                  CAST(hour_key AS INTEGER) AS hour,
                  SUM(message_count) AS message_count,
                  SUM(cost_usd) AS cost_usd,
                  SUM(tokens_total) AS tokens_total,
                  SUM(duration_ms) AS duration_ms
           FROM (
             SELECT strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS hour_key,
                    COUNT(*) AS message_count,
                    SUM(COALESCE(cost_usd, 0) + COALESCE(tool_fee_usd, 0)) AS cost_usd,
                    SUM(COALESCE(tokens_total, 0)) AS tokens_total,
                    SUM(duration_ms) AS duration_ms
             FROM usage_events
             WHERE ${profileRange}
             GROUP BY hour_key
           )
           GROUP BY hour_key
           ORDER BY hour ASC`,
        [...PROFILE_UTILITY_FEATURES, ...params]
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
    const thinkingLevels = thinkingRows.map(toUsageBreakdown)
    const utilities = utilityRows.map(toUsageBreakdown)
    const harnessCost = harnessRows.reduce((sum, row) => sum + row.cost_usd, 0)
    const harnessTokens = harnessRows.reduce((sum, row) => sum + row.tokens_total, 0)
    const utilityCost = utilityRows.reduce((sum, row) => sum + row.cost_usd, 0)
    const utilityTokens = utilityRows.reduce((sum, row) => sum + row.tokens_total, 0)
    const utilityMessageCount = utilityRows.reduce((sum, row) => sum + row.message_count, 0)
    const agentResponses = harnessRows.reduce((sum, row) => sum + row.message_count, 0)
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
    const dailyUsage: LocalProfileUsageDay[] = dailyRows.map((row) => ({
      id: row.date,
      date: row.date,
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms
    }))
    const hourlyUsage: LocalProfileUsageHour[] = hourlyRows.map((row) => ({
      id: String(row.hour),
      hour: row.hour,
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms
    }))
    return {
      range,
      activityRange,
      messageCount: agentResponses,
      responseDurationMs: harnessRows.reduce((sum, row) => sum + row.duration_ms, 0),
      costUsd: harnessCost + utilityCost,
      tokens: harnessTokens + utilityTokens,
      durationMs:
        harnessRows.reduce((sum, row) => sum + row.duration_ms, 0) +
        utilityRows.reduce((sum, row) => sum + row.duration_ms, 0),
      topHarnessId: harnesses[0]?.id ?? null,
      topProviderId: providers[0]?.id ?? null,
      topModelId: models[0]?.id ?? null,
      harnesses,
      providers,
      models,
      thinkingLevels,
      utilities,
      projects,
      activityDays,
      dailyUsage,
      hourlyUsage,
      // Model ranking aggregates and grading spend live in ModelRankingRepo;
      // the IPC layer overlays them.
      modelRankings: [],
      gradingSpend: {
        costUsd: 0
      },
      records: {
        agentResponses,
        utilities: utilityMessageCount,
        // The ranking store is overlaid by the IPC layer with the same repo it
        // reads the aggregates from, so the counts and the rows always agree.
        modelRankings: 0,
        pendingGrades: 0
      },
      generatedAt: Date.now()
    }
  }

  /**
   * Delete one Usage page ledger store's rows inside a calendar range.
   *
   * Batched on the maintenance worker connection, so a clean slate over tens of
   * thousands of rows never blocks the Electron main thread. Only `usage_events`
   * is touched: the per-thread `harness_usage` snapshots are derived from
   * `agent_messages` and would be rebuilt by the next reconcile, so deleting
   * them would only desynchronize the two ledgers.
   */
  async clearLedgerRecords(
    store: 'agentResponses' | 'utilities',
    range: LocalProfileAnalyticsRange
  ): Promise<RowsPurged> {
    const features = store === 'utilities' ? PROFILE_UTILITY_FEATURES : PROFILE_MODEL_FEATURES
    return purgeRowsViaWorker(
      this.db,
      'usage_events',
      `created_at >= ? AND created_at < ? AND feature IN (${featureSqlList(features)})`,
      [range.startAt, range.endAt]
    )
  }

  /**
   * Run an aggregate read on the maintenance worker connection so large
   * analytics scans never block the Electron main thread (primary-connection
   * fallback for in-memory test databases). Bounded far above any real result
   * set; any caller-owned LIMIT remains valid inside the worker's outer bound.
   */
  private async aggregate<T>(sql: string, params: unknown[]): Promise<T[]> {
    const result = await this.db.queryViaWorker(sql, params, ANALYTICS_MAX_ROWS)
    return result.rows as T[]
  }

  /**
   * Accumulate one completed turn into the snapshot table. Called at the end of
   * each agent turn (success or failure). Each assistant message is counted once
   * (guarded by the harness_usage_messages ledger), so cost/tokens/duration are
   * added to whatever the thread's harness row already holds   never double
   * counted across retries, compaction, or restart.
   *
   * Only candidate ids from this turn are checked against the ledger, on the
   * worker connection, and every write is batched into one transaction. Work is
   * therefore bounded by the current turn rather than the thread's lifetime.
   */
  async accumulateTurn(
    projectId: string,
    threadId: string,
    messages: readonly UsageBearingMessage[]
  ): Promise<{ ok: boolean; error?: string }> {
    const candidateIds = [
      ...new Set(
        messages
          .filter((message) => message.role === 'assistant' && Boolean(message.harnessId))
          .map((message) => message.id)
      )
    ]
    if (candidateIds.length === 0) return { ok: true }

    const counted = new Set<string>()
    const LEDGER_QUERY_CHUNK_SIZE = 400
    for (let index = 0; index < candidateIds.length; index += LEDGER_QUERY_CHUNK_SIZE) {
      const chunk = candidateIds.slice(index, index + LEDGER_QUERY_CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      const result = await this.db.queryViaWorker(
        `SELECT message_id FROM harness_usage_messages
         WHERE thread_id = ? AND message_id IN (${placeholders})`,
        [threadId, ...chunk],
        chunk.length
      )
      if (!result.ok) return { ok: false, error: result.error }
      for (const row of result.rows) {
        if (typeof row['message_id'] === 'string') counted.add(row['message_id'])
      }
    }

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
