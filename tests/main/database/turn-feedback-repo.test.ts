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
    userMessageText: 'the request',
    assistantOutputText: 'the answer',
    ...overrides
  }
}

function pendingRow(db: Database, parentTurnId: string): TurnFeedbackRow | undefined {
  return db.get('SELECT * FROM turn_feedback WHERE parent_turn_id = ?', parentTurnId) as
    TurnFeedbackRow | undefined
}

describe('TurnFeedbackRepo lifecycle', () => {
  it('opens a pending outcome with its captured payload', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('pending')
      expect(row?.user_message_text).toBe('the request')
      expect(row?.assistant_output_text).toBe('the answer')
    } finally {
      destroyTestDb(db)
    }
  })

  it('stores a follow-up on the newest pending outcome and grades it once', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      repo.noteFollowUp('t1', 'actually still broken')
      expect(pendingRow(db, 'turn-1')?.follow_up_text).toBe('actually still broken')

      expect(repo.grade('outcome:turn-1', 'draft_timeout', 2)).toBe(true)
      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('graded')
      expect(row?.basis).toBe('draft_timeout')
      expect(row?.grade).toBe(2)

      // Grading is exactly-once.
      expect(repo.grade('outcome:turn-1', 'deleted', 5)).toBe(false)
      expect(pendingRow(db, 'turn-1')?.grade).toBe(2)
      expect(repo.pendingCount()).toBe(0)
    } finally {
      destroyTestDb(db)
    }
  })

  it('anchors deadline timers once and recovers due pendings with project context', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))
      repo.scheduleReading('t1', 5_000)
      repo.scheduleReading('t1', 9_000)
      repo.scheduleDraft('t1', 7_000)
      repo.scheduleDraft('t1', 8_000)
      const row = pendingRow(db, 'turn-1')
      expect(row?.reading_deadline_ms).toBe(5_000)
      expect(row?.draft_deadline_ms).toBe(7_000)
      expect(repo.listDuePending(6_999)).toHaveLength(1)
      expect(repo.listDuePendingWithProject(6_999)[0]?.project_id).toBe('p')

      // Clearing the draft never removes the anchored timer.
      repo.clearTimersForThread('t1')
      const cleared = pendingRow(db, 'turn-1')
      expect(cleared?.status).toBe('pending')
    } finally {
      destroyTestDb(db)
    }
  })

  it('keeps captured payloads after the thread row is deleted (no cascade loss)', async () => {
    const db = await createTestDb()
    try {
      seedThread(db, 't1')
      const repo = new TurnFeedbackRepo(db)
      repo.openPending(openInput('t1', 'turn-1'))

      // Mirror the deletion flow: capture the row, delete the thread, grade detached.
      const captured = repo.listPendingForThread('t1')
      expect(captured).toHaveLength(1)
      db.run('DELETE FROM threads WHERE id = ?', 't1')
      repo.grade(captured[0]?.id ?? '', 'deleted', 4)

      const row = pendingRow(db, 'turn-1')
      expect(row?.status).toBe('graded')
      expect(row?.basis).toBe('deleted')
      expect(row?.thread_id).toBeNull()
      expect(row?.model_id).toBe('gpt-5')
      expect(row?.user_message_text).toBe('the request')
    } finally {
      destroyTestDb(db)
    }
  })

  it('aggregates modelPerformance as average grade over five with task type', async () => {
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

      repo.grade('outcome:t1-1', 'read_timeout', 5)
      repo.grade('outcome:t1-2', 'draft_timeout', 3)
      repo.grade('outcome:t1-3', 'read_timeout', null)

      const performance = repo.modelPerformance({ startAt: 0, endAt: 10_000 })
      expect(performance).toHaveLength(1)
      const main = performance[0]
      expect(main?.outcomes).toBe(3)
      expect(main?.averageGrade).toBe(4) // (5+3)/2 — null grades never skew the average
      expect(main?.successRate).toBeCloseTo(0.8)
      expect(main?.thinkingLevel).toBe('high')
      expect(main?.taskType).toBe('main')
      expect(main?.harnessId).toBe('opencode')
      expect(main?.pricedOutcomes).toBe(3)
      expect(main?.costUsd).toBeCloseTo(1.5)
      expect(main?.tokensTotal).toBe(15_000)

      const cost = repo.feedbackCost({ startAt: 0, endAt: 10_000 })
      expect(cost.outcomes).toBe(3)
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
      repo.grade('outcome:turn-2', 'read_timeout', 4)

      const performance = repo.modelPerformance({ startAt: 0, endAt: 10_000 })
      expect(performance).toHaveLength(1)
      expect(performance[0]?.outcomes).toBe(1)
    } finally {
      destroyTestDb(db)
    }
  })
})
