import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { Database } from '../../src/main/database/database'
import { ThreadRepo } from '../../src/main/database/repositories/thread-repo'
import { validateCreateThreadInput, validateThreadUpdateInput } from '../../src/main/ipc/validation/threads'
import type { Thread, ThreadDispatchOrigin } from '../../src/lib/types'
import { ASSISTANT_SPACE_ID } from '../../src/lib/types'
import { createTestDb, destroyTestDb } from './database/test-helper'

/**
 * The bound scope as it survives on the row.
 *
 * The pair is the whole point of the column: a task that lives on the Assistant
 * view and works in a project checkout has to come back from SQLite naming the
 * same project and scope it was bound to. These cases go through the real
 * repository, so a mapping mistake cannot hide behind a stub.
 */

const PROJECT_ID = 'project1'
const ASSISTANT_TASK_ID = 'assistant-task-1'
const ASSISTANT_ID = 'assistant1'

let db: Database
let repo: ThreadRepo

beforeEach(async () => {
  db = await createTestDb()
  repo = new ThreadRepo(db)
  const a = await db.executeViaWorker(
    `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
       VALUES (?, ?, ?, 'local', 'pi', 'default', ?, ?)`,
    [PROJECT_ID, 'Project', join(process.cwd(), '.cio', 'tmp', 'bound-scope-project'), 1, 1]
  )
  if (!a.ok) throw new Error(`project insert failed: ${a.error}`)
  await db.executeViaWorker(
    `INSERT INTO projects(id, name, path, source, provider_id, workflow_id, created_at, updated_at)
       VALUES (?, ?, '', 'local', 'pi', 'default', ?, ?)`,
    [ASSISTANT_SPACE_ID, 'Assistant', 1, 1]
  )
  const b = await db.executeViaWorker(
    `INSERT INTO assistants(id, name, knowledge, created_at, updated_at) VALUES (?, ?, '', ?, ?)`,
    [ASSISTANT_ID, 'Scout', 1, 1]
  )
  if (!b.ok) throw new Error(`assistant insert failed: ${b.error}`)
})

afterEach(() => {
  destroyTestDb(db)
})

function assistantTask(extra: Partial<Thread> = {}): Thread {
  const now = Date.now()
  return {
    id: ASSISTANT_TASK_ID,
    projectId: ASSISTANT_SPACE_ID,
    providerId: 'pi',
    title: 'Weekly digest',
    titleSource: 'default',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    assistantId: ASSISTANT_ID,
    createdAt: now,
    updatedAt: now,
    lastActivity: now,
    workingDirectory: '',
    ...extra
  }
}

async function readBack(thread: Thread): Promise<Thread> {
  await repo.upsertViaWorker(thread)
  const stored = await repo.getViaWorker(thread.id)
  if (!stored) throw new Error('thread did not round-trip')
  return stored
}

describe('thread bound scope persistence', () => {
  it('binds, reads back, rebinds and clears a scope', async () => {
    const bound = await readBack(
      assistantTask({
        boundScope: {
          projectId: PROJECT_ID,
          scopeBucketId: 'worktree-a',
          homeProjectId: ASSISTANT_SPACE_ID
        }
      })
    )
    expect(bound.boundScope).toEqual({
      projectId: PROJECT_ID,
      scopeBucketId: 'worktree-a',
      homeProjectId: ASSISTANT_SPACE_ID
    })

    // A rebind replaces the pair outright rather than merging with it.
    const rebound = await readBack({
      ...bound,
      boundScope: { projectId: 'project2', scopeBucketId: 'default' }
    })
    expect(rebound.boundScope).toEqual({ projectId: 'project2', scopeBucketId: 'default' })

    // Clearing returns the task to unbound behaviour, with no half-written pair.
    const cleared = await readBack({ ...rebound, boundScope: undefined })
    expect(cleared.boundScope).toBeUndefined()
  })

  it('reads a half-written pair as unbound rather than resolving a checkout', async () => {
    await readBack(assistantTask())
    await db.executeViaWorker(
      'UPDATE threads SET bound_scope_project_id = ? WHERE id = ?',
      [PROJECT_ID, ASSISTANT_TASK_ID]
    )
    const stored = await repo.getViaWorker(ASSISTANT_TASK_ID)
    expect(stored?.boundScope).toBeUndefined()
  })

  it('round-trips the run base and the dispatch origin', async () => {
    const origin: ThreadDispatchOrigin = {
      assistantId: ASSISTANT_ID,
      assistantName: 'Scout',
      initiatorProjectId: ASSISTANT_SPACE_ID,
      initiatorThreadId: 'initiator-1',
      at: 42
    }
    const stored = await readBack(
      assistantTask({
        runBase: {
          sha: 'a'.repeat(40),
          projectId: PROJECT_ID,
          scopeBucketId: 'default',
          recordedAt: 41
        },
        dispatchOrigin: origin
      })
    )
    expect(stored.runBase?.sha).toBe('a'.repeat(40))
    expect(stored.dispatchOrigin).toEqual(origin)
  })

  it('drops a corrupt run base instead of inventing a range', async () => {
    await readBack(assistantTask())
    await db.executeViaWorker('UPDATE threads SET run_base = ? WHERE id = ?', [
      '{"sha":42}',
      ASSISTANT_TASK_ID
    ])
    const stored = await repo.getViaWorker(ASSISTANT_TASK_ID)
    expect(stored?.runBase).toBeUndefined()
  })
})

describe('bound scope validation', () => {
  it('accepts a well-formed pair on create', () => {
    const validated = validateCreateThreadInput({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'A task',
      boundScope: { projectId: PROJECT_ID, scopeBucketId: 'default' }
    })
    expect(validated.boundScope).toEqual({ projectId: PROJECT_ID, scopeBucketId: 'default' })
  })

  it('rejects a pair missing its scope', () => {
    expect(() =>
      validateCreateThreadInput({
        projectId: ASSISTANT_SPACE_ID,
        providerId: 'pi',
        title: 'A task',
        boundScope: { projectId: PROJECT_ID }
      })
    ).toThrow(/both a project and a scope/u)
  })

  it('rejects a pair missing its project', () => {
    expect(() =>
      validateThreadUpdateInput({ boundScope: { scopeBucketId: 'default' } })
    ).toThrow(/both a project and a scope/u)
  })

  it('rejects an unknown field on the pair', () => {
    expect(() =>
      validateThreadUpdateInput({
        boundScope: { projectId: PROJECT_ID, scopeBucketId: 'default', path: '/tmp/project' }
      })
    ).toThrow(/bound scope/u)
  })
})
