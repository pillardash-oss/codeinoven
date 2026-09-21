import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../../src/main/database/database'
import { ForeignRunService } from '../../src/main/chat/foreign-run-service'
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
    const service = new ForeignRunService(database, {
      hasLiveSibling: () => true,
      isRunOwnerAlive: (pid) => pid !== ORPHAN_PID
    })

    await expect(service.listForeignRuns()).resolves.toEqual([
      { projectId: 'project1', threadId: 'sibling' }
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
      { projectId: 'project1', threadId: 'thread-a' },
      { projectId: 'project1', threadId: 'thread-b' }
    ])
  })
})
