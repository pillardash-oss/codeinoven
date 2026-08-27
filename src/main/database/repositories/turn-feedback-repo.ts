import type { Database } from '../database'
import type {
  LocalProfileModelPerformance,
  ThinkingLevel,
  TurnOutcomeBasis,
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
  basis: TurnOutcomeBasis | null
  grade: number | null
  feature: TurnOutcomeTaskType | null
  task_slug: string | null
  harness_id: string | null
  provider_id: string | null
  model_id: string | null
  thinking_level: string | null
  cost_usd: number | null
  cost_status: 'known' | 'estimated' | 'unavailable' | null
  tokens_total: number | null
  user_message_text: string
  assistant_output_text: string
  follow_up_text: string | null
  reading_deadline_ms: number | null
  draft_deadline_ms: number | null
}

/** Identity, task metadata, captured grading payload, and cost for a completed turn. */
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
  /** The initiating visible user message text (grading payload). */
  userMessageText: string
  /** The agent's final output text for the turn (grading payload). */
  assistantOutputText: string
}

interface ModelPerformanceRow {
  harness_id: string | null
  provider_id: string | null
  model_id: string | null
  thinking_level: string | null
  feature: string | null
  outcomes: number
  avg_grade: number | null
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
 * Durable ledger for "best model by feedback". A completed turn captures its
 * grading payload as `pending`; a cheap-model LLM judge later grades it 1–5
 * exactly once — the `status='pending'` guard makes every grading idempotent
 * regardless of deadline ordering or restarts. Deadline anchors are persisted
 * so timers survive restarts.
 */
export class TurnFeedbackRepo {
  constructor(private db: Database) {}

  /** Open a pending outcome with its captured payload. Replays are no-ops. */
  openPending(input: OpenTurnFeedbackInput): void {
    this.db.run(
      `INSERT OR IGNORE INTO turn_feedback(
        id, thread_id, parent_turn_id, session_id, created_at,
        status, basis, grade, feature, task_slug,
        harness_id, provider_id, model_id, thinking_level,
        cost_usd, cost_status, tokens_total,
        user_message_text, assistant_output_text
      ) VALUES(?,?,?,?,?,'pending',NULL,NULL,?,?,?,?,?,?,?,?,?,?,?)`,
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
      input.tokensTotal,
      input.userMessageText,
      input.assistantOutputText
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
        id, thread_id, parent_turn_id, session_id, created_at,
        status, basis, grade, feature, task_slug,
        harness_id, provider_id, model_id, thinking_level,
        cost_usd, cost_status, tokens_total,
        user_message_text, assistant_output_text
      ) VALUES(?,?,?,?,?,'pending',NULL,NULL,?,?,?,?,?,?,?,?,?,?,?)`,
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
        input.tokensTotal,
        input.userMessageText,
        input.assistantOutputText
      ]
    )
    if (!result.ok) {
      // The primary path is the offline-safe fallback and surfaces the error.
      this.openPending(input)
    }
  }

  /** Newest pending outcome for a thread, or null. */
  latestPendingForThread(threadId: string): TurnFeedbackRow | null {
    const row = this.db.get<TurnFeedbackRow>(
      `SELECT * FROM turn_feedback
       WHERE thread_id = ? AND status = 'pending'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      threadId
    )
    return row ?? null
  }

