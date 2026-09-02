import { describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import { ModelRankingSnapshotRepo } from '../../../src/main/database/repositories/model-ranking-snapshot-repo'
import type { OpenRankingSnapshotInput } from '../../../src/main/database/repositories/model-ranking-snapshot-repo'
import type { ModelRankingSnapshotRow } from '../../../src/lib/types'
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

function input(threadId: string, overrides: Partial<OpenRankingSnapshotInput> = {}): OpenRankingSnapshotInput {
  return {
    threadId,
    projectId: 'p',
    shotCategory: 'first_shot',
    harnessId: 'pi',
    providerId: 'openai',
    modelId: 'gpt-5',
    thinkingLevel: 'high',
    startedAt: 1_000,
    endedAt: 46_000,
    dueAtMs: 86_461_000,
    userMessageText: 'fix the login bug',
    assistantOutputText: 'Fixed.',
    costUsd: 0.01,
    costStatus: 'known',
    ...overrides
  }
}

function snapshot(db: Database, threadId: string): ModelRankingSnapshotRow | undefined {
  return db.get(
    'SELECT * FROM model_ranking_snapshots WHERE thread_id = ?',
    threadId
  ) as ModelRankingSnapshotRow | undefined
}

async function seededDb(threadId: string): Promise<Database> {
  const db = await createTestDb()
  seedThread(db, threadId)
  return db
}

describe('ModelRankingSnapshotRepo', () => {
  it('inserts an open pending first_shot snapshot with attribution and timestamps', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))

      const row = snapshot(db, 't1')
      expect(row?.status).toBe('pending')
      expect(row?.shot_category).toBe('first_shot')
      expect(row?.closed_at_ms).toBeNull()
      expect(row?.harness_id).toBe('pi')
      expect(row?.model_id).toBe('gpt-5')
      expect(row?.thinking_level).toBe('high')
      expect(row?.started_at).toBe(1_000)
      expect(row?.ended_at).toBe(46_000)
    } finally {
      destroyTestDb(db)
    }
  })

  it('upgrades an open snapshot to multi_shot without closing the window', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))
      const open = repo.openForThread('t1')
      expect(open?.shot_category).toBe('first_shot')

      repo.registerCompletedExchange(open?.id ?? '', 'still broken', 90_000, 90_000 + 24 * 3_600_000)
      const upgraded = snapshot(db, 't1')
      expect(upgraded?.shot_category).toBe('multi_shot')
      expect(upgraded?.follow_up_text).toBe('still broken')
      expect(upgraded?.ended_at).toBe(90_000)
      // The window stays open: grading happens once, at close.
      expect(upgraded?.closed_at_ms).toBeNull()
      expect(upgraded?.status).toBe('pending')
      expect(upgraded?.due_at_ms).toBe(90_000 + 24 * 3_600_000)
      expect(repo.openForThread('t1')).not.toBeNull()
    } finally {
      destroyTestDb(db)
    }
  })

  it('accumulates repeated follow-ups into the judge context', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))
      const open = repo.openForThread('t1')
      repo.registerCompletedExchange(open?.id ?? '', 'first follow-up', 90_000, 100_000)
      repo.registerCompletedExchange(open?.id ?? '', 'second follow-up', 130_000, 140_000)

      const row = snapshot(db, 't1')
      expect(row?.shot_category).toBe('multi_shot')
      expect(row?.follow_up_text).toBe('first follow-up\n\nsecond follow-up')
      expect(row?.ended_at).toBe(130_000)
      expect(row?.due_at_ms).toBe(140_000)
    } finally {
      destroyTestDb(db)
    }
  })

  it('pulls a claimed (processing) snapshot back to pending when a follow-up lands', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1', { dueAtMs: 500 }))
      const claimed = repo.claimDueBatch(1_000, 3)
      expect(claimed[0]?.status).toBe('processing')

      repo.registerCompletedExchange(claimed[0]?.id ?? '', 'late follow-up', 2_000, 2_000 + 86_400_000)
      const row = snapshot(db, 't1')
      expect(row?.status).toBe('pending')
      expect(row?.follow_up_text).toBe('late follow-up')

      // The in-flight drain can no longer score or delete the stale claim.
      expect(
        repo.deleteScoredInTransaction(claimed[0]?.id ?? '', claimed[0]?.claim_token ?? '', () => undefined)
      ).toBe(false)
    } finally {
      destroyTestDb(db)
    }
  })

  it('claims due snapshots atomically without overlapping drains sharing a row', async () => {
    const db = await seededDb('t1')
    try {
      seedThread(db, 't2')
      seedThread(db, 't3')
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1', { dueAtMs: 500 }))
      repo.insert(input('t2', { dueAtMs: 600 }))
      repo.insert(input('t3', { dueAtMs: 100_000 }))

      const claimed = repo.claimDueBatch(1_000, 3)
      expect(claimed).toHaveLength(2)
      expect(claimed.every((row) => row.status === 'processing')).toBe(true)

      // A second drain at the same instant cannot re-claim them.
      expect(repo.claimDueBatch(1_000, 3)).toHaveLength(0)
    } finally {
      destroyTestDb(db)
    }
  })

  it('deletes a scored snapshot and applies the score in one transaction', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))
      const claimed = repo.claimDueBatch(Date.now(), 3)
      expect(claimed).toHaveLength(1)
      expect(claimed[0]?.claim_token).toBeTruthy()

      let scoreApplied = 0
      const deleted = repo.deleteScoredInTransaction(
        claimed[0]?.id ?? '',
        claimed[0]?.claim_token ?? '',
        () => {
          scoreApplied += 1
        }
      )
      expect(deleted).toBe(true)
      expect(scoreApplied).toBe(1)
      expect(snapshot(db, 't1')).toBeUndefined()

      // A result from a previous claim generation can never score the row.
      repo.insert(input('t1'))
      const second = repo.claimDueBatch(Date.now(), 3)
      expect(
        repo.deleteScoredInTransaction(
          second[0]?.id ?? '',
          claimed[0]?.claim_token ?? '',
          () => {
            scoreApplied += 1
          }
        )
      ).toBe(false)
      expect(scoreApplied).toBe(1)
    } finally {
      destroyTestDb(db)
    }
  })

  it('retries failures with backoff and parks exhausted rows as failed for recovery', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))
      const claimed = repo.claimDueBatch(Date.now(), 3)
      const id = claimed[0]?.id ?? ''
      const token = claimed[0]?.claim_token ?? ''
      const base = 5 * 60_000

      repo.deferOrPark(id, token, 3, base, 1_000_000)
      const retried = snapshot(db, 't1')
      expect(retried?.status).toBe('pending')
      expect(retried?.attempt_count).toBe(1)
      expect(retried?.due_at_ms).toBe(1_000_000 + base)

      const second = repo.claimDueBatch(Date.now(), 3)
      const secondToken = second[0]?.claim_token ?? ''
      expect(secondToken).not.toBe(token)
      repo.deferOrPark(id, secondToken, 3, base, 2_000_000)
      const third = repo.claimDueBatch(Date.now(), 3)
      repo.deferOrPark(id, third[0]?.claim_token ?? '', 3, base, 3_000_000)
      const parked = snapshot(db, 't1')
      expect(parked?.status).toBe('failed')
      expect(parked?.attempt_count).toBe(3)

      // A stale generation token can neither defer nor park the parked row.
      repo.deferOrPark(id, token, 3, base, 3_500_000)
      expect(snapshot(db, 't1')?.status).toBe('failed')
      expect(snapshot(db, 't1')?.attempt_count).toBe(3)

      // Recovery requeue resets the backoff after the cooldown.
      repo.requeueFailedForRecovery(24 * 3_600_000, 3_000_000)
      expect(snapshot(db, 't1')?.status).toBe('failed')
      repo.requeueFailedForRecovery(24 * 3_600_000, 3_000_000 + 24 * 3_600_000)
      const recovered = snapshot(db, 't1')
      expect(recovered?.status).toBe('pending')
      expect(recovered?.attempt_count).toBe(0)
      expect(recovered?.due_at_ms).toBe(3_000_000 + 24 * 3_600_000)
    } finally {
      destroyTestDb(db)
    }
  })

  it('closes open snapshots when their threads are deleted', async () => {
    const db = await seededDb('t1')
    try {
      seedThread(db, 't2')
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1', { dueAtMs: 10_000_000 }))
      repo.insert(input('t2', { dueAtMs: 10_000_000 }))

      repo.closeForThreads(['t1'], 20_000)
      const closed = snapshot(db, 't1')
      expect(closed?.closed_at_ms).toBe(20_000)
      expect(closed?.due_at_ms).toBe(20_000)
      expect(snapshot(db, 't2')?.closed_at_ms).toBeNull()
    } finally {
      destroyTestDb(db)
    }
  })

  it('restart safety returns processing rows to the pending queue', async () => {
    const db = await seededDb('t1')
    try {
      const repo = new ModelRankingSnapshotRepo(db)
      repo.insert(input('t1'))
      repo.claimDueBatch(Date.now(), 3)
      repo.requeueStaleProcessing()
      expect(snapshot(db, 't1')?.status).toBe('pending')
    } finally {
      destroyTestDb(db)
    }
  })
})
