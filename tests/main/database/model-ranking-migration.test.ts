import { describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import type { Database } from '../../../src/main/database/database'

/**
 * Seeds the legacy `turn_feedback` ledger exactly as the pre-ranking schema
 * defined it, then runs the one-time migration and asserts the aggregate
 * sums, counts, and legacy rubric tag.
 */
const LEGACY_TURN_FEEDBACK_SQL = `
  CREATE TABLE IF NOT EXISTS turn_feedback (
    id             TEXT PRIMARY KEY NOT NULL,
    thread_id      TEXT,
    project_id     TEXT,
    parent_turn_id TEXT NOT NULL UNIQUE,
    session_id     TEXT,
    created_at     INTEGER NOT NULL,
    resolved_at    INTEGER,
    status         TEXT NOT NULL,
    basis          TEXT,
    grade          INTEGER,
    feature        TEXT,
    task_slug      TEXT,
    harness_id     TEXT,
    provider_id    TEXT,
    model_id       TEXT,
    thinking_level TEXT,
    cost_usd       REAL,
    cost_status    TEXT,
    tokens_total   INTEGER,
    user_message_text     TEXT NOT NULL DEFAULT '',
    assistant_output_text TEXT NOT NULL DEFAULT '',
    follow_up_text        TEXT,
    reading_deadline_ms   INTEGER,
    draft_deadline_ms     INTEGER,
    general_deadline_ms   INTEGER,
    due_at_ms             INTEGER,
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    last_attempt_at_ms    INTEGER
  );`

interface LegacyRow {
  id: string
  created_at: number
  status: string
  grade: number | null
  harness_id: string
  provider_id: string | null
  model_id: string
  thinking_level: string | null
  cost_usd: number | null
  cost_status: string
}

function seedLegacy(db: Database, rows: LegacyRow[]): void {
  db.run(LEGACY_TURN_FEEDBACK_SQL)
  for (const row of rows) {
    db.run(
      `INSERT INTO turn_feedback(
         id, parent_turn_id, created_at, status, grade,
         harness_id, provider_id, model_id, thinking_level,
         cost_usd, cost_status
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      row.id,
      `turn:${row.id}`,
      row.created_at,
      row.status,
      row.grade,
      row.harness_id,
      row.provider_id,
      row.model_id,
      row.thinking_level,
      row.cost_usd,
      row.cost_status
    )
  }
}

interface AggregateRow {
  harness_id: string
  provider_id: string
  model_id: string
  thinking_level: string
  one_shot_score_sum: number
  one_shot_samples: number
  one_shot_duration_sum_ms: number
  one_shot_cost_usd: number
  multi_shot_samples: number
  multi_shot_cost_usd: number
  rubric_version: string
  calc_version: string
}

describe('model ranking legacy migration', () => {
  it('folds graded legacy rows into the aggregate and drops the legacy table', async () => {
    const db = await createTestDb()
    try {
      seedLegacy(db, [
        {
          id: 'outcome:1',
          created_at: 1_000,
          status: 'graded',
          grade: 5,
          harness_id: 'pi',
          provider_id: 'openai',
          model_id: 'gpt-5',
          thinking_level: 'high',
          cost_usd: 0.03,
          cost_status: 'known'
        },
        {
          id: 'outcome:2',
          created_at: 2_000,
          status: 'graded',
          grade: 1,
          harness_id: 'pi',
          provider_id: 'openai',
          model_id: 'gpt-5',
          thinking_level: 'high',
          cost_usd: null,
          cost_status: 'unavailable'
        },
        {
          id: 'outcome:3',
          created_at: 3_000,
          status: 'graded',
          grade: 3,
          harness_id: 'codex',
          provider_id: null,
          model_id: 'gpt-5',
          thinking_level: null,
          cost_usd: 0.01,
          cost_status: 'estimated'
        },
        {
          id: 'outcome:4',
          created_at: 4_000,
          status: 'pending',
          grade: null,
          harness_id: 'pi',
          provider_id: 'openai',
          model_id: 'gpt-5',
          thinking_level: 'high',
          cost_usd: null,
          cost_status: 'unavailable'
        }
      ])

      db.migrateModelRankingTables()

      const aggregates = db.all(
        'SELECT * FROM model_rankings ORDER BY harness_id'
      ) as unknown as AggregateRow[]
      expect(aggregates).toHaveLength(2)

      // grade 5 → (5-1)×2.5 = 10; grade 1 → 0. Same key folds together.
      const pi = aggregates.find((row) => row.harness_id === 'pi')
      expect(pi?.one_shot_score_sum).toBe(10)
      expect(pi?.one_shot_samples).toBe(2)
      expect(pi?.one_shot_cost_usd).toBeCloseTo(0.03, 10)
      expect(pi?.rubric_version).toBe('legacy-1to5-map-v1')
      expect(pi?.calc_version).toBe('sum-count-v1')

      // Pending legacy rows never enter the aggregate.
      const codex = aggregates.find((row) => row.harness_id === 'codex')
      expect(codex?.one_shot_score_sum).toBe(5)
      expect(codex?.one_shot_samples).toBe(1)
      expect(codex?.provider_id).toBe('')
      expect(codex?.thinking_level).toBe('')

      // Durations did not exist in the legacy ledger.
      expect(pi?.one_shot_duration_sum_ms).toBe(0)
      expect(pi?.multi_shot_samples).toBe(0)

      const leftover = db.get('SELECT name FROM sqlite_master WHERE name = ?', 'turn_feedback')
      expect(leftover).toBeUndefined()
    } finally {
      destroyTestDb(db)
    }
  })

  it('adds the claim_token column to pre-existing snapshot tables in place', async () => {
    const db = await createTestDb()
    try {
      // Simulate a database created before claim-token tagging.
      db.run('DROP TABLE model_ranking_snapshots')
      db.run(
        `CREATE TABLE model_ranking_snapshots (
           id             TEXT PRIMARY KEY NOT NULL,
           thread_id      TEXT,
           project_id     TEXT NOT NULL,
           shot_category  TEXT NOT NULL,
           status         TEXT NOT NULL,
           harness_id     TEXT NOT NULL,
           provider_id    TEXT NOT NULL DEFAULT '',
           model_id       TEXT NOT NULL,
           thinking_level TEXT NOT NULL DEFAULT '',
           started_at     INTEGER NOT NULL,
           ended_at       INTEGER NOT NULL,
           closed_at_ms   INTEGER,
           due_at_ms      INTEGER NOT NULL,
           user_message_text     TEXT NOT NULL DEFAULT '',
           assistant_output_text TEXT NOT NULL DEFAULT '',
           attempt_count       INTEGER NOT NULL DEFAULT 0,
           created_at     INTEGER NOT NULL
         )`
      )
      db.run(
        `INSERT INTO model_ranking_snapshots(
           id, project_id, shot_category, status, harness_id, model_id,
           started_at, ended_at, due_at_ms, created_at
         ) VALUES('ranking:old', 'p', 'first_shot', 'pending', 'pi', 'gpt-5', 1, 2, 3, 1)`
      )

      db.migrateModelRankingSnapshotClaimToken()

      const columns = (
        db.all('PRAGMA table_info(model_ranking_snapshots)') as Array<{ name: string }>
      ).map((column) => column.name)
      expect(columns).toContain('claim_token')
      // The pre-existing row survives with a NULL token (unclaimed).
      const row = db.get('SELECT id, claim_token FROM model_ranking_snapshots') as {
        id: string
        claim_token: string | null
      }
      expect(row?.id).toBe('ranking:old')
      expect(row?.claim_token).toBeNull()
      // Idempotent re-run is a no-op.
      expect(() => db.migrateModelRankingSnapshotClaimToken()).not.toThrow()
    } finally {
      destroyTestDb(db)
    }
  })

  it('is a no-op on databases that never carried the legacy table', async () => {
    const db = await createTestDb()
    try {
      expect(() => db.migrateModelRankingTables()).not.toThrow()
      expect(db.all('SELECT * FROM model_rankings')).toHaveLength(0)
      expect(db.all('SELECT * FROM model_ranking_snapshots')).toHaveLength(0)
    } finally {
      destroyTestDb(db)
    }
  })

  it('discards a cost sum no conversation could have spent, and only that sum', async () => {
    const db = await createTestDb()
    try {
      // Exactly the shipped symptom: pi folded its own cumulative session cost
      // back into per-response cost and doubled it on every usage refresh, so
      // one $11.97 conversation landed as 3.4e46 (log2 of the ratio is 150.999)
      // and took the "spent across ranked conversations" figure with it.
      seedAggregate(db, {
        id: 'pi:opencode-go:deepseek-v4.1-flash:high',
        oneShot: {
          scoreSum: 48,
          samples: 6,
          durationSumMs: 900_000,
          costUsd: 3.414536402095199e46
        },
        multiShot: { scoreSum: 5, samples: 1, durationSumMs: 60_000, costUsd: 0.001261434 }
      })
      // A genuinely expensive configuration must survive untouched.
      seedAggregate(db, {
        id: 'claude-code:anthropic:default:high',
        oneShot: { scoreSum: 40, samples: 5, durationSumMs: 600_000, costUsd: 104.19 },
        multiShot: { scoreSum: 0, samples: 0, durationSumMs: 0, costUsd: 0 }
      })

      db.migrateModelRankingCostPlausibility()

      const poisoned = aggregate(db, 'pi:opencode-go:deepseek-v4.1-flash:high')
      expect(poisoned?.one_shot_cost_usd).toBe(0)
      // Scores, samples, durations, and the priced sibling are the ranking's own
      // honest numbers and are never touched by a cost repair.
      expect(poisoned?.one_shot_score_sum).toBe(48)
      expect(poisoned?.one_shot_samples).toBe(6)
      expect(poisoned?.one_shot_duration_sum_ms).toBe(900_000)
      expect(poisoned?.multi_shot_cost_usd).toBeCloseTo(0.001261434, 12)

      const priced = aggregate(db, 'claude-code:anthropic:default:high')
      expect(priced?.one_shot_cost_usd).toBeCloseTo(104.19, 10)

      // Idempotent: a repaired row is already below the ceiling.
      db.migrateModelRankingCostPlausibility()
      expect(aggregate(db, 'pi:opencode-go:deepseek-v4.1-flash:high')?.one_shot_cost_usd).toBe(0)
      expect(aggregate(db, 'claude-code:anthropic:default:high')?.one_shot_cost_usd).toBeCloseTo(
        104.19,
        10
      )
    } finally {
      destroyTestDb(db)
    }
  })
})

/** One shot category's stored sums, as the repair migration sees them. */
interface ShotSums {
  scoreSum: number
  samples: number
  durationSumMs: number
  costUsd: number
}

/** Seed one aggregate row directly, bypassing the increment gate under test. */
function seedAggregate(
  db: Database,
  seed: { id: string; oneShot: ShotSums; multiShot: ShotSums }
): void {
  const [harnessId, providerId, modelId, thinkingLevel] = seed.id.split(':')
  db.run(
    `INSERT INTO model_rankings(
       id, harness_id, provider_id, model_id, thinking_level,
       one_shot_score_sum, one_shot_samples, one_shot_duration_sum_ms, one_shot_cost_usd,
       multi_shot_score_sum, multi_shot_samples, multi_shot_duration_sum_ms, multi_shot_cost_usd,
       rubric_version, calc_version, updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'ranking-0to10-v1','sum-count-v1',1)`,
    seed.id,
    harnessId ?? '',
    providerId ?? '',
    modelId ?? '',
    thinkingLevel ?? '',
    seed.oneShot.scoreSum,
    seed.oneShot.samples,
    seed.oneShot.durationSumMs,
    seed.oneShot.costUsd,
    seed.multiShot.scoreSum,
    seed.multiShot.samples,
    seed.multiShot.durationSumMs,
    seed.multiShot.costUsd
  )
}

function aggregate(db: Database, id: string): AggregateRow | undefined {
  return db.get('SELECT * FROM model_rankings WHERE id = ?', id) as AggregateRow | undefined
}
