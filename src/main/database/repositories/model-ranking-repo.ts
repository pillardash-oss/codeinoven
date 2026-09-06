import type { Database } from '../database'
import { MODEL_RANKING_CALC_VERSION } from '../schema'
import type {
  LocalProfileGradingSpend,
  LocalProfileModelRanking,
  LocalProfileRankingModeStats,
  ModelRankingRow,
  RankingShotCategory,
  ThinkingLevel
} from '../../../lib/types'

/** Input for one exactly-once aggregate increment, applied in a single statement. */
export interface ModelRankingIncrement {
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel: string
  shotCategory: RankingShotCategory
  /** Judge score on the active 0–10 rubric. */
  score: number
  /** Agent window duration in milliseconds (ended_at − started_at of the snapshot). */
  durationMs: number
  /** Priced cost of the ranked session in USD, or null when unpriced. */
  costUsd: number | null
  /** Rubric version that produced the score; each version aggregates separately. */
  rubricVersion: string
}

interface GradingSpendRow {
  cost_usd: number
}

/**
 * Permanent "best model" aggregate keyed by harness + provider + model +
 * thinking level + rubric version. Every increment adds raw score, duration,
 * and cost sums in one SQL upsert, so averages are always recomputed as
 * sum ÷ count — never averages of averages. Processed snapshots are
 * hard-deleted by design, making this table the single surviving record.
 */
export class ModelRankingRepo {
  constructor(private db: Database) {}

  /**
   * Add one scored snapshot's contribution to the matching aggregate row,
   * creating it on first sight. One statement targets exactly one key.
   */
  increment(input: ModelRankingIncrement): void {
    const id = rankingRowId(input)
    if (input.shotCategory === 'first_shot') {
      this.db.run(
        `INSERT INTO model_rankings(
           id, harness_id, provider_id, model_id, thinking_level,
           one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
           multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
           rubric_version, calc_version, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(harness_id, provider_id, model_id, thinking_level, rubric_version) DO UPDATE SET
           one_shot_score_sum = one_shot_score_sum + excluded.one_shot_score_sum,
           one_shot_samples = one_shot_samples + excluded.one_shot_samples,
           one_shot_duration_sum_ms = one_shot_duration_sum_ms + excluded.one_shot_duration_sum_ms,
           one_shot_cost_usd = one_shot_cost_usd + excluded.one_shot_cost_usd,
           updated_at = excluded.updated_at`,
        id,
        input.harnessId,
        input.providerId,
        input.modelId,
        input.thinkingLevel,
        input.score,
        1,
        Math.max(0, input.durationMs),
        input.costUsd ?? 0,
        0,
        0,
        0,
        0,
        input.rubricVersion,
        MODEL_RANKING_CALC_VERSION,
        Date.now()
      )
      return
    }
    this.db.run(
      `INSERT INTO model_rankings(
         id, harness_id, provider_id, model_id, thinking_level,
         one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
         multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
         rubric_version, calc_version, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(harness_id, provider_id, model_id, thinking_level, rubric_version) DO UPDATE SET
         multi_shot_score_sum = multi_shot_score_sum + excluded.multi_shot_score_sum,
         multi_shot_samples = multi_shot_samples + excluded.multi_shot_samples,
         multi_shot_duration_sum_ms = multi_shot_duration_sum_ms + excluded.multi_shot_duration_sum_ms,
         multi_shot_cost_usd = multi_shot_cost_usd + excluded.multi_shot_cost_usd,
         updated_at = excluded.updated_at`,
      id,
      input.harnessId,
      input.providerId,
      input.modelId,
      input.thinkingLevel,
      0,
      0,
      0,
      0,
      input.score,
      1,
      Math.max(0, input.durationMs),
      input.costUsd ?? 0,
      input.rubricVersion,
      MODEL_RANKING_CALC_VERSION,
      Date.now()
    )
  }

  /** Every aggregate row with at least 5 total ranked conversations, strongest one-shot record first. */
  listAll(): ModelRankingRow[] {
    return this.db.all<ModelRankingRow>(
      `SELECT * FROM model_rankings
       WHERE (one_shot_samples + multi_shot_samples) >= ${MIN_RANKING_SAMPLES}
       ORDER BY (one_shot_score_sum / CASE WHEN one_shot_samples > 0 THEN one_shot_samples ELSE 1 END) DESC,
                updated_at DESC`
    )
  }

  /** All-time priced cost of every ranked session folded into the aggregate. */
  gradingSpend(): LocalProfileGradingSpend {
    const row = this.db.get<GradingSpendRow>(
      'SELECT COALESCE(SUM(one_shot_cost_usd + multi_shot_cost_usd), 0) AS cost_usd FROM model_rankings'
    )
    return { costUsd: row?.cost_usd ?? 0 }
  }

  /** IPC-shaped view of the aggregates; averages are always sum ÷ count. */
  analytics(): LocalProfileModelRanking[] {
    // Returns every aggregate row regardless of sample count — the
    // statistical-significance threshold is a display concern applied by
    // listAll(), not a data-integrity one. Callers (Profile analytics, IPC)
    // must see aggregates as soon as the first ranked conversation lands.
    return this.db
      .all<ModelRankingRow>('SELECT * FROM model_rankings ORDER BY updated_at DESC')
      .map((row) => ({
        harnessId: row.harness_id,
        providerId: row.provider_id,
        modelId: row.model_id,
        thinkingLevel: row.thinking_level ? (row.thinking_level as ThinkingLevel) : null,
        rubricVersion: row.rubric_version,
        oneShot: modeStats(
          row.one_shot_score_sum,
          row.one_shot_samples,
          row.one_shot_duration_sum_ms,
          row.one_shot_cost_usd
        ),
        multiShot: modeStats(
          row.multi_shot_score_sum,
          row.multi_shot_samples,
          row.multi_shot_duration_sum_ms,
          row.multi_shot_cost_usd
        ),
        updatedAt: row.updated_at
      }))
  }
}

/** Stable primary key derived from the full ranking key + rubric version. */
function rankingRowId(input: ModelRankingIncrement): string {
  return `${input.harnessId}:${input.providerId}:${input.modelId}:${input.thinkingLevel}:${input.rubricVersion}`
}

/** Minimum total ranked conversations (one-shot + multi-shot) for a ranking row to be reported. */
const MIN_RANKING_SAMPLES = 5

/** Sum/count round-trip for one shot category; null averages before any sample. */
function modeStats(
  scoreSum: number,
  samples: number,
  durationSumMs: number,
  costUsd: number
): LocalProfileRankingModeStats {
  return {
    averageScore: samples > 0 ? scoreSum / samples : null,
    samples,
    averageDurationMs: samples > 0 ? durationSumMs / samples : null,
    costUsd
  }
}
