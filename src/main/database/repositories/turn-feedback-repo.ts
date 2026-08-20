import type { Database } from '../database'
import type {
  LocalProfileModelPerformance,
  ThinkingLevel,
  TurnOutcomeSignal,
  TurnOutcomeStatus,
  TurnOutcomeTaskType
} from '../../../lib/types'

/** One persisted turn-outcome row. */
export interface TurnFeedbackRow {
  id: string
  /** Null after the owning thread is deleted (ON DELETE SET NULL). */
  thread_id: string | null
  parent_turn_id: string
  session_id: string | null
  created_at: number
  resolved_at: number | null
  status: TurnOutcomeStatus
  signal: TurnOutcomeSignal | null
  score: number
  feature: TurnOutcomeTaskType | null
  task_slug: string | null
  harness_id: string | null
  provider_id: string | null
  model_id: string | null
  thinking_level: string | null
  cost_usd: number | null
  cost_status: 'known' | 'estimated' | 'unavailable' | null
  tokens_total: number | null
}

/** Identity, task metadata, and cost captured when a completed turn opens a session. */
export interface OpenTurnFeedbackInput {
  id: string
  threadId: string
  parentTurnId: string
  sessionId?: string
  createdAt: number
  feature: TurnOutcomeTaskType
  taskSlug: string | null
  harnessId: string
  providerId: string | null
  modelId: string | null
  thinkingLevel: ThinkingLevel | null
  /** USD cost of the scored turn, when the provider (or pricing) reported it. */
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
  /** Total reported tokens for the scored turn, when available. */
  tokensTotal: number | null
}

interface ModelPerformanceRow {
  harness_id: string | null
  provider_id: string | null
  model_id: string | null
  thinking_level: string | null
  feature: string | null
  outcomes: number
  successes: number
  corrected: number
  avg_score: number
  priced_outcomes: number
  cost_usd: number
  tokens_total: number
  last_used_at: number
}

interface FeedbackCostRow {
  outcomes: number
  priced_outcomes: number
  cost_usd: number
  known_cost_usd: number
  estimated_cost_usd: number
  tokens_total: number
}

/**
 * Durable session-outcome ledger for "best model by feedback". Turns open as
 * `pending` and are resolved exactly once — the `status='pending'` guard makes
 * every resolution idempotent regardless of signal ordering or restarts.
 */
export class TurnFeedbackRepo {
  constructor(private db: Database) {}

  /** Open a pending outcome for a completed turn. Replays are no-ops. */
  openPending(input: OpenTurnFeedbackInput): void {
    this.db.run(
      `INSERT OR IGNORE INTO turn_feedback(
        id, thread_id, parent_turn_id, session_id, created_at, resolved_at,
        status, signal, score, feature, task_slug,
        harness_id, provider_id, model_id, thinking_level,
        cost_usd, cost_status, tokens_total
      ) VALUES(?,?,?,?,?,NULL,'pending',NULL,0,?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.threadId,
      input.parentTurnId,
      input.sessionId ?? null,
      input.createdAt,
      input.feature,
      input.taskSlug,
      input.harnessId,
      input.providerId,
      input.modelId,
      input.thinkingLevel,
      input.costUsd,
      input.costStatus,
      input.tokensTotal
    )
  }

  /**
   * Open a pending outcome on the database worker so a completed turn's first
   * feedback record never synchronously touches SQLite on the main thread.
   * Replays remain no-ops (INSERT OR IGNORE). Falls back to the primary
   * connection when no worker is available.
   */
  async openPendingViaWorker(input: OpenTurnFeedbackInput): Promise<void> {
    const result = await this.db.executeViaWorker(
      `INSERT OR IGNORE INTO turn_feedback(
        id, thread_id, parent_turn_id, session_id, created_at, resolved_at,
        status, signal, score, feature, task_slug,
        harness_id, provider_id, model_id, thinking_level,
        cost_usd, cost_status, tokens_total
      ) VALUES(?,?,?,?,?,NULL,'pending',NULL,0,?,?,?,?,?,?,?,?,?)`,
      [
        input.id,
        input.threadId,
        input.parentTurnId,
        input.sessionId ?? null,
        input.createdAt,
        input.feature,
        input.taskSlug,
        input.harnessId,
        input.providerId,
        input.modelId,
        input.thinkingLevel,
        input.costUsd,
        input.costStatus,
        input.tokensTotal
      ]
    )
    if (!result.ok) {
      // The primary path is the offline-safe fallback and surfaces the error.
      this.openPending(input)
    }
  }

  /** Most recent pending outcome for a thread, or null. */
  latestPendingForThread(threadId: string): TurnFeedbackRow | null {
    const row = this.db.get<TurnFeedbackRow>(
      `SELECT * FROM turn_feedback
       WHERE thread_id = ? AND status = 'pending'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      threadId
    )
    return row ?? null
  }

