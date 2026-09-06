import { describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import { ModelRankingRepo } from '../../../src/main/database/repositories/model-ranking-repo'
import type { ModelRankingIncrement } from '../../../src/main/database/repositories/model-ranking-repo'
import type { ModelRankingRow } from '../../../src/lib/types'
import type { Database } from '../../../src/main/database/database'

function increment(overrides: Partial<ModelRankingIncrement> = {}): ModelRankingIncrement {
  return {
    harnessId: 'pi',
    providerId: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    shotCategory: 'first_shot',
    score: 8,
    durationMs: 45_000,
    costUsd: 0.02,
    rubricVersion: 'ranking-0to10-v1',
    ...overrides
  }
}

function row(db: Database, modelId: string): ModelRankingRow | undefined {
  return db.get('SELECT * FROM model_rankings WHERE model_id = ?', modelId) as
    | ModelRankingRow
    | undefined
}

describe('ModelRankingRepo', () => {
  it('creates the aggregate row on first increment and updates it in place after', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      repo.increment(increment())
      repo.increment(increment({ score: 6, durationMs: 15_000 }))

      expect(db.all('SELECT * FROM model_rankings')).toHaveLength(1)
      const aggregate = row(db, 'gpt-5')
      expect(aggregate?.one_shot_score_sum).toBe(14)
      expect(aggregate?.one_shot_samples).toBe(2)
      expect(aggregate?.one_shot_duration_sum_ms).toBe(60_000)
      expect(aggregate?.rubric_version).toBe('ranking-0to10-v1')
      expect(aggregate?.calc_version).toBe('sum-count-v1')
    } finally {
      destroyTestDb(db)
    }
  })

  it('round-trips averages exactly as sum ÷ count, never as averages of averages', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      // Deliberately uneven scores: an average-of-averages would give 8.5.
      repo.increment(increment({ score: 10, durationMs: 10_000 }))
      repo.increment(increment({ score: 4, durationMs: 30_000 }))
      repo.increment(increment({ score: 8, durationMs: 20_000 }))

      const view = repo.analytics()
      expect(view).toHaveLength(1)
      expect(view[0]?.oneShot.averageScore).toBeCloseTo(22 / 3, 10)
      expect(view[0]?.oneShot.averageDurationMs).toBeCloseTo(60_000 / 3, 10)
      expect(view[0]?.oneShot.samples).toBe(3)
    } finally {
      destroyTestDb(db)
    }
  })

  it('keeps one-shot and multi-shot sums fully separate', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      repo.increment(increment({ shotCategory: 'first_shot', score: 7, durationMs: 5_000 }))
      repo.increment(increment({ shotCategory: 'multi_shot', score: 9, durationMs: 25_000 }))

      const aggregate = row(db, 'gpt-5')
      expect(aggregate?.one_shot_samples).toBe(1)
      expect(aggregate?.one_shot_score_sum).toBe(7)
      expect(aggregate?.multi_shot_samples).toBe(1)
      expect(aggregate?.multi_shot_score_sum).toBe(9)
      expect(aggregate?.multi_shot_duration_sum_ms).toBe(25_000)
    } finally {
      destroyTestDb(db)
    }
  })

  it('never merges distinct harness, provider, model, thinking level, or rubric values', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      repo.increment(increment())
      repo.increment(increment({ harnessId: 'codex' }))
      repo.increment(increment({ providerId: 'anthropic' }))
      repo.increment(increment({ modelId: 'gpt-5-mini' }))
      repo.increment(increment({ thinkingLevel: 'low' }))
      repo.increment(increment({ rubricVersion: 'legacy-1to5-map-v1' }))

      const aggregates = db.all('SELECT * FROM model_rankings')
      expect(aggregates).toHaveLength(6)
    } finally {
      destroyTestDb(db)
    }
  })

  it('tracks grading spend from priced sessions only', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      repo.increment(increment({ costUsd: 0.02 }))
      repo.increment(increment({ costUsd: null }))
      repo.increment(increment({ shotCategory: 'multi_shot', costUsd: 0.05 }))

      const spend = repo.gradingSpend()
      expect(spend.costUsd).toBeCloseTo(0.07, 10)
    } finally {
      destroyTestDb(db)
    }
  })

  it('returns null averages before any sample in a category', async () => {
    const db = await createTestDb()
    try {
      const repo = new ModelRankingRepo(db)
      repo.increment(increment({ shotCategory: 'multi_shot' }))

      const view = repo.analytics()
      expect(view[0]?.oneShot.averageScore).toBeNull()
      expect(view[0]?.oneShot.averageDurationMs).toBeNull()
      expect(view[0]?.oneShot.samples).toBe(0)
      expect(view[0]?.multiShot.averageScore).toBe(8)
    } finally {
      destroyTestDb(db)
    }
  })
})
