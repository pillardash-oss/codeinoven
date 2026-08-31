import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CheckpointManager,
  MAX_CHECKPOINT_FAILURE_LENGTH,
  type TurnCheckpoint
} from '../../src/main/storage/checkpoint-manager'
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

  it('shows an edit located past the diff window head instead of an empty diff', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    // Push the change far beyond the 64KB diff-window head.
    const padding = '0123456789\n'.repeat(7000)
    const original = `${padding}MARKER_BEFORE\n`
    const changed = `${padding}MARKER_AFTER\n`

    await writeFile(join(projectRoot, 'large.txt'), original, 'utf-8')
    const before = await manager.beginTurn(
      'project1',
      'thread1',
      projectRoot,
      'Large file edit',
      false
    )
    await writeFile(join(projectRoot, 'large.txt'), changed, 'utf-8')
    await manager.completeTurn('project1', 'thread1', before.id, projectRoot, 'completed')

    const diff = await manager.getFileDiff('project1', 'thread1', before.id, 'large.txt')
    expect(diff.truncated).toBe(true)
    expect(diff.before).toContain('MARKER_BEFORE')
    expect(diff.after).toContain('MARKER_AFTER')
    expect(diff.before).not.toBe(diff.after)
  })

  it('recovers changes from legacy completed checkpoints with empty change arrays', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const database = await createTestDb()
    testDatabases.push(database)
    const manager = new CheckpointManager(database)
    await writeFile(join(projectRoot, 'existing.txt'), 'before', 'utf-8')

    const checkpoint = await manager.beginTurn(
      'project1',
      'thread1',
      projectRoot,
      'Legacy checkpoint',
      false
    )
    await writeFile(join(projectRoot, 'existing.txt'), 'after', 'utf-8')
    await manager.completeTurn('project1', 'thread1', checkpoint.id, projectRoot, 'completed')

    const row = database.get<{ data: string }>(
      'SELECT data FROM turn_checkpoints WHERE turn_id = ?',
      checkpoint.id
    )
    if (!row) throw new Error('Expected persisted checkpoint row')
    const legacy = JSON.parse(row.data) as TurnCheckpoint
    legacy.changes = []
    delete legacy.changeFilterApplied
    database.run(
      'UPDATE turn_checkpoints SET data = ? WHERE turn_id = ?',
      JSON.stringify(legacy),
      checkpoint.id
    )

    const recovered = await manager.get('project1', 'thread1', checkpoint.id)
    expect(recovered?.changes.map((change) => `${change.kind}:${change.path}`)).toEqual([
      'modified:existing.txt'
    ])
    expect((await manager.list('project1', 'thread1'))[0]?.changes).toHaveLength(1)
    await expect(
      manager.getFileDiff('project1', 'thread1', checkpoint.id, 'existing.txt')
    ).resolves.toMatchObject({
      path: 'existing.txt',
      kind: 'modified',
      before: 'before',
      after: 'after'
    })
  })

  it('returns the head of a newly created file and marks it truncated when large', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    const content = 'a'.repeat(70_000)

    const before = await manager.beginTurn(
      'project1',
      'thread1',
      projectRoot,
      'Create large file',
      false
    )
    await writeFile(join(projectRoot, 'created-large.txt'), content, 'utf-8')
    await manager.completeTurn('project1', 'thread1', before.id, projectRoot, 'completed')

    const diff = await manager.getFileDiff('project1', 'thread1', before.id, 'created-large.txt')
    expect(diff).toMatchObject({ kind: 'created', binary: false, truncated: true })
    expect(diff.after).toBe('a'.repeat(64 * 1024))
    expect(diff.before).toBeUndefined()
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

  it('rebinds the active checkpoint source to a steer mid-turn', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()

    const checkpoint = await manager.beginTurn(
      'project4',
      'thread4',
      projectRoot,
      'Initial prompt',
      false,
      'msg_original'
    )
    expect(checkpoint.sourceMessageId).toBe('msg_original')

    // A steer arrives while the turn is still active.
    await manager.rebindActiveSource('project4', 'thread4', 'msg_steer')
    const rebound = await manager.get('project4', 'thread4', checkpoint.id)
    expect(rebound?.sourceMessageId).toBe('msg_steer')

    // Re-bind is a no-op once the turn is completed.
    await manager.completeTurn('project4', 'thread4', checkpoint.id, projectRoot, 'completed')
    await manager.rebindActiveSource('project4', 'thread4', 'msg_after')
    const completed = await manager.get('project4', 'thread4', checkpoint.id)
    expect(completed?.sourceMessageId).toBe('msg_steer')
  })

  it('diffs an in-flight turn against disk without persisting anything', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    await writeFile(join(projectRoot, 'tracked.txt'), 'before', 'utf-8')

    const checkpoint = await manager.beginTurn(
      'project5',
      'thread5',
      projectRoot,
      'Live turn',
      false
    )
    await writeFile(join(projectRoot, 'tracked.txt'), 'after', 'utf-8')
    await writeFile(join(projectRoot, 'new.txt'), 'created', 'utf-8')

    const modified = await manager.getLiveFileDiff(
      'project5',
      'thread5',
      checkpoint.id,
      'tracked.txt'
    )
    expect(modified).toMatchObject({
      path: 'tracked.txt',
      kind: 'modified',
      binary: false,
      before: 'before',
      after: 'after'
    })

    const created = await manager.getLiveFileDiff('project5', 'thread5', checkpoint.id, 'new.txt')
    expect(created).toMatchObject({ path: 'new.txt', kind: 'created', after: 'created' })

    // Paths outside the project root are rejected even mid-turn.
    await expect(
      manager.getLiveFileDiff('project5', 'thread5', checkpoint.id, '../outside.txt')
    ).rejects.toThrow('outside this checkpoint')

    // Completion freezes the checkpoint: live diffs stop resolving.
    await manager.completeTurn('project5', 'thread5', checkpoint.id, projectRoot, 'completed')
    await expect(
      manager.getLiveFileDiff('project5', 'thread5', checkpoint.id, 'tracked.txt')
    ).rejects.toThrow('no longer active')
  })

  it('finalizes an active turn as completed when the harness demonstrably finished', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    await writeFile(join(projectRoot, 'existing.txt'), 'before', 'utf-8')

    const checkpoint = await manager.beginTurn(
      'project2',
      'thread2',
      projectRoot,
      'Completed before stop',
      false
    )
    await writeFile(join(projectRoot, 'existing.txt'), 'after', 'utf-8')

    const completed = await manager.markActiveCompleted('project2', 'thread2')

    expect(completed).toMatchObject({ id: checkpoint.id, status: 'completed' })
    expect(completed?.failure).toBeUndefined()
    expect(completed?.changes.map((change) => change.path)).toContain('existing.txt')
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

    await writeFile(join(projectRoot, 'second.txt'), 'later-edit', 'utf-8')
    await expect(
      manager.rollbackPaths('project3', 'thread3', checkpoint.id, ['second.txt'])
    ).rejects.toThrow('changed after this checkpoint')
  })

  it('keeps sub-agent family changes on the parent card and drops foreign edits', async () => {
    const setup = async (): Promise<{
      manager: CheckpointManager
      database: Database
      projectRoot: string
      parent: TurnCheckpoint
    }> => {
      const projectRoot = await temporaryDirectory('codeinoven-project-')
      const database = await createTestDb()
      testDatabases.push(database)
      const manager = new CheckpointManager(database)
      await writeFile(join(projectRoot, 'mine.txt'), 'before', 'utf-8')
      await writeFile(join(projectRoot, 'worker.txt'), 'before', 'utf-8')
      await writeFile(join(projectRoot, 'unrelated.txt'), 'before', 'utf-8')

      const parent = await manager.beginTurn(
        'project1',
        'coordinator',
        projectRoot,
        'Parent turn',
        false
      )

      // A worker sub-agent thread of this coordinator completes a turn inside
      // the window. The sub-turn file diff can be empty when snapshots are
      // cached, so seed its recorded changes the way a real editing turn does.
      const workerTurn = await manager.beginTurn(
        'project1',
        'worker-a',
        projectRoot,
        'Worker turn',
        false
      )
      await writeFile(join(projectRoot, 'worker.txt'), 'worker-edit', 'utf-8')
      const workerDone = await manager.completeTurn(
        'project1',
        'worker-a',
        workerTurn.id,
        projectRoot,
        'completed'
      )
      database.run(
        'UPDATE turn_checkpoints SET data = ? WHERE turn_id = ?',
        JSON.stringify({
          ...workerDone,
          changes: [{ path: 'worker.txt', kind: 'modified', binary: false }]
        }),
        workerDone.id
      )

      // An unrelated concurrent thread also completes a turn inside the window.
      const otherTurn = await manager.beginTurn(
        'project1',
        'stranger',
        projectRoot,
        'Other turn',
        false
      )
      await writeFile(join(projectRoot, 'unrelated.txt'), 'other-thread', 'utf-8')
      const otherDone = await manager.completeTurn(
        'project1',
        'stranger',
        otherTurn.id,
        projectRoot,
        'completed'
      )
      database.run(
        'UPDATE turn_checkpoints SET data = ? WHERE turn_id = ?',
        JSON.stringify({
          ...otherDone,
          changes: [{ path: 'unrelated.txt', kind: 'modified', binary: false }]
        }),
        otherDone.id
      )

      // The parent edits its own file too.
      await writeFile(join(projectRoot, 'mine.txt'), 'parent-edit', 'utf-8')
      return { manager, database, projectRoot, parent }
    }

    // With family knowledge, the worker sub-agent's edit stays on the parent
    // card while the truly foreign thread's path drops.
    const family = await setup()
    const familyDone = await family.manager.completeTurn(
      'project1',
      'coordinator',
      family.parent.id,
      family.projectRoot,
      'completed',
      undefined,
      new Set(['mine.txt', 'worker.txt', 'unrelated.txt']),
      {
        precisePaths: new Set(['mine.txt']),
        ownThreadIds: new Set(['coordinator', 'worker-a'])
      }
    )
    expect(familyDone.changes.map((change) => change.path)).toEqual(['mine.txt', 'worker.txt'])

    // Without family knowledge, the same snapshot hides the worker sub-agent's
    // work entirely — the regression this test locks in.
    const plain = await setup()
    const plainDone = await plain.manager.completeTurn(
      'project1',
      'coordinator',
      plain.parent.id,
      plain.projectRoot,
      'completed'
    )
    expect(plainDone.changes.map((change) => change.path)).toEqual(['mine.txt'])
  })

  it('bounds the failure text written to a checkpoint', async () => {
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const manager = await testCheckpointManager()
    const before = await manager.beginTurn('project1', 'thread1', projectRoot, 'Failed turn', false)
    const transcript = 'Fixed, validated, and committed. '.repeat(200)
    const failed = await manager.markFailed('project1', 'thread1', before.id, transcript)
    const failure = failed.failure
    if (failure === undefined) throw new Error('markFailed did not record failure text')
    expect(failure.length).toBeLessThanOrEqual(MAX_CHECKPOINT_FAILURE_LENGTH + 1)
    expect(failure.endsWith('…')).toBe(true)
  })

  it('strips overlong legacy failure text when reading a checkpoint', async () => {
    const database = await createTestDb()
    testDatabases.push(database)
    const manager = new CheckpointManager(database)
    const projectRoot = await temporaryDirectory('codeinoven-project-')
    const before = await manager.beginTurn('projectX', 'threadX', projectRoot, 'Poisoned turn', false)
    await manager.completeTurn('projectX', 'threadX', before.id, projectRoot, 'completed')
    // Simulate a legacy poisoned row saved before the failure bound existed.
    const poisoned: TurnCheckpoint = {
      ...(await manager.get('projectX', 'threadX', before.id))!,
      failure: 'Fixed, validated, and committed. ## What went wrong '.repeat(80)
    }
    database.run(
      'INSERT OR REPLACE INTO turn_checkpoints(turn_id, project_id, thread_id, data, created_at) VALUES(?, ?, ?, ?, ?)',
      [poisoned.id, poisoned.projectId, poisoned.threadId, JSON.stringify(poisoned), poisoned.createdAt]
    )
    const listed = (await manager.list('projectX', 'threadX')).find(
      (checkpoint) => checkpoint.id === before.id
    )
    expect(listed?.failure).toBeUndefined()
    expect((await manager.get('projectX', 'threadX', before.id))?.failure).toBeUndefined()
  })
})