  /** Every pending outcome for a thread, oldest first. */
  listPendingForThread(threadId: string): TurnFeedbackRow[] {
    return this.db.all<TurnFeedbackRow>(
      `SELECT * FROM turn_feedback
       WHERE thread_id = ? AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
      threadId
    )
  }

  /**
   * Store the follow-up message the user sent while an outcome was pending so
   * the judge can weigh it alongside the original exchange.
   */
  noteFollowUp(threadId: string, text: string): void {
    const latest = this.latestPendingForThread(threadId)
    if (!latest) return
    this.db.run('UPDATE turn_feedback SET follow_up_text = ? WHERE id = ?', text, latest.id)
  }

  /** Persist the post-read countdown anchor on every still-pending row of a thread. */
  scheduleReading(threadId: string, deadlineMs: number): void {
    this.db.run(
      `UPDATE turn_feedback SET reading_deadline_ms = ?
       WHERE thread_id = ? AND status = 'pending' AND reading_deadline_ms IS NULL`,
      deadlineMs,
      threadId
    )
  }

  /**
   * Persist the draft countdown anchor on every still-pending row of a thread.
   * The first draft entry wins: re-entering drafting never extends the window.
   */
  scheduleDraft(threadId: string, deadlineMs: number): void {
    this.db.run(
      `UPDATE turn_feedback SET draft_deadline_ms = ?
       WHERE thread_id = ? AND status = 'pending' AND draft_deadline_ms IS NULL`,
      deadlineMs,
      threadId
    )
  }

  /** Pending rows whose persisted deadline has elapsed (crash-recovery scan). */
  listDuePending(nowMs: number): TurnFeedbackRow[] {
    return this.db.all<TurnFeedbackRow>(
      `SELECT * FROM turn_feedback
       WHERE status = 'pending'
         AND (reading_deadline_ms IS NOT NULL AND reading_deadline_ms <= ?
           OR draft_deadline_ms IS NOT NULL AND draft_deadline_ms <= ?)
       ORDER BY COALESCE(reading_deadline_ms, draft_deadline_ms) ASC`,
      nowMs,
      nowMs
    )
  }

  /** Crash-recovery scan joined with the owning project so grading can re-resolve drivers. */
  listDuePendingWithProject(nowMs: number): Array<TurnFeedbackRow & { project_id: string }> {
    return this.db.all<TurnFeedbackRow & { project_id: string }>(
      `SELECT tf.*, t.project_id AS project_id
       FROM turn_feedback tf
       JOIN threads t ON t.id = tf.thread_id
       WHERE tf.status = 'pending'
         AND (tf.reading_deadline_ms IS NOT NULL AND tf.reading_deadline_ms <= ?
           OR tf.draft_deadline_ms IS NOT NULL AND tf.draft_deadline_ms <= ?)
       ORDER BY COALESCE(tf.reading_deadline_ms, tf.draft_deadline_ms) ASC`,
      nowMs,
      nowMs
    )
  }

  /**
   * Grade one pending outcome exactly once. A null grade records that the
   * judge could not produce a usable verdict (kept for cost accounting; the
   * analytics aggregate ignores it). Returns true when this call did the
   * grading; false when the row was already graded or missing.
   */
  grade(id: string, basis: TurnOutcomeBasis, grade: number | null): boolean {
    const current = this.db.get<{ status: string }>(
      'SELECT status FROM turn_feedback WHERE id = ?',
      id
    )
    if (!current || current.status !== 'pending') return false
    this.db.run(
      `UPDATE turn_feedback SET status = 'graded', basis = ?, grade = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      basis,
      grade,
      Date.now(),
      id
    )
    return true
  }

  /**
   * Detach a thread's pending rows from timers ahead of deletion. Deletion
   * itself only SET NULLs the thread reference; these rows stay pending until
   * the grader drains them, keeping their captured payloads intact.
   */
  clearTimersForThread(threadId: string): void {
    this.db.run(
      `UPDATE turn_feedback SET reading_deadline_ms = NULL, draft_deadline_ms = NULL
       WHERE thread_id = ? AND status = 'pending'`,
      threadId
    )
  }

  /** Count of unresolved outcomes (debug/diagnostics). */
  pendingCount(): number {
    const row = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM turn_feedback WHERE status = 'pending'"
    )
    return row?.count ?? 0
  }

  /** Range-scoped LLM-judge performance per (harness, provider, model, thinking level, task). */
  modelPerformance(range: { startAt: number; endAt: number }): LocalProfileModelPerformance[] {
    const rows = this.db.all<ModelPerformanceRow>(
      `SELECT harness_id, provider_id, model_id, thinking_level, feature,
              COUNT(*) AS outcomes,
              AVG(grade) AS avg_grade,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN 1 ELSE 0 END) AS priced_outcomes,
              SUM(CASE WHEN cost_status <> 'unavailable' AND cost_usd IS NOT NULL
                       THEN cost_usd ELSE 0 END) AS cost_usd,
              SUM(COALESCE(tokens_total, 0)) AS tokens_total,
              MAX(created_at) AS last_used_at
       FROM turn_feedback
       WHERE status = 'graded'
         AND created_at >= ?
         AND created_at < ?
         AND harness_id IS NOT NULL
       GROUP BY harness_id, provider_id, model_id, thinking_level, feature
       ORDER BY AVG(grade) DESC, MAX(created_at) DESC`,
      range.startAt,
      range.endAt
    )
    return rows
      .map((row): LocalProfileModelPerformance | null => {
        if (!row.model_id || !row.harness_id) return null
        const outcomes = row.outcomes
        const averageGrade = row.avg_grade !== null ? row.avg_grade : null
        return {
          harnessId: row.harness_id,
          providerId: row.provider_id ?? '',
          modelId: row.model_id,
          thinkingLevel: row.thinking_level ? (row.thinking_level as ThinkingLevel) : null,
          taskType: row.feature as TurnOutcomeTaskType,
          outcomes,
          averageGrade,
          successRate: averageGrade !== null ? averageGrade / 5 : null,
          pricedOutcomes: row.priced_outcomes,
          costUsd: row.cost_usd,
          tokensTotal: row.tokens_total,
          lastUsedAt: row.last_used_at
        }
      })
      .filter((entry): entry is LocalProfileModelPerformance => entry !== null)
  }

  /** Range-scoped total of what the graded feedback sessions cost to gather. */
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
       WHERE status = 'graded'
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
