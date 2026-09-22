import { randomUUID } from 'crypto'
import { Logger } from '../../system/logger'
import { purgeRowsViaWorker, type RowsPurged } from '../worker-purge'
import type { Database } from '../database'
import type { ModelRankingSnapshotRow, RankingShotCategory } from '../../../lib/types'

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
  /** Visible user message this window answers. The window counts one shot per
   *  prompt, so a later turn that re-answers this same message refreshes the
   *  window instead of registering a follow-up. */
  anchorMessageId: string
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
}

/**
 * One queued row's identity and deadline, without its conversation payload.
 *
 * A drain pass reads this window before it claims anything, so the rows it must
 * hold back are decided without loading transcripts the pass may never judge.
 */
export interface RankingQueueHead {
  id: string
  harness_id: string
  provider_id: string
  model_id: string
  due_at_ms: number
}

/**
 * Transient grading queue for model-ranking conversations. Snapshots are
 * captured while a conversation window is open, closed for grading by thread
 * deletion or the inactivity deadline, claimed in bounded batches by the
 * drain, and hard-deleted the moment their score lands in the aggregate  
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
         user_message_text, assistant_output_text, follow_up_text, anchor_message_id,
         cost_usd, cost_status, attempt_count, last_attempt_at_ms, created_at
       ) VALUES(?,?,?,?, 'pending', ?,?,?,?,?,?, NULL, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?)`,
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
        input.anchorMessageId,
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
         user_message_text, assistant_output_text, follow_up_text, anchor_message_id,
         cost_usd, cost_status, attempt_count, last_attempt_at_ms, created_at
       ) VALUES(?,?,?,?, 'pending', ?,?,?,?,?,?, NULL, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?)`,
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
      input.anchorMessageId,
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
   * A completed later exchange on the still-open conversation window.
   *
   * `promptMessageId` is the visible user message this exchange answers. A
   * prompt the window already answers is not a new shot: an invisible
   * continuation (a search nudge, a Mermaid repair, incomplete-turn recovery,
   * a specification continuation) and a resumed retry all re-answer the user's
   * own message, so such a turn refreshes the graded answer in place instead of
   * upgrading the window to `multi_shot` and handing the judge the same prompt
   * again as a follow-up, which the rubric reads as the user pushing back.
   *
   * A genuinely later prompt upgrades the classification to `multi_shot` and
   * appends its text as judge context. Either way the inactivity deadline
   * slides, so the window stays open   a conversation is graded exactly once,
   * at close. A plain update, never a failure marker.
   *
   * One statement, deliberately: the database worker owns a second connection
   * to the same file, so a read-then-write could have another connection's
   * write land in between. Every CASE reads the pre-update row, and the answer
   * is refreshed only while the window holds a single exchange (`first_shot`,
   * where the prompt being answered again IS the window's own) and only with
   * real text, because a text-less continuation turn must never erase the
   * answer the user received.
   *
   * If the drain had already claimed the row ('processing', inactivity
   * deadline elapsed mid-conversation), the row is reset to 'pending' and its
   * claim token cleared, so the in-flight judge result is discarded (its
   * delete guard no longer matches) and the conversation is graded later with
   * the final answer.
   */
  registerCompletedExchange(
    id: string,
    promptMessageId: string,
    followUpText: string,
    assistantOutputText: string,
    endedAt: number,
    nextDueAtMs: number
  ): void {
    this.db.run(
      `UPDATE model_ranking_snapshots
       SET shot_category = CASE
             WHEN anchor_message_id = ? THEN shot_category
             ELSE 'multi_shot'
           END,
           follow_up_text = CASE
             WHEN anchor_message_id = ? THEN follow_up_text
             ELSE substr(
               CASE WHEN follow_up_text IS NULL OR follow_up_text = ''
                    THEN ? ELSE follow_up_text || char(10) || char(10) || ? END,
               -12000)
           END,
           assistant_output_text = CASE
             WHEN anchor_message_id = ? AND shot_category = 'first_shot' AND ? <> ''
               THEN ?
             ELSE assistant_output_text
           END,
           anchor_message_id = ?,
           ended_at = ?,
           due_at_ms = ?,
           status = 'pending',
           claim_token = NULL
       WHERE id = ? AND closed_at_ms IS NULL AND status IN ('pending','processing')`,
      promptMessageId,
      promptMessageId,
      followUpText,
      followUpText,
      promptMessageId,
      assistantOutputText,
      assistantOutputText,
      promptMessageId,
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
   * Claim up to `limit` due pending snapshots: the oldest due rows are read,
   * then flipped to 'processing' in one statement that is guarded by the
   * pending status, so overlapping drains can never claim the same row twice.
   * Every claim carries a unique generation token; score, delete, and defer
   * operations are guarded by it, so a stale judge result from a previous
   * claim generation can never apply to a re-claimed row.
   *
   * The drain plans its batch from `dueQueueHead` plus its own judge-route
   * checks and claims it with `claimRows`; this stays as the plain
   * "take the head of the queue" form, and delegates to those two so one
   * implementation owns the token and the guards.
   */
  claimDueBatch(nowMs: number, limit = 3): ModelRankingSnapshotRow[] {
    return this.claimRows(
      nowMs,
      this.dueQueueHead(nowMs, limit).map((row) => row.id)
    )
  }

  /**
   * The head of the pending queue, in the same order `claimDueBatch` would take
   * it, carrying only the columns a pass needs to decide what to claim. Read
   * only: nothing is flipped to 'processing' until the pass has planned.
   */
  dueQueueHead(nowMs: number, limit: number): RankingQueueHead[] {
    return this.db.all<RankingQueueHead>(
      `SELECT id, harness_id, provider_id, model_id, due_at_ms
       FROM model_ranking_snapshots
       WHERE status = 'pending' AND due_at_ms <= ?
       ORDER BY due_at_ms ASC, created_at ASC, id ASC
       LIMIT ?`,
      nowMs,
      limit
    )
  }

  /**
   * Claim exactly the rows a pass planned to judge, under one generation token
   * so a stale judge result can never apply to a re-claimed row. Guarded by the
   * pending status and the deadline, so a row that was closed by a new exchange
   * or already claimed while the pass was planning is silently left alone.
   */
  claimRows(nowMs: number, ids: readonly string[]): ModelRankingSnapshotRow[] {
    if (ids.length === 0) return []
    const claimToken = randomUUID()
    const placeholders = ids.map(() => '?').join(', ')
    return this.db.all<ModelRankingSnapshotRow>(
      `UPDATE model_ranking_snapshots
       SET status = 'processing', claim_token = ?
       WHERE id IN (${placeholders}) AND status = 'pending' AND due_at_ms <= ?
       RETURNING *`,
      claimToken,
      ...ids,
      nowMs
    )
  }

  /**
   * Push still-pending rows to a later deadline without touching their status
   * or attempt count.
   *
   * A row whose provider already reported its usage window closed is not a
   * judge failure: claiming it would consume one of its attempts on work that
   * cannot run, and would report a null score the queue never asked for. The
   * rows keep their pending state and simply wait, grouped by the moment their
   * window reopens. Routed through the database worker because the pass defers
   * every due row of the blocked route at once. The write outcome is returned so
   * the caller can pace itself when a deferral does not land.
   */
  async deferPendingRowsViaWorker(
    ids: readonly string[],
    dueAtMs: number,
    nowMs: number
  ): Promise<{ ok: boolean; error?: string }> {
    if (ids.length === 0) return { ok: true }
    const placeholders = ids.map(() => '?').join(', ')
    const result = await this.db.executeViaWorker(
      `UPDATE model_ranking_snapshots
       SET due_at_ms = ?
       WHERE id IN (${placeholders}) AND status = 'pending' AND due_at_ms <= ?`,
      [dueAtMs, ...ids, nowMs]
    )
    if (!result.ok) {
      Logger.dev('Ranking window deferral write failed:', result.error)
    }
    return result
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
        'DELETE FROM model_ranking_snapshots WHERE id = ? AND status = ' +
          "'processing' AND claim_token = ?",
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
   * 'failed' with its attempt count preserved for recovery   never deleted
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
    const attemptCount = this.claimedAttemptCount(id, claimToken)
    if (attemptCount === null) return
    const statement = this.deferOrParkStatement(
      id,
      claimToken,
      attemptCap,
      rankingRetryDelayMs(attemptCount, retryBaseMs),
      nowMs
    )
    this.db.run(statement.sql, ...statement.params)
  }

  /**
   * The same judge-failure bookkeeping, executed on the database worker's
   * connection so a retry write can never stall the Electron main thread on a
   * contended database. The retry/park decision and the next attempt count are
   * derived inside the statement from the row's own persisted state, guarded by
   * the claim generation, so the worker path and the primary path write exactly
   * the same record. Only the attempt-count read stays on the primary
   * connection: it is a primary-key lookup, and the worker's bounded-query
   * path cannot host the claim's `UPDATE … RETURNING`.
   */
  async deferOrParkViaWorker(
    id: string,
    claimToken: string,
    attemptCap: number,
    retryBaseMs: number,
    nowMs: number
  ): Promise<void> {
    const attemptCount = this.claimedAttemptCount(id, claimToken)
    if (attemptCount === null) return
    const statement = this.deferOrParkStatement(
      id,
      claimToken,
      attemptCap,
      rankingRetryDelayMs(attemptCount, retryBaseMs),
      nowMs
    )
    await this.db.executeViaWorker(statement.sql, statement.params)
  }

  /** Attempt count of a row still owned by the given claim generation, or null. */
  private claimedAttemptCount(id: string, claimToken: string): number | null {
    const row = this.db.get<{ attempt_count: number }>(
      "SELECT attempt_count FROM model_ranking_snapshots WHERE id = ? AND status = 'processing' AND claim_token = ?",
      id,
      claimToken
    )
    return row === undefined ? null : row.attempt_count
  }

  /**
   * One statement for both outcomes: when the next attempt reaches the cap the
   * row parks as 'failed' and keeps its deadline (recovery re-queues it), and
   * otherwise it returns to 'pending' at the caller's retry deadline.
   */
  private deferOrParkStatement(
    id: string,
    claimToken: string,
    attemptCap: number,
    retryDelayMs: number,
    nowMs: number
  ): { sql: string; params: unknown[] } {
    return {
      sql: `UPDATE model_ranking_snapshots
       SET status = CASE WHEN attempt_count + 1 >= ? THEN 'failed' ELSE 'pending' END,
           due_at_ms = CASE WHEN attempt_count + 1 >= ? THEN due_at_ms ELSE ? END,
           attempt_count = attempt_count + 1,
           last_attempt_at_ms = ?,
           claim_token = NULL
       WHERE id = ? AND status = 'processing' AND claim_token = ?`,
      params: [attemptCap, attemptCap, nowMs + retryDelayMs, nowMs, id, claimToken]
    }
  }

  /**
   * Hold back one harness's due queue   every pending row whose deadline has
   * already arrived   until a cooldown deadline, spreading the released rows by
   * up to `jitterMs` so a judge that recovers does not re-judge a whole backlog
   * in one burst. Rows whose own deadline is already later than the cooldown are
   * untouched, and the failing row itself is covered because its retry deadline
   * is the earliest one in the queue. Unbounded sweep: routed through the
   * database worker.
   */
  async deferQueuedHarnessCooldown(
    harnessId: string,
    dueAtMs: number,
    jitterMs: number,
    nowMs: number
  ): Promise<void> {
    const result = await this.db.executeViaWorker(
      `UPDATE model_ranking_snapshots
       SET due_at_ms = ? + ABS(RANDOM() % ?)
       WHERE harness_id = ? AND status = 'pending' AND due_at_ms <= ?`,
      [dueAtMs, Math.max(1, Math.floor(jitterMs)), harnessId, nowMs]
    )
    if (!result.ok) {
      Logger.dev('Ranking harness cooldown sweep failed:', result.error)
    }
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
       SET status = 'pending', due_at_ms = ?, attempt_count = 0, claim_token = NULL
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

  /**
   * Every queue row in any state, including ones parked as `failed` for
   * recovery. A user-requested clean slate reports and removes all of them,
   * because a surviving row would be graded later and repopulate the ranking
   * aggregates the user just cleared.
   */
  async totalCount(): Promise<number> {
    const result = await this.db.queryViaWorker(
      'SELECT COUNT(*) AS count FROM model_ranking_snapshots',
      [],
      1
    )
    const value = result.rows[0]?.['count']
    return typeof value === 'number' ? value : 0
  }

  /**
   * Drop every queue row in bounded worker batches.
   *
   * This is the one place a row is discarded without a score, and it is
   * deliberate: an explicit user purge must not leave conversations that would
   * later restore the cleared aggregates. Rows a drain has already claimed stop
   * matching its claim token once deleted, so an in-flight grade result is
   * dropped instead of resurrecting the slate.
   */
  clearAllViaWorker(): Promise<RowsPurged> {
    // `1 = 1` is the whole-table filter; the purge helper takes a predicate so
    // range-scoped purges and this one share a single batched implementation.
    return purgeRowsViaWorker(this.db, 'model_ranking_snapshots', '1 = 1', [])
  }
}

/**
 * Retry delay for a judge failure at the given persisted attempt count:
 * bounded exponential backoff, so a judge that keeps failing backs off to
 * roughly an hour between attempts instead of hammering a fixed cadence.
 */
export function rankingRetryDelayMs(attemptCount: number, retryBaseMs: number): number {
  return retryBaseMs * 2 ** Math.min(attemptCount, 4)
}

/** Deterministic snapshot id so a replayed capture stays a no-op. */
function snapshotId(input: OpenRankingSnapshotInput): string {
  return `ranking:${input.threadId}:${input.startedAt}`
}
