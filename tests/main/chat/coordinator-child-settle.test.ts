import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settleAbandonedCoordinatorChildren } from '../../../src/main/chat/coordinator-child-settle'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import type { Database } from '../../../src/main/database/database'
import type { ThreadStatus } from '../../../src/lib/types'
import { createTestDb, destroyTestDb } from '../database/test-helper'

/**
 * Closing out the children of a settled orchestration.
 *
 * The sweep is the writer behind the menu bar predicate and the reason a
 * finished orchestration stops costing anything: every case below is a row that
 * used to survive its coordinator as an invisible parked thread.
 */

let db: Database
let manager: ThreadManager
let clearRetry: ReturnType<typeof vi.fn<(sessionId: string) => void>>

interface ChildSeed {
  id: string
  status: ThreadStatus
  coordinatorThreadId?: string
  read?: 0 | 1
  archived?: 0 | 1
  sessionId?: string
  assignmentRole?: string
  lastActivity?: number
}

const PROJECT = 'project1'
const COORDINATOR = 'coordinator1'

beforeEach(async () => {
  db = await createTestDb()
  manager = new ThreadManager(db)
  clearRetry = vi.fn<(sessionId: string) => void>()
  db.run(
    `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
       VALUES (?, 'Project', '', 'local', 'pi', 'default', 1, 1)`,
    PROJECT
  )
  insertThread({ id: COORDINATOR, status: 'completed', assignmentRole: 'coordinator' })
})

afterEach(() => {
  destroyTestDb(db)
})

function insertThread(seed: ChildSeed): void {
  db.run(
    `INSERT INTO threads(
       id, project_id, provider_id, title, status, read, archived, session_id,
       coordinator_thread_id, assignment_role, assignment_id,
       created_at, updated_at, last_activity
     ) VALUES (?, ?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
    seed.id,
    PROJECT,
    seed.id,
    seed.status,
    seed.read ?? 0,
    seed.archived ?? 0,
    seed.sessionId ?? null,
    seed.coordinatorThreadId ?? null,
    seed.assignmentRole ?? 'worker',
    seed.coordinatorThreadId === undefined ? null : 'assignment1',
    seed.lastActivity ?? 1000
  )
}

function rowOf(id: string): { status: string; read: number; lastActivity: number } {
  const row = db.get<{ status: string; read: number; last_activity: number }>(
    `SELECT status, read, last_activity FROM threads WHERE id = ?`,
    id
  )
  if (!row) throw new Error(`thread ${id} is missing`)
  return { status: row.status, read: row.read, lastActivity: row.last_activity }
}

async function sweep(): Promise<number> {
  return settleAbandonedCoordinatorChildren({
    database: db,
    threadManager: manager,
    clearRetry
  })
}

describe('settleAbandonedCoordinatorChildren', () => {
  it('closes out every parked child of a settled coordinator', async () => {
    insertThread({ id: 'paused', status: 'working-paused', coordinatorThreadId: COORDINATOR })
    insertThread({ id: 'gate', status: 'awaiting_approval', coordinatorThreadId: COORDINATOR })
    insertThread({ id: 'draft', status: 'created', coordinatorThreadId: COORDINATOR })
    insertThread({ id: 'spec', status: 'spec', coordinatorThreadId: COORDINATOR })

    expect(await sweep()).toBe(4)

    for (const id of ['paused', 'gate', 'draft', 'spec']) {
      expect(rowOf(id)).toMatchObject({ status: 'interrupted', read: 1 })
    }
  })

  it('clears the armed retry of a paused child', async () => {
    insertThread({
      id: 'paused',
      status: 'working-paused',
      coordinatorThreadId: COORDINATOR,
      sessionId: 'session1'
    })

    await sweep()

    expect(clearRetry).toHaveBeenCalledWith('session1')
  })

  it('takes the unread flag off a failure without inventing a second error', async () => {
    insertThread({
      id: 'failed',
      status: 'failed',
      read: 0,
      coordinatorThreadId: COORDINATOR
    })

    expect(await sweep()).toBe(1)
    expect(rowOf('failed')).toMatchObject({ status: 'failed', read: 1 })
  })

  it('leaves the coordinator alone and does not resurface it', async () => {
    insertThread({ id: 'paused', status: 'working-paused', coordinatorThreadId: COORDINATOR })
    const coordinatorBefore = rowOf(COORDINATOR)

    await sweep()

    expect(rowOf(COORDINATOR)).toEqual(coordinatorBefore)
    // The row keeps the activity it had: a bookkeeping settle must not pull a
    // finished orchestration back to the top of the list.
    expect(rowOf('paused').lastActivity).toBe(1000)
  })

  it('leaves children of a coordinator that is still running alone', async () => {
    db.run(`UPDATE threads SET status = 'executing' WHERE id = ?`, COORDINATOR)
    insertThread({ id: 'paused', status: 'working-paused', coordinatorThreadId: COORDINATOR })

    expect(await sweep()).toBe(0)
    expect(rowOf('paused')).toMatchObject({ status: 'working-paused', read: 0 })
  })

  it('leaves a working child to settle its own turn', async () => {
    insertThread({ id: 'worker', status: 'executing', coordinatorThreadId: COORDINATOR })

    expect(await sweep()).toBe(0)
    expect(rowOf('worker')).toMatchObject({ status: 'executing' })
  })

  it('leaves an archived child to the user who put it away', async () => {
    insertThread({
      id: 'paused',
      status: 'working-paused',
      coordinatorThreadId: COORDINATOR,
      archived: 1
    })

    expect(await sweep()).toBe(0)
  })

  it('closes out a child whose coordinator row is gone', async () => {
    insertThread({ id: 'orphan', status: 'working-paused', coordinatorThreadId: 'deleted' })

    expect(await sweep()).toBe(1)
    expect(rowOf('orphan')).toMatchObject({ status: 'interrupted', read: 1 })
  })

  it('is idempotent, so running it on every update is free', async () => {
    insertThread({ id: 'paused', status: 'working-paused', coordinatorThreadId: COORDINATOR })

    expect(await sweep()).toBe(1)
    expect(await sweep()).toBe(0)
    expect(rowOf('paused')).toMatchObject({ status: 'interrupted', read: 1 })
  })

  it('leaves a settled child that already read as settled as it was', async () => {
    insertThread({
      id: 'done',
      status: 'interrupted',
      read: 1,
      coordinatorThreadId: COORDINATOR
    })

    expect(await sweep()).toBe(0)
  })
})