  /** Resolve the newest pending outcome on a thread. Returns true when one was resolved. */
  resolveLatestPendingForThread(
    threadId: string,
    status: Exclude<TurnOutcomeStatus, 'pending'>,
    signal: TurnOutcomeSignal,
    score: number
  ): boolean {
    const latest = this.latestPendingForThread(threadId)
    if (!latest) return false
    this.db.run(
      `UPDATE turn_feedback SET status = ?, signal = ?, score = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      status,
      signal,
      score,
      Date.now(),
      latest.id
    )
    return true
  }

  /** Resolve every pending outcome on a thread (used at thread deletion/eviction). */
  resolvePendingForThread(
    threadId: string,
    status: Exclude<TurnOutcomeStatus, 'pending'>,
    signal: TurnOutcomeSignal,
    score: number
  ): void {
    this.db.run(
      `UPDATE turn_feedback SET status = ?, signal = ?, score = ?, resolved_at = ?
       WHERE thread_id = ? AND status = 'pending'`,
      status,
      signal,
      score,
      Date.now(),
      threadId
    )
  }

  /** Resolve pending outcomes on every thread except `exceptThreadId` (context switch away). */
  resolvePendingForOtherThreads(
    exceptThreadId: string,
    status: Exclude<TurnOutcomeStatus, 'pending'>,
    signal: TurnOutcomeSignal,
    score: number
  ): void {
    this.db.run(
      `UPDATE turn_feedback SET status = ?, signal = ?, score = ?, resolved_at = ?
       WHERE status = 'pending' AND thread_id <> ?`,
      status,
      signal,
      score,
      Date.now(),
      exceptThreadId
    )
  }

  /** Count of unresolved outcomes (debug/diagnostics). */
  pendingCount(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turn_feedback WHERE status = 'pending'"
    )
    return row?.count ?? 0
  }

  /** Range-scoped feedback performance per (harness, provider, model, thinking level, task). */
  modelPerformance(range: { startAt: number; endAt: number }): LocalProfileModelPerformance[] {
    const rows = this.db.all<ModelPerformanceRow>(
      `SELECT harness_id, provider_id, model_id, thinking_level, feature,
              COUNT(*) AS outcomes,
              SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) AS successes,
              SUM(CASE WHEN status = 'corrected' THEN 1 ELSE 0 END) AS corrected,
              AVG(score) AS avg_score,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN 1 ELSE 0 END) AS priced_outcomes,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN cost_usd ELSE 0 END) AS cost_usd,
              SUM(COALESCE(tokens_total, 0)) AS tokens_total,
              MAX(created_at) AS last_used_at
       FROM turn_feedback
       WHERE status <> 'pending'
         AND created_at >= ?
         AND created_at < ?
         AND harness_id IS NOT NULL
       GROUP BY harness_id, provider_id, model_id, thinking_level, feature
       ORDER BY (SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*)) DESC,
                MAX(created_at) DESC`,
      range.startAt,
      range.endAt
    )
    return rows
      .map((row): LocalProfileModelPerformance | null => {
        if (!row.model_id || !row.harness_id) return null
        const outcomes = row.outcomes
        return {
          harnessId: row.harness_id,
          providerId: row.provider_id ?? '',
          modelId: row.model_id,
          thinkingLevel: row.thinking_level ? (row.thinking_level as ThinkingLevel) : null,
          taskType: row.feature as TurnOutcomeTaskType,
          outcomes,
          successes: row.successes,
          corrected: row.corrected,
          successRate: outcomes > 0 ? row.successes / outcomes : null,
          averageScore: outcomes > 0 ? row.avg_score : 0,
          pricedOutcomes: row.priced_outcomes,
          costUsd: row.cost_usd,
          tokensTotal: row.tokens_total,
          lastUsedAt: row.last_used_at
        }
      })
      .filter((entry): entry is LocalProfileModelPerformance => entry !== null)
  }

  /** Range-scoped total of what the resolved feedback sessions cost to gather. */
  feedbackCost(range: { startAt: number; endAt: number }): {
    outcomes: number
    pricedOutcomes: number
    costUsd: number
    knownCostUsd: number
    estimatedCostUsd: number
    tokensTotal: number
  } {
    const row = this.db.get<FeedbackCostRow>(
      `SELECT COUNT(*) AS outcomes,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN 1 ELSE 0 END) AS priced_outcomes,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN cost_usd ELSE 0 END) AS cost_usd,
              SUM(CASE WHEN cost_status = 'known' AND cost_usd IS NOT NULL
                       THEN cost_usd ELSE 0 END) AS known_cost_usd,
              SUM(CASE WHEN cost_status = 'estimated' AND cost_usd IS NOT NULL
                       THEN cost_usd ELSE 0 END) AS estimated_cost_usd,
              SUM(COALESCE(tokens_total, 0)) AS tokens_total
       FROM turn_feedback
       WHERE status <> 'pending'
         AND created_at >= ?
         AND created_at < ?`,
      range.startAt,
      range.endAt
    )
    return {
      outcomes: row?.outcomes ?? 0,
      pricedOutcomes: row?.priced_outcomes ?? 0,
      costUsd: row?.cost_usd ?? 0,
      knownCostUsd: row?.known_cost_usd ?? 0,
      estimatedCostUsd: row?.estimated_cost_usd ?? 0,
      tokensTotal: row?.tokens_total ?? 0
    }
  }
}
