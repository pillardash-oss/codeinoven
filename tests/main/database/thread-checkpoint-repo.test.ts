import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from './test-helper'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { ThreadCheckpointRepo } from '../../../src/main/database/repositories/thread-checkpoint-repo'
import type { Database } from '../../../src/main/database/database'

/**
 * A context checkpoint is the record of one harness session ending and the next
 * one taking over the same thread. These lock in the two properties the engine
 * relies on: the sequence is per thread and gapless enough to order windows, and
 * a checkpoint only ever describes a session that has closed.
 */

const databases: Database[] = []

afterEach(() => {
  databases.splice(0).forEach(destroyTestDb)
})

async function createRepo(): Promise<{ repo: ThreadCheckpointRepo }> {
  const db = await createTestDb()
  databases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'Checkpoint project',
    path: '/tmp/project-1',
    source: 'local',
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: 1,
    updatedAt: 1
  })
  const threads = new ThreadRepo(db)
  for (const id of ['thread-1', 'thread-2']) {
    threads.upsert({
      id,
      projectId: 'project-1',
      providerId: 'openai',
      title: id,
      titleSource: 'auto',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      createdAt: 1,
      updatedAt: 1,
      lastActivity: 1,
      workingDirectory: '/tmp/project-1'
    })
  }
  return { repo: new ThreadCheckpointRepo(db) }
}

describe('ThreadCheckpointRepo', () => {
  it('numbers checkpoints per thread', async () => {
    const { repo } = await createRepo()
    const first = repo.create({
      threadId: 'thread-1',
      kind: 'auto',
      harnessId: 'pi',
      sessionId: 's1',
      createdAt: 100
    })
    const second = repo.create({
      threadId: 'thread-1',
      kind: 'harness-switch',
      harnessId: 'codex',
      sessionId: 's2',
      createdAt: 200
    })
    const otherThread = repo.create({
      threadId: 'thread-2',
      kind: 'auto',
      harnessId: 'pi',
      sessionId: 's9',
      createdAt: 300
    })
    expect([first.sequence, second.sequence, otherThread.sequence]).toEqual([1, 2, 1])
  })

  it('records what finalizing the boundary added', async () => {
    const { repo } = await createRepo()
    const checkpoint = repo.create({
      threadId: 'thread-1',
      kind: 'auto',
      harnessId: 'pi',
      sessionId: 's1',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4'
    })
    expect(checkpoint.closedAt).toBeUndefined()
    repo.close(checkpoint.id, {
      nextSessionId: 's2',
      boundaryMessageId: 'msg-9',
      boundaryCreatedAt: 1234,
      tokensBefore: 180_000,
      contextWindow: 200_000
    })
    const [stored] = await repo.listViaWorker('thread-1')
    expect(stored).toMatchObject({
      id: checkpoint.id,
      sequence: 1,
      kind: 'auto',
      harnessId: 'pi',
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      sessionId: 's1',
      nextSessionId: 's2',
      boundaryMessageId: 'msg-9',
      boundaryCreatedAt: 1234,
      tokensBefore: 180_000,
      contextWindow: 200_000
    })
    // A closed checkpoint always says when it closed.
    expect(stored?.closedAt).toBeGreaterThan(0)
  })

  it('lists the newest windows first and reads them back bounded', async () => {
    const { repo } = await createRepo()
    for (let index = 1; index <= 4; index += 1) {
      repo.create({
        threadId: 'thread-1',
        kind: 'auto',
        harnessId: 'pi',
        sessionId: `s${index}`,
        createdAt: index * 100
      })
    }
    const newest = await repo.listViaWorker('thread-1', 2)
    expect(newest.map((checkpoint) => checkpoint.sequence)).toEqual([4, 3])
    const latest = await repo.latestViaWorker('thread-1')
    expect(latest?.sequence).toBe(4)
    expect(await repo.latestViaWorker('thread-2')).toBeUndefined()
  })

  it('finds the checkpoint a session ended at', async () => {
    const { repo } = await createRepo()
    repo.create({
      threadId: 'thread-1',
      kind: 'auto',
      harnessId: 'pi',
      sessionId: 's1',
      createdAt: 100
    })
    expect((await repo.bySessionViaWorker('s1'))?.threadId).toBe('thread-1')
    expect(await repo.bySessionViaWorker('missing')).toBeUndefined()
  })

  it('keeps a fork parent id on the lineage row', async () => {
    const { repo } = await createRepo()
    const fork = repo.create({
      threadId: 'thread-2',
      kind: 'fork',
      harnessId: 'pi',
      sessionId: 's-fork',
      parentThreadId: 'thread-1'
    })
    const [stored] = await repo.listViaWorker('thread-2')
    expect(stored).toMatchObject({ id: fork.id, kind: 'fork', parentThreadId: 'thread-1' })
  })
})
