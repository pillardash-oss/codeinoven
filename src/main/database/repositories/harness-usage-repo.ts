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
  UsageEvent
} from '../../../lib/types'

interface HarnessUsageRow {
  project_id: string
  thread_id: string
  harness_id: string
  provider_id: string
  model_id: string | null
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
        harness_id, provider_id, model_id, utility_id, raw_provider_usage_json,
        tokens_uncached_input, tokens_cached_input, tokens_cache_write,
        tokens_output, tokens_reasoning, raw_total, total_semantics,
        cost_usd, cost_status, pricing_provenance_json, tool_fee_usd,
        success, retry_cause, created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      event.id,
      event.threadId,
      event.parentTurnId,
      event.featureCallId,
      event.attempt,
      event.feature,
      event.harnessId,
      event.providerId,
      event.modelId,
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

  /** App-wide totals and ranked breakdowns for the signed-in profile. */
  profileSummary(): AccountUsageSummary {
    const harnessRows = this.db.all<UsageAggregateRow>(
      `SELECT harness_id AS id,
              SUM(message_count) AS message_count,
              SUM(cost_usd) AS cost_usd,
              SUM(tokens_total) AS tokens_total,
              SUM(duration_ms) AS duration_ms
       FROM harness_usage
       GROUP BY harness_id
       ORDER BY message_count DESC, MAX(last_used_at) DESC`
    )
    const modelRows = this.db.all<UsageAggregateRow>(
      `SELECT model_id AS id,
              SUM(message_count) AS message_count,
              SUM(cost_usd) AS cost_usd,
              SUM(tokens_total) AS tokens_total,
              SUM(duration_ms) AS duration_ms
       FROM harness_usage_models
       GROUP BY model_id
       ORDER BY message_count DESC, MAX(last_used_at) DESC`
    )
    const activityDays = this.db.all<{ date: string; message_count: number }>(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
              COUNT(*) AS message_count
       FROM agent_messages
       WHERE role = 'assistant' AND harness_id IS NOT NULL
       GROUP BY date
       ORDER BY date ASC`
    )
    const toBreakdown = (row: UsageAggregateRow): AccountUsageBreakdown => ({
      id: row.id,
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total
    })
    const harnesses = harnessRows.map(toBreakdown)
    const models = modelRows.map(toBreakdown)
    const activity: AccountActivityDay[] = activityDays.map((row) => ({
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
  profileAnalytics(range: LocalProfileAnalyticsRange): LocalProfileAnalytics {
    const aggregateSelect = `COUNT(*) AS message_count,
              SUM(COALESCE(cost, 0)) AS cost_usd,
              SUM(COALESCE(CAST(json_extract(tokens_json, '$.total') AS INTEGER), 0)) AS tokens_total,
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

    const harnessRows = this.db.all<LocalUsageAggregateRow>(
      `SELECT harness_id AS id,
              harness_id,
              NULL AS provider_id,
              ${aggregateSelect}
       FROM agent_messages
       WHERE ${messageRange}
       GROUP BY harness_id
       ORDER BY message_count DESC, MAX(created_at) DESC`,
      ...params
    )
    const providerRows = this.db.all<LocalUsageAggregateRow>(
      `SELECT provider_id AS id,
              NULL AS harness_id,
              provider_id,
              ${aggregateSelect}
       FROM agent_messages
       WHERE ${messageRange} AND provider_id IS NOT NULL
       GROUP BY provider_id
       ORDER BY message_count DESC, MAX(created_at) DESC`,
      ...params
    )
    const modelRows = this.db.all<LocalUsageAggregateRow>(
      `SELECT model_id AS id,
              harness_id,
              provider_id,
              ${aggregateSelect}
       FROM agent_messages
       WHERE ${messageRange} AND model_id IS NOT NULL
       GROUP BY harness_id, provider_id, model_id
       ORDER BY message_count DESC, MAX(created_at) DESC`,
      ...params
    )
    const projectRows = this.db.all<LocalProjectAggregateRow>(
      `SELECT p.id,
              p.name,
              p.color,
              p.icon_type,
              p.icon,
              COUNT(*) AS message_count,
              SUM(COALESCE(m.cost, 0)) AS cost_usd,
              SUM(COALESCE(CAST(json_extract(m.tokens_json, '$.total') AS INTEGER), 0)) AS tokens_total,
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
         AND p.hidden = 0
       GROUP BY p.id
       ORDER BY message_count DESC, last_active_at DESC`,
      ...params
    )
    const activityRows = this.db.all<{ date: string; message_count: number }>(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
              COUNT(*) AS message_count
       FROM agent_messages
       WHERE ${messageRange}
       GROUP BY date
       ORDER BY date ASC`,
      ...params
    )
    const toUsageBreakdown = (row: LocalUsageAggregateRow): LocalProfileUsageBreakdown => ({
      id: row.id,
      ...(row.harness_id ? { harnessId: row.harness_id } : {}),
      ...(row.provider_id ? { providerId: row.provider_id } : {}),
      messageCount: row.message_count,
      costUsd: row.cost_usd,
      tokens: row.tokens_total,
      durationMs: row.duration_ms
    })
    const harnesses = harnessRows.map(toUsageBreakdown)
    const providers = providerRows.map(toUsageBreakdown)
    const models = modelRows.map(toUsageBreakdown)
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
      costUsd: harnessRows.reduce((sum, row) => sum + row.cost_usd, 0),
      tokens: harnessRows.reduce((sum, row) => sum + row.tokens_total, 0),
      durationMs: harnessRows.reduce((sum, row) => sum + row.duration_ms, 0),
      topHarnessId: harnesses[0]?.id ?? null,
      topProviderId: providers[0]?.id ?? null,
      topModelId: models[0]?.id ?? null,
      harnesses,
      providers,
      models,
      projects,
      activityDays,
      generatedAt: Date.now()
    }
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
      const cost = messageCost(message) ?? 0
      const tokens = message.tokens
      const createdAt = message.createdAt
      const completedAt = message.completedAt ?? createdAt
      const duration = completedAt > createdAt ? completedAt - createdAt : 0

      statements.push({
        sql: `INSERT INTO harness_usage(
          project_id, thread_id, harness_id, provider_id, model_id,
          message_count, cost_usd,
          tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
          duration_ms, first_used_at, last_used_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(project_id, thread_id, harness_id, provider_id) DO UPDATE SET
          model_id = COALESCE(excluded.model_id, harness_usage.model_id),
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
            thread_id, harness_id, provider_id, model_id,
            message_count, cost_usd,
            tokens_in, tokens_out, tokens_reasoning, tokens_cache_read, tokens_cache_write, tokens_total,
            duration_ms, first_used_at, last_used_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(thread_id, harness_id, provider_id, model_id) DO UPDATE SET
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
