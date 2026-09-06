import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import type { Database } from '../database'
import type {
  ModelRankingSnapshotRow,
  RankingShotCategory
} from '../../../lib/types'

/** Input for one newly captured conversation-window snapshot. */
export interface OpenRankingSnapshotInput {
  threadId: string
  projectId: string
  shotCategory: RankingShotCategory
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel: string
  /** First user message creation time of the window. */
  startedAt: number
  /** Last assistant response completion time of the window. */
  endedAt: number
  /** Inactivity deadline that closes the window for grading. */
  dueAtMs: number
  userMessageText: string
  assistantOutputText: string
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
}

/**
 * Transient grading queue for model-ranking conversations. Snapshots are
 * captured while a conversation window is open, closed for grading by thread
 * deletion or the inactivity deadline, claimed in bounded batches by the
 * drain, and hard-deleted the moment their score lands in the aggregate —
 * never deleted unscored. Judge failures retry with bounded backoff up to the
 * documented attempt cap and remain `status='failed'` for recovery.
 */
export class ModelRankingSnapshotRepo {
  constructor(private db: Database) {}

  /**
   * Capture one open conversation window. Replays (same id) are no-ops.
   * Resolves once the row is durably persisted (worker write, primary
   * fallback), so callers can arm the drain timer against a settled queue.
   */
  async insertViaWorker(input: OpenRankingSnapshotInput): Promise<void> {
    await this.insertViaWorkerAsync(input)
  }

  private async insertViaWorkerAsync(input: OpenRankingSnapshotInput): Promise<void> {
    const result = await this.db.executeViaWorker(
      `INSERT OR IGNORE INTO model_ranking_snapshots(
         id, thread_id, project_id, shot_category, status,
         harness_id, provider_id, model_id, thinking_level,
         started_at, ended_at, closed_at_ms, due_at_ms,
         user_message_text, assistant_output_text, follow_up_text,
         cost_usd, cost_status, attempt_count, last_attempt_at_ms, created_at
       ) VALUES(?,?,?,?, 'pending', ?,?,?,?,?,?, NULL, ?, ?, ?, NULL, ?, ?, 0, NULL, ?)`,
      [
        snapshotId(input),
        input.threadId,
        input.projectId,
        input.shotCategory,
        input.harnessId,
        input.providerId,
        input.modelId,
        input.thinkingLevel,
        input.startedAt,
        input.endedAt,
        input.dueAtMs,
        input.userMessageText,
        input.assistantOutputText,
        input.costUsd,
        input.costStatus,
        Date.now()
      ]
    )
    if (!result.ok) {
      Logger.dev('Ranking snapshot insert failed on both worker and primary:', result.error)
    }
  }

  /** Synchronous fallback capture used when the database worker is unavailable. */
  insert(input: OpenRankingSnapshotInput): void {
    this.db.run(
      `INSERT OR IGNORE INTO model_ranking_snapshots(
         id, thread_id, project_id, shot_category, status,
         harness_id, provider_id, model_id, thinking_level,
         started_at, ended_at, closed_at_ms, due_at_ms,
         user_message_text, assistant_output_text, follow_up_text,
         cost_usd, cost_status, attempt_count, last_attempt_at_ms, created_at
       ) VALUES(?,?,?,?, 'pending', ?,?,?,?,?,?, NULL, ?, ?, ?, NULL, ?, ?, 0, NULL, ?)`,
      snapshotId(input),
      input.threadId,
      input.projectId,
      input.shotCategory,
      input.harnessId,
      input.providerId,
      input.modelId,
      input.thinkingLevel,
      input.startedAt,
      input.endedAt,
      input.dueAtMs,
      input.userMessageText,
      input.assistantOutputText,
      input.costUsd,
      input.costStatus,
      Date.now()
    )
  }

