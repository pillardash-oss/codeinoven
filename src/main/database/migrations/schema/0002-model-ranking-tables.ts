import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'
import {
  LEGACY_RUBRIC_VERSION,
  MODEL_RANKINGS_COLUMNS_SQL,
  MODEL_RANKING_CALC_VERSION,
  MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL,
  MODEL_RANKING_SNAPSHOT_INDEXES_SQL,
  MODEL_RANKING_INDEXES_SQL
} from '../../schema'

/**
 * One-time replacement of the legacy per-turn `turn_feedback` ledger (1-5
 * grades) with the `model_rankings` aggregate + `model_ranking_snapshots`
 * queue. Graded legacy rows are folded into the aggregate with the linear
 * map grade -> (grade - 1) x 2.5 under `rubric_version = 'legacy-1to5-map-v1'`
 * (no duration information existed, so duration sums stay 0), and only then
 * is the legacy table dropped. Idempotent: without a legacy table this is a
 * no-op. The fold-in is a single grouped INSERT ... SELECT, so large ledgers
 * stay one bounded pass rather than per-row inserts.
 */
export const modelRankingTablesMigration: SchemaMigration = {
  id: '0002-model-ranking-tables',
  summary: 'the turn_feedback ledger is folded into model_rankings and its snapshot queue',
  apply(connection: DatabaseType): void {
    const columns = tableColumns(connection, 'turn_feedback')
    if (columns.size === 0) return
    if (!columns.has('grade')) {
      // Databases predating LLM-graded turn feedback carry the useless binary
      // pass/fail ledger (status 'success'/'corrected', regex-driven). The
      // metric was unreliable by construction: nothing is worth translating.
      connection.exec('DROP TABLE turn_feedback')
      return
    }
    // The aggregate must exist before the fold-in; the canonical schema's
    // CREATE IF NOT EXISTS stays a no-op afterwards.
    connection.exec(
      `CREATE TABLE IF NOT EXISTS model_rankings (${MODEL_RANKINGS_COLUMNS_SQL});
       CREATE TABLE IF NOT EXISTS model_ranking_snapshots (${MODEL_RANKING_SNAPSHOTS_COLUMNS_SQL});`
    )
    connection.exec(MODEL_RANKING_INDEXES_SQL)
    connection.exec(MODEL_RANKING_SNAPSHOT_INDEXES_SQL)
    connection.exec(`
      INSERT INTO model_rankings(
        id, harness_id, provider_id, model_id, thinking_level,
        one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
        multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
        rubric_version, calc_version, updated_at
      )
      SELECT
        'legacy-' || MIN(legacy.rowid),
        legacy.harness_id,
        COALESCE(legacy.provider_id, ''),
        legacy.model_id,
        COALESCE(legacy.thinking_level, ''),
        SUM((legacy.grade - 1) * 2.5),
        COUNT(*),
        0,
        COALESCE(SUM(CASE WHEN legacy.cost_status <> 'unavailable' AND legacy.cost_usd IS NOT NULL
                          THEN legacy.cost_usd ELSE 0 END), 0),
        0, 0, 0, 0,
        '${LEGACY_RUBRIC_VERSION}',
        '${MODEL_RANKING_CALC_VERSION}',
        MAX(legacy.created_at)
      FROM turn_feedback AS legacy
      WHERE legacy.status = 'graded'
        AND legacy.grade IS NOT NULL
        AND legacy.harness_id IS NOT NULL
        AND legacy.model_id IS NOT NULL
      GROUP BY legacy.harness_id, COALESCE(legacy.provider_id, ''), legacy.model_id,
               COALESCE(legacy.thinking_level, '')
    `)
    connection.exec('DROP TABLE turn_feedback')
  }
}
