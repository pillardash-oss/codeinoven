import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CheckpointManager } from '../../src/main/checkpoint-manager'
import type { Database } from '../../src/main/database/database'
import { createTestDb, destroyTestDb } from './database/test-helper'

const temporaryPaths: string[] = []
const testDatabases: Database[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  for (const database of testDatabases.splice(0)) destroyTestDb(database)
})

async function testCheckpointManager(): Promise<CheckpointManager> {
  const database = await createTestDb()
  testDatabases.push(database)
  return new CheckpointManager(database)
}

describe('CheckpointManager', () => {
  it('persists a turn diff and selectively rolls it back', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    await writeFile(join(projectRoot, 'existing.txt'), 'before', 'utf-8')

    const before = await manager.beginTurn('project1', 'thread1', projectRoot, 'Test turn', false)
    await writeFile(join(projectRoot, 'existing.txt'), 'after', 'utf-8')
    await writeFile(join(projectRoot, 'created.txt'), 'created', 'utf-8')
    const completed = await manager.completeTurn(
      'project1',
      'thread1',
      before.id,
      projectRoot,
      'completed'
    )

    expect(completed.changes.map((change) => `${change.kind}:${change.path}`)).toEqual([
      'created:created.txt',
      'modified:existing.txt'
    ])
    expect((await manager.list('project1', 'thread1'))[0]?.id).toBe(before.id)
    await expect(
      manager.getFileDiff('project1', 'thread1', before.id, 'existing.txt')
    ).resolves.toMatchObject({
      path: 'existing.txt',
      kind: 'modified',
      binary: false,
      before: 'before',
      after: 'after',
      truncated: false
    })

    const failed = await manager.markFailed(
      'project1',
      'thread1',
      before.id,
      'Post-turn contract validation failed'
    )
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'Post-turn contract validation failed'
    })

    const rolledBack = await manager.rollback('project1', 'thread1', before.id)
    expect(rolledBack.status).toBe('rolled_back')
    await expect(readFile(join(projectRoot, 'created.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(projectRoot, 'existing.txt'), 'utf-8')).resolves.toBe('before')
  })

  it('marks an active turn as interrupted for restart recovery', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()

    const checkpoint = await manager.beginTurn(
      'project2',
      'thread2',
      projectRoot,
      'Interrupted',
      false
    )
    const interrupted = await manager.markActiveInterrupted('project2', 'thread2')

    expect(interrupted).toMatchObject({ id: checkpoint.id, status: 'interrupted' })
  })

  it('restores only selected paths and rejects files changed after capture', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    await writeFile(join(projectRoot, 'first.txt'), 'before-first', 'utf-8')
    await writeFile(join(projectRoot, 'second.txt'), 'before-second', 'utf-8')

    const checkpoint = await manager.beginTurn(
      'project3',
      'thread3',
      projectRoot,
      'Selective restore',
      false
    )
    await writeFile(join(projectRoot, 'first.txt'), 'after-first', 'utf-8')
    await writeFile(join(projectRoot, 'second.txt'), 'after-second', 'utf-8')
    await manager.completeTurn('project3', 'thread3', checkpoint.id, projectRoot, 'completed')

    const partial = await manager.rollbackPaths('project3', 'thread3', checkpoint.id, ['first.txt'])
    expect(partial).toMatchObject({
      status: 'completed',
      rolledBackPaths: ['first.txt']
    })
    await expect(readFile(join(projectRoot, 'first.txt'), 'utf-8')).resolves.toBe('before-first')
    await expect(readFile(join(projectRoot, 'second.txt'), 'utf-8')).resolves.toBe('after-second')

    await writeFile(join(projectRoot, 'second.txt'), 'later-edit', 'utf-8')
    await expect(
      manager.rollbackPaths('project3', 'thread3', checkpoint.id, ['second.txt'])
    ).rejects.toThrow('changed after this checkpoint')
  })
})
