import { describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import { TurnFeedbackRepo } from '../../../src/main/database/repositories/turn-feedback-repo'
import type { TurnFeedbackRow } from '../../../src/main/database/repositories/turn-feedback-repo'
import type { Database } from '../../../src/main/database/database'

function seedThread(db: Database, threadId: string): void {
  db.run(
    `INSERT OR IGNORE INTO projects(id, name, path, source, provider_id, workflow_id, thread_limit, change_tracking_mode, created_at, updated_at)
     VALUES('p', 'Project', '/p', 'local', 'openai', 'default', 70, 'manual', 1, 1)`
  )
  db.run(
    `INSERT INTO threads(id, project_id, provider_id, title, status, pinned, archived, read, scope_bucket_id, created_at, updated_at, last_activity)
     VALUES(?, 'p', '', ?, 'created', 0, 0, 1, 'default', 1, 1, 1)`,
    threadId,
    `Thread ${threadId}`
  )
}

function openInput(
  threadId: string,
  parentTurnId: string,
  overrides: Partial<Parameters<TurnFeedbackRepo['openPending']>[0]> = {}
): Parameters<TurnFeedbackRepo['openPending']>[0] {
  return {
    id: `outcome:${parentTurnId}`,
    threadId,
    parentTurnId,
    createdAt: 1_000,
    feature: 'main',
    taskSlug: 'auth',
    harnessId: 'opencode',
    providerId: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    costUsd: null,
    costStatus: 'unavailable',
    tokensTotal: null,
    ...overrides
  }
}

function pendingRow(db: Database, parentTurnId: string): TurnFeedbackRow | undefined {
  return db.get('SELECT * FROM turn_feedback WHERE parent_turn_id = ?', parentTurnId) as
    TurnFeedbackRow | undefined
}

describe('TurnFeedbackRepo lifecycle', () => {
  it('opens a pending outcome and resolves it to success on continuation', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      expect(pendingRow(db, 'turn-1')?.status).toBe('pending')

      const resolved = repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)
      expect(resolved).toBe(true)
      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('success')
      expect(row?.signal).toBe('continued')
      expect(row?.score).toBe(1)
    } finally {
      destroyTestDb(db)
    }
  })

  it('resolves to corrected with a zero score on a corrective follow-up', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))

      repo.resolveLatestPendingForThread('t1', 'corrected', 'corrective_feedback', 0)
      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('corrected')
      expect(row?.signal).toBe('corrective_feedback')
      expect(row?.score).toBe(0)
    } finally {
      destroyTestDb(db)
    }
  })

  it('resolves each pending outcome at most once (idempotent)', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))

      expect(repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)).toBe(true)
      expect(repo.resolveLatestPendingForThread('t1', 'corrected', 'corrective_feedback', 0)).toBe(
        false
      )
      expect(pendingRow(db, 'turn-1')?.status).toBe('success')
      expect(repo.pendingCount()).toBe(0)
    } finally {
      destroyTestDb(db)
    }
  })

  it('resolves the newest pending outcome on a thread, leaving older ones open', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1', { createdAt: 1_000 }))
      repo.openPending(openInput('t1', 'turn-2', { createdAt: 2_000 }))

      repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)
      expect(pendingRow(db, 'turn-2')?.status).toBe('success')
      expect(pendingRow(db, 'turn-1')?.status).toBe('pending')
    } finally {
      destroyTestDb(db)
    }
  })

  it('keeps cleaned_up passes after the thread row is deleted (no cascade loss)', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))

      // Mirror the deletion flow: resolve first, then delete the thread.
      repo.resolvePendingForThread('t1', 'success', 'cleaned_up', 1)
      db.run('DELETE FROM threads WHERE id = ?', 't1')

      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('success')
      expect(row?.signal).toBe('cleaned_up')
      expect(row?.thread_id).toBeNull()
      expect(row?.model_id).toBe('gpt-5')
    } finally {
      destroyTestDb(db)
    }
  })

  it('resolves pending outcomes on every other thread when one is focused', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      seedThread(db, 't2')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      repo.openPending(openInput('t2', 'turn-2'))

      repo.resolvePendingForOtherThreads('t2', 'success', 'switched', 1)
      expect(pendingRow(db, 'turn-1')?.status).toBe('success')
      expect(pendingRow(db, 'turn-1')?.signal).toBe('switched')
      expect(pendingRow(db, 'turn-2')?.status).toBe('pending')
    } finally {
      destroyTestDb(db)
    }
  })

  it('aggregates modelPerformance with success rate, corrections, and task type', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      seedThread(db, 't2')
      const repo = new TurnFeedbackRepo(db)
      const base = {
        threadId: 't1',
        createdAt: 1_000,
        feature: 'main' as const,
        taskSlug: 'auth',
        harnessId: 'opencode',
        providerId: 'openai',
        modelId: 'gpt-5',
        thinkingLevel: 'high' as const,
        costStatus: 'known' as const
      }
      repo.openPending(
        openInput('t1', 't1-1', { ...base, createdAt: 1_000, costUsd: 0.4, tokensTotal: 4000 })
      )
      repo.openPending(
        openInput('t1', 't1-2', { ...base, createdAt: 2_000, costUsd: 0.2, tokensTotal: 2000 })
      )
      repo.openPending(
        openInput('t1', 't1-3', { ...base, createdAt: 3_000, costUsd: 0.9, tokensTotal: 9000 })
      )
      repo.openPending(
        openInput('t2', 'audit-1', {
          ...base,
          threadId: 't2',
          feature: 'audit',
          thinkingLevel: 'low',
          modelId: 'gpt-4o',
          createdAt: 4_000,
          costUsd: null,
          costStatus: 'unavailable'
        })
      )

      repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)
      repo.resolveLatestPendingForThread('t1', 'corrected', 'corrective_feedback', 0)
      repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)
      repo.resolvePendingForThread('t2', 'success', 'cleaned_up', 1)

      const performance = repo.modelPerformance({ startAt: 0, endAt: 10_000 })
      const main = performance.find((entry) => entry.modelId === 'gpt-5')
      expect(main?.outcomes).toBe(3)
      expect(main?.successes).toBe(2)
      expect(main?.corrected).toBe(1)
      expect(main?.successRate).toBe(2 / 3)
      expect(main?.thinkingLevel).toBe('high')
      expect(main?.taskType).toBe('main')
      expect(main?.harnessId).toBe('opencode')
      expect(main?.pricedOutcomes).toBe(3)
      expect(main?.costUsd).toBeCloseTo(1.5)
      expect(main?.tokensTotal).toBe(15_000)

      const audit = performance.find((entry) => entry.modelId === 'gpt-4o')
      expect(audit?.outcomes).toBe(1)
      expect(audit?.successRate).toBe(1)
      expect(audit?.taskType).toBe('audit')
      expect(audit?.thinkingLevel).toBe('low')
      // Unpriced outcomes are counted as outcomes but never enter cost sums.
      expect(audit?.pricedOutcomes).toBe(0)
      expect(audit?.costUsd).toBe(0)

      const cost = repo.feedbackCost({ startAt: 0, endAt: 10_000 })
      expect(cost.outcomes).toBe(4)
      expect(cost.pricedOutcomes).toBe(3)
      expect(cost.costUsd).toBeCloseTo(1.5)
      expect(cost.knownCostUsd).toBeCloseTo(1.5)
      expect(cost.estimatedCostUsd).toBe(0)
      expect(cost.tokensTotal).toBe(15_000)
    } finally {
      destroyTestDb(db)
    }
  })

  it('excludes still-pending outcomes from modelPerformance', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      repo.openPending(openInput('t1', 'turn-2', { createdAt: 2_000 }))
      repo.resolveLatestPendingForThread('t1', 'success', 'continued', 1)

      const performance = repo.modelPerformance({ startAt: 0, endAt: 10_000 })
      expect(performance).toHaveLength(1)
      expect(performance[0]?.outcomes).toBe(1)
    } finally {
      destroyTestDb(db)
    }
  })
})
