import type { Database as DatabaseType } from 'better-sqlite3'
import type { SchemaMigration } from '../migration'
import { tableColumns } from '../migration-helpers'
import { MAX_PLAUSIBLE_SHOT_COST_USD } from '../../schema'

/**
 * Discard ranking cost sums that an arithmetic artifact poisoned.
 *
 * The cost columns of `model_rankings` are running sums whose snapshots are
 * hard-deleted the moment they are scored, so one absurd addend can never be
 * subtracted back out: it only ever surfaces as an impossible per-sample
 * average, and it takes the "spent across ranked conversations" figure with it
 * forever. Anything above `MAX_PLAUSIBLE_SHOT_COST_USD` per ranked
 * conversation is therefore dropped to 0, exactly how an unpriced session is
 * already recorded: the priced siblings of those samples under-report by the
 * few cents they actually cost, which is the honest direction for a sum
 * nothing can recompute. Scores, sample counts, and durations are untouched,
 * because those are the ranking's own numbers and they were never corrupt.
 * The 2026-10-10 pi cumulative-cost fix stopped the one producer of such
 * addends, and `ModelRankingRepo` now refuses to fold a new one in at all.
 * Idempotent: a repaired row is already below the ceiling.
 */
export const modelRankingCostPlausibilityMigration: SchemaMigration = {
  id: '0003-model-ranking-cost-plausibility',
  summary: 'ranking cost running sums poisoned above the plausible per-shot ceiling reset to 0',
  apply(connection: DatabaseType): void {
    if (tableColumns(connection, 'model_rankings').size === 0) return
    const beyondCeiling = (samplesColumn: string, costColumn: string): string =>
      `${samplesColumn} > 0 AND ${costColumn} > ${samplesColumn} * ${MAX_PLAUSIBLE_SHOT_COST_USD}`
    connection.exec(`
      UPDATE model_rankings
      SET one_shot_cost_usd = CASE
            WHEN ${beyondCeiling('one_shot_samples', 'one_shot_cost_usd')} THEN 0
            ELSE one_shot_cost_usd
          END,
          multi_shot_cost_usd = CASE
            WHEN ${beyondCeiling('multi_shot_samples', 'multi_shot_cost_usd')} THEN 0
            ELSE multi_shot_cost_usd
          END
      WHERE (${beyondCeiling('one_shot_samples', 'one_shot_cost_usd')})
         OR (${beyondCeiling('multi_shot_samples', 'multi_shot_cost_usd')})
    `)
  }
}
