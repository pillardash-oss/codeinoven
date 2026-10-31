import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { PrdEngine, PrdEngineError } from '../../../src/lib/engines/prd-engine'
import { PRD_SECTION_DEFINITIONS } from '../../../src/lib/prd/prd-validation'
import type { PrdContent } from '../../../src/lib/types'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'

const roots: string[] = []
const databases: Database[] = []

function content(): PrdContent {
  return {
    title: 'Engineering Toolbox',
    summary: 'Separate lifecycle tools from attachments.',
    sections: PRD_SECTION_DEFINITIONS.map((definition) => ({
      ...definition,
      markdown: definition.id === 'open_questions' ? '' : `Defined ${definition.title}.`
    }))
  }
}

async function setup(): Promise<{ root: string; db: Database; engine: PrdEngine }> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-prd-'))
  roots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const storage = new StorageEngine(root)
  await storage.initialize()
  const db = await createTestDb()
  databases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'PRD project',
    source: 'local',
    path: projectRoot,
    providerId: 'openai',
    workflowId: 'default',
    threadLimit: 70,
    changeTrackingMode: 'manual',
    createdAt: 1,
    updatedAt: 1
  })
  new ThreadRepo(db).upsert({
    id: 'thread-1',
    projectId: 'project-1',
    providerId: 'openai',
    title: 'Engineering Toolbox',
    titleSource: 'manual',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: projectRoot
  })
  let id = 0
  let now = 10
  return {
    root: projectRoot,
    db,
    engine: new PrdEngine(storage, db, {
      generateId: () => `prd-${++id}`,
      now: () => ++now
    })
  }
}

afterEach(async () => {
  databases.splice(0).forEach(destroyTestDb)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PrdEngine', () => {
  it('versions, exports, finalizes, and preserves finalized content', async () => {
    const { root, db, engine } = await setup()
    expect(engine.ensureWorkflow('project-1', 'thread-1').stage).toBe('choice_pending')
    engine.chooseEntry('project-1', 'thread-1', 'start_prd')
    const draft = await engine.createDraft('project-1', 'thread-1', content(), {
      source: 'agent',
      actor: 'Product'
    })
    const revised = await engine.createVersion(
      'project-1',
      'thread-1',
      draft.id,
      { ...content(), summary: 'A revised summary.' },
      { source: 'agent', actor: 'Product' }
    )
    const finalized = await engine.finalize('project-1', 'thread-1', revised.id, revised.version)
    expect(finalized).toMatchObject({ status: 'finalized', version: 2 })
    expect(engine.listVersions('project-1', 'thread-1', draft.id)).toHaveLength(2)
    expect(
      new PrdEngine(new StorageEngine(root), db).getActive('project-1', 'thread-1')
    ).toMatchObject({
      finalizedInputHash: finalized.finalizedInputHash
    })
    await expect(
      readFile(
        join(root, '.cio/specs/engineering-toolbox/versions', `${draft.id}-v2-prd.md`),
        'utf-8'
      )
    ).resolves.toContain('## Product Requirements')
  })

  it('rejects cross-project access', async () => {
    const { engine } = await setup()
    expect(() => engine.ensureWorkflow('other-project', 'thread-1')).toThrow(PrdEngineError)
  })

  it('reads a deleted thread as empty state and still rejects writes', async () => {
    const { engine, db } = await setup()
    engine.ensureWorkflow('project-1', 'thread-1')
    engine.chooseEntry('project-1', 'thread-1', 'start_prd')
    const draft = await engine.createDraft('project-1', 'thread-1', content(), {
      source: 'agent',
      actor: 'Product'
    })
    // Deleting the thread cascades its PRD workflow and versions away. A view
    // that is still hydrating Engineering state must read that as nothing
    // instead of raising "Thread not found" at a thread it can only render
    // broken.
    db.run('DELETE FROM threads WHERE id = ?', 'thread-1')
    expect(engine.getWorkflowState('project-1', 'thread-1')).toBeNull()
    expect(engine.getActive('project-1', 'thread-1')).toBeNull()
    expect(engine.getVersion('project-1', 'thread-1', draft.id, draft.version)).toBeNull()
    expect(engine.listVersions('project-1', 'thread-1', draft.id)).toEqual([])
    // Writes stay strict: PRD state for a thread that is not there is a bug,
    // and it names the missing thread instead of blaming the workflow stage.
    expect(() => engine.ensureWorkflow('project-1', 'thread-1')).toThrow(PrdEngineError)
    await expect(
      engine.createVersion('project-1', 'thread-1', draft.id, content(), {
        source: 'agent',
        actor: 'Product'
      })
    ).rejects.toThrow('Thread not found')
  })
})
