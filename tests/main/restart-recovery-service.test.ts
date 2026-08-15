import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ThreadManager } from '../../src/lib/engines/thread-manager'
import type { ThreadStatus } from '../../src/lib/types'
import type { Database } from '../../src/main/database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'
import { ProjectRepo } from '../../src/main/database/repositories/project-repo'
import { CheckpointManager } from '../../src/main/checkpoint-manager'
import { RestartRecoveryService } from '../../src/main/restart-recovery-service'

const temporaryPaths: string[] = []
const testDatabases: Database[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

async function createDatabase(projectRoot: string): Promise<Database> {
  const database = await createTestDb()
  testDatabases.push(database)
  for (const id of ['project1', 'project2']) {
    new ProjectRepo(database).upsert({
      id,
      name: `Project ${id}`,
      path: projectRoot,
      source: 'local',
      providerId: 'provider1',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  return database
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  for (const database of testDatabases.splice(0)) destroyTestDb(database)
})

describe('RestartRecoveryService', () => {
  it('interrupts active checkpoints and threads while leaving inactive threads unchanged', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-recovery-project-')
    const database = await createDatabase(projectRoot)
    const threads = new ThreadManager(database)
    const checkpoints = new CheckpointManager(database)

    const planning = await threads.createThread({
      projectId: 'project1',
      providerId: 'provider1',
      title: 'Planning',
      workingDirectory: projectRoot
    })
    const completed = await threads.createThread({
      projectId: 'project1',
      providerId: 'provider1',
      title: 'Completed',
      workingDirectory: projectRoot
    })
    await threads.setStatus('project1', planning.id, 'planning')
    await threads.setStatus('project1', completed.id, 'completed')
    const activeCheckpoint = await checkpoints.beginTurn(
      'project1',
      planning.id,
      projectRoot,
      'Active planning turn',
      false
    )

    const result = await new RestartRecoveryService(database, checkpoints).recover()

    expect(result).toMatchObject({
      inspected: 2,
      failures: []
    })
    expect(result.recovered.map((thread) => thread.id)).toEqual([planning.id])
    expect((await threads.getThread('project1', planning.id))?.status).toBe('interrupted')
    expect((await threads.getThread('project1', completed.id))?.status).toBe('completed')
    expect((await checkpoints.get('project1', planning.id, activeCheckpoint.id))?.status).toBe(
      'interrupted'
    )
  })

  it('recovers an executing thread even when it has no active checkpoint', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-recovery-project-')
    const database = await createDatabase(projectRoot)
    const threads = new ThreadManager(database)
    const thread = await threads.createThread({
      projectId: 'project2',
      providerId: 'provider1',
      title: 'Executing'
    })
    await threads.setStatus('project2', thread.id, 'executing')

    const result = await new RestartRecoveryService(database).recover()
    const persisted = await threads.getThread('project2', thread.id)

    expect(result.failures).toEqual([])
    expect(result.recovered).toHaveLength(1)
    expect(persisted?.status as ThreadStatus | 'interrupted').toBe('interrupted')
  })
})
