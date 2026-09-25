import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../../src/main/database/database'
import type { Thread } from '../../src/lib/types'
import { ForeignRunService } from '../../src/main/chat/foreign-run-service'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import { createTestDb, destroyTestDb } from './database/test-helper'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() }
}))

/**
 * Which in-flight turns are "running somewhere else".
 *
 * The rule is the whole point of the notice: a ledger row whose owner process is
 * gone is an orphan the recovery pass will settle, so claiming it is running on
 * another instance would put a false card in front of the user. Liveness is the
 * injected probe, so both cases run without a second real app process.
 */

/** A pid that is not this process. */
const SIBLING_PID = 424_242
/** A pid no live instance answers for. */
const ORPHAN_PID = 424_243

const databases: Database[] = []

async function testDatabase(): Promise<Database> {
  const database = await createTestDb()
  databases.push(database)
  return database
}

function recordTurn(database: Database, threadId: string, ownerPid: number | null): void {
  database.run(
    'INSERT OR REPLACE INTO active_turns (project_id, thread_id, turn_id, owner_pid) VALUES (?, ?, ?, ?)',
    'project1',
    threadId,
    `turn-${threadId}`,
    ownerPid
  )
}

afterEach(() => {
  for (const database of databases.splice(0)) destroyTestDb(database)
})

describe('ForeignRunService', () => {
  it('reports nothing while no other instance is running', async () => {
    const database = await testDatabase()
    recordTurn(database, 'thread1', SIBLING_PID)
    const service = new ForeignRunService(database, {
      hasLiveSibling: () => false,
      isRunOwnerAlive: () => true
    })

    await expect(service.listForeignRuns()).resolves.toEqual([])
  })

  it('reports only the turns a live sibling process owns', async () => {
    const database = await testDatabase()
    recordTurn(database, 'mine', process.pid)
    recordTurn(database, 'sibling', SIBLING_PID)
    recordTurn(database, 'orphan', ORPHAN_PID)
    recordTurn(database, 'legacy', null)
    recordTurn(database, 'worker', SIBLING_PID)
    // A thread that belongs to a coordinated workflow is flagged, because a
    // transfer moves its whole group rather than the one thread.
    new ProjectRepo(database).upsert({
      id: 'project1',
      name: 'Project 1',
      path: '',
      source: 'local',
      providerId: 'provider1',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
    new ThreadRepo(database).upsert(workflowWorker('worker'))
    const service = new ForeignRunService(database, {
      hasLiveSibling: () => true,
      isRunOwnerAlive: (pid) => pid !== ORPHAN_PID
    })

    await expect(service.listForeignRuns()).resolves.toEqual([
      { projectId: 'project1', threadId: 'sibling', workflow: false },
      { projectId: 'project1', threadId: 'worker', workflow: true }
    ])
  })

  it('reports each thread once, ordered by project and thread', async () => {
    const database = await testDatabase()
    recordTurn(database, 'thread-b', SIBLING_PID)
    recordTurn(database, 'thread-a', SIBLING_PID)
    const service = new ForeignRunService(database, {
      hasLiveSibling: () => true,
      isRunOwnerAlive: () => true
    })

    await expect(service.listForeignRuns()).resolves.toEqual([
      { projectId: 'project1', threadId: 'thread-a', workflow: false },
      { projectId: 'project1', threadId: 'thread-b', workflow: false }
    ])
  })
})

/** A worker thread of a coordinated workflow, as the notice join reads it. */
function workflowWorker(id: string): Thread {
  return {
    id,
    projectId: 'project1',
    providerId: 'provider1',
    title: id,
    titleSource: 'default',
    status: 'executing',
    pinned: false,
    archived: false,
    read: true,
    assignmentId: 'assignment1',
    assignmentRole: 'worker',
    coordinatorThreadId: 'coordinator1',
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: ''
  }
}
