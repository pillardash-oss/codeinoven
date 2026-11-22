import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeAttention } from '../../../src/main/system/background-work-state'
import type { Database } from '../../../src/main/database/database'
import { createTestDb, destroyTestDb } from '../database/test-helper'

/**
 * The menu bar exclamation, end to end against a real SQLite file.
 *
 * The predicate is the only thing that decides whether the icon carries its
 * exclamation, so these cases are the contract: a problem the user can reach
 * lights it, and a row no surface shows can never light it, because a light with
 * nothing to click is a light that never goes out.
 */

let db: Database

interface ThreadSeed {
  id: string
  status: string
  read?: 0 | 1
  archived?: 0 | 1
  coordinatorThreadId?: string
  assignmentRole?: string
  achievementRole?: string
  assignmentId?: string
}

let sequence = 0

function insertThread(seed: ThreadSeed): void {
  sequence += 1
  db.run(
    `INSERT INTO threads(
       id, project_id, provider_id, title, status, read, archived,
       coordinator_thread_id, assignment_role, achievement_role, assignment_id,
       created_at, updated_at, last_activity
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seed.id,
    'project1',
    'pi',
    `thread ${sequence}`,
    seed.status,
    seed.read ?? 1,
    seed.archived ?? 0,
    seed.coordinatorThreadId ?? null,
    seed.assignmentRole ?? null,
    seed.achievementRole ?? null,
    seed.assignmentId ?? null,
    1,
    1,
    1
  )
}

beforeEach(async () => {
  db = await createTestDb()
  db.run(
    `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
       VALUES ('project1', 'Project', '', 'local', 'pi', 'default', 1, 1)`
  )
})

afterEach(() => {
  destroyTestDb(db)
})

describe('computeAttention', () => {
  it('is quiet on a database where every thread is settled and read', async () => {
    insertThread({ id: 'done1', status: 'completed' })
    insertThread({ id: 'done2', status: 'interrupted', read: 0 })
    expect(await computeAttention(db)).toBe(false)
  })

  it('lights for a reachable gate', async () => {
    insertThread({ id: 'gate', status: 'awaiting_approval', read: 0 })
    expect(await computeAttention(db)).toBe(true)
  })

  it('lights for a thread waiting on a provider retry', async () => {
    insertThread({ id: 'paused', status: 'working-paused' })
    expect(await computeAttention(db)).toBe(true)
  })

  it('lights for a failure the user has not read', async () => {
    insertThread({ id: 'failed', status: 'failed', read: 0 })
    expect(await computeAttention(db)).toBe(true)
  })

  it('ignores a failure the user has already read', async () => {
    insertThread({ id: 'failed', status: 'failed', read: 1 })
    expect(await computeAttention(db)).toBe(false)
  })

  it('ignores a problem inside an archived thread', async () => {
    insertThread({ id: 'paused', status: 'working-paused', archived: 1 })
    insertThread({ id: 'gate', status: 'awaiting_approval', archived: 1 })
    expect(await computeAttention(db)).toBe(false)
  })

  it('counts a worker whose coordinator is still running', async () => {
    insertThread({ id: 'coordinator', status: 'executing', assignmentRole: 'coordinator' })
    insertThread({
      id: 'worker',
      status: 'working-paused',
      coordinatorThreadId: 'coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    expect(await computeAttention(db)).toBe(true)
  })

  it('ignores a worker left behind by a coordinator that already settled', async () => {
    insertThread({ id: 'coordinator', status: 'completed', assignmentRole: 'coordinator' })
    insertThread({
      id: 'paused-worker',
      status: 'working-paused',
      coordinatorThreadId: 'coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    insertThread({
      id: 'gate-worker',
      status: 'awaiting_approval',
      coordinatorThreadId: 'coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    insertThread({
      id: 'failed-worker',
      status: 'failed',
      read: 0,
      coordinatorThreadId: 'coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    expect(await computeAttention(db)).toBe(false)
  })

  it('still lights for a settled coordinator that failed unread', async () => {
    insertThread({ id: 'coordinator', status: 'failed', read: 0, assignmentRole: 'coordinator' })
    insertThread({
      id: 'worker',
      status: 'working-paused',
      coordinatorThreadId: 'coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    expect(await computeAttention(db)).toBe(true)
  })

  it('ignores a worker whose coordinator row is gone', async () => {
    insertThread({
      id: 'orphan',
      status: 'working-paused',
      coordinatorThreadId: 'deleted-coordinator',
      assignmentRole: 'worker',
      assignmentId: 'assignment1'
    })
    expect(await computeAttention(db)).toBe(false)
  })
})
