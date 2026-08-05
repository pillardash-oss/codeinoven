import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ThreadManager } from '../lib/engines/thread-manager'
import type { ThreadStatus } from '../lib/types'
import { CheckpointManager } from './checkpoint-manager'
import { RestartRecoveryService } from './restart-recovery-service'
import { StorageEngine } from './storage-engine'

const temporaryPaths: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('RestartRecoveryService', () => {
  it('interrupts active checkpoints and threads while leaving inactive threads unchanged', async () => {
    const storageRoot = await temporaryDirectory('codeinoven-recovery-storage-')
    const projectRoot = await temporaryDirectory('codeinoven-recovery-project-')
    const storage = new StorageEngine(storageRoot)
    await storage.initialize()
    const threads = new ThreadManager(storage)
    const checkpoints = new CheckpointManager(storage)

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

    const result = await new RestartRecoveryService(storage, threads, checkpoints).recover()

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
    const storageRoot = await temporaryDirectory('codeinoven-recovery-storage-')
    const storage = new StorageEngine(storageRoot)
    await storage.initialize()
    const threads = new ThreadManager(storage)
    const thread = await threads.createThread({
      projectId: 'project2',
      providerId: 'provider1',
      title: 'Executing'
    })
    await threads.setStatus('project2', thread.id, 'executing')

    const result = await new RestartRecoveryService(storage, threads).recover()
    const persisted = await threads.getThread('project2', thread.id)

    expect(result.failures).toEqual([])
    expect(result.recovered).toHaveLength(1)
    expect(persisted?.status as ThreadStatus | 'interrupted').toBe('interrupted')
  })
})