  /** The still-open snapshot for a thread (accepting further exchanges), or null. */
  openForThread(threadId: string): ModelRankingSnapshotRow | null {
    const row = this.db.get<ModelRankingSnapshotRow>(
      `SELECT * FROM model_ranking_snapshots
       WHERE thread_id = ? AND closed_at_ms IS NULL
         AND status IN ('pending','processing')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      threadId
    )
    return row ?? null
  }

  /**
   * A completed later exchange on the still-open conversation window: upgrade
   * the classification to multi_shot, append the follow-up prompt as judge
   * context, and slide the inactivity deadline. The window stays open — a
   * conversation is graded exactly once, at close. A plain update, never a
   * failure marker.
   *
   * If the drain had already claimed the row ('processing', inactivity
   * deadline elapsed mid-conversation), the row is reset to 'pending' and its
   * claim token cleared, so the in-flight judge result is discarded (its
   * delete guard no longer matches) and the conversation is graded later with
   * the full follow-up context.
   */
  registerCompletedExchange(id: string, followUpText: string, endedAt: number, nextDueAtMs: number): void {
    this.db.run(
      `UPDATE model_ranking_snapshots
       SET shot_category = 'multi_shot',
           follow_up_text = substr(
             CASE WHEN follow_up_text IS NULL OR follow_up_text = ''
                  THEN ? ELSE follow_up_text || char(10) || char(10) || ? END,
             -12000),
           ended_at = ?,
           due_at_ms = ?,
           status = 'pending',
           claim_token = NULL
       WHERE id = ? AND closed_at_ms IS NULL AND status IN ('pending','processing')`,
      followUpText,
      followUpText,
      endedAt,
      nextDueAtMs,
      id
    )
  }

  /** Close every open snapshot of the given threads for immediate grading. */
  closeForThreads(threadIds: string[], nowMs: number): void {
    if (threadIds.length === 0) return
    const placeholders = threadIds.map(() => '?').join(', ')
    this.db.run(
      `UPDATE model_ranking_snapshots
       SET closed_at_ms = ?, due_at_ms = ?
       WHERE closed_at_ms IS NULL AND status = 'pending' AND thread_id IN (${placeholders})`,
      nowMs,
      nowMs,
      ...threadIds
    )
  }

  /**
   * Atomically claim up to `limit` due pending snapshots: the SELECT picks the
   * oldest due rows and the outer UPDATE flips them to 'processing' in the
   * same statement, so overlapping drains can never claim the same row twice.
   * Every claim carries a unique generation token; score, delete, and defer
   * operations are guarded by it, so a stale judge result from a previous
   * claim generation can never apply to a re-claimed row.
   */
  claimDueBatch(nowMs: number, limit = 3): ModelRankingSnapshotRow[] {
    const claimToken = randomUUID()
    return this.db.all<ModelRankingSnapshotRow>(
      `UPDATE model_ranking_snapshots
       SET status = 'processing', claim_token = ?
       WHERE id IN (
         SELECT id FROM model_ranking_snapshots
         WHERE status = 'pending' AND due_at_ms <= ?
         ORDER BY due_at_ms ASC, created_at ASC, id ASC
         LIMIT ?
       )
       RETURNING *`,
      claimToken,
      nowMs,
      limit
    )
  }

  /**
   * Apply the score to the aggregate and hard-delete the snapshot in one
   * transaction, so a crash between the two can never double-count. Returns
   * false when the row vanished, was not in the claimed state, or was
   * re-claimed by a later drain generation (stale judge result discarded).
   */
  deleteScoredInTransaction(id: string, claimToken: string, applyScore: () => void): boolean {
    return this.db.transaction<boolean>(() => {
      const claimed = this.db.get<{ id: string }>(
        `SELECT id FROM model_ranking_snapshots
         WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        id,
        claimToken
      )
      if (!claimed) return false
      this.db.run(
        'DELETE FROM model_ranking_snapshots WHERE id = ? AND status = ' + "'processing' AND claim_token = ?",
        id,
        claimToken
      )
      applyScore()
      return true
    })
  }

  /**
   * Judge failure bookkeeping. Under the attempt cap the row returns to
   * 'pending' with bounded exponential backoff; at the cap it parks as
   * 'failed' with its attempt count preserved for recovery — never deleted
   * unscored, never counted in the aggregate. Token-guarded: only the current
   * claim generation can defer or park the row.
   */
  deferOrPark(
    id: string,
    claimToken: string,
    attemptCap: number,
    retryBaseMs: number,
    nowMs: number
  ): void {
    const row = this.db.get<{ attempt_count: number }>(
      "SELECT attempt_count FROM model_ranking_snapshots WHERE id = ? AND status = 'processing' AND claim_token = ?",
      id,
      claimToken
    )
    if (!row) return
    const nextAttempt = row.attempt_count + 1
    if (nextAttempt >= attemptCap) {
      this.db.run(
        `UPDATE model_ranking_snapshots
         SET status = 'failed', attempt_count = ?, last_attempt_at_ms = ?, claim_token = NULL
         WHERE id = ? AND status = 'processing' AND claim_token = ?`,
        nextAttempt,
        nowMs,
        id,
        claimToken
      )
      return
    }
    const retryDelay = retryBaseMs * 2 ** Math.min(row.attempt_count, 4)
    this.db.run(
      `UPDATE model_ranking_snapshots
       SET status = 'pending', due_at_ms = ?, attempt_count = ?, last_attempt_at_ms = ?, claim_token = NULL
       WHERE id = ? AND status = 'processing' AND claim_token = ?`,
      nowMs + retryDelay,
      nextAttempt,
      nowMs,
      id,
      claimToken
    )
  }

  /**
   * Recovery path: re-queue exhausted 'failed' rows whose last attempt is
   * older than the cooldown, with a reset backoff, so a persistent judge
   * outage cannot strand rows forever. Runs inside the guarded drain; routed
   * through the database worker because the sweep is unbounded.
   */
  async requeueFailedForRecovery(cooldownMs: number, nowMs: number): Promise<void> {
    const result = await this.db.executeViaWorker(
      `UPDATE model_ranking_snapshots
       SET status = 'pending', due_at_ms = ?, attempt_count = 0
       WHERE status = 'failed' AND last_attempt_at_ms IS NOT NULL AND last_attempt_at_ms <= ?`,
      [nowMs, nowMs - cooldownMs]
    )
    if (!result.ok) {
      Logger.dev('Ranking failed-snapshot recovery sweep failed:', result.error)
    }
  }

  /**
   * Restart safety: rows left 'processing' by a crash (claimed but never
   * scored or deferred) return to the pending queue on startup. Routed through
   * the database worker because the sweep is unbounded.
   */
  async requeueStaleProcessing(): Promise<void> {
    const result = await this.db.executeViaWorker(
      `UPDATE model_ranking_snapshots
       SET status = 'pending', claim_token = NULL
       WHERE status = 'processing'`,
      []
    )
    if (!result.ok) {
      Logger.dev('Ranking stale-claim recovery sweep failed:', result.error)
    }
  }

  /** Earliest queued close deadline, used to arm one process-wide wake-up. */
  nextDueDeadline(): number | null {
    const row = this.db.get<{ due_at_ms: number | null }>(
      `SELECT MIN(due_at_ms) AS due_at_ms FROM model_ranking_snapshots
       WHERE status = 'pending'`
    )
    return row?.due_at_ms ?? null
  }

  /** Count of unresolved queue rows (debug/diagnostics). */
  pendingCount(): number {
    const row = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM model_ranking_snapshots
       WHERE status IN ('pending','processing')`
    )
    return row?.count ?? 0
  }
}

/** Deterministic snapshot id so a replayed capture stays a no-op. */
function snapshotId(input: OpenRankingSnapshotInput): string {
  return `ranking:${input.threadId}:${input.startedAt}`
}
