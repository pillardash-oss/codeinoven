import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { parseGeneratedBrainstormContent } from '../../../src/lib/brainstorm/brainstorm-validation'
import type { BrainstormContent } from '../../../src/lib/types'
import { BrainstormEngine } from '../../../src/lib/engines/brainstorm-engine'

/**
 * Regression guard for brainstorm SESSION REPORT persistence under
 * `.cio/specs/<feature-slug>/versions/` after the seeded-refresh trim. The
 * agent's scoped write is the persistence channel for report revisions, while
 * the `brainstorm_document` contract + validation/repair loop stay
 * authoritative — this test proves the on-disk output contract never regresses.
 */

const temporaryRoots: string[] = []
const temporaryDatabases: Database[] = []

function content(direction = 'Build the smallest dependable workflow.'): BrainstormContent {
  return {
    title: 'Optional planning stage',
    summary: 'Agree on intent before writing the engineering specification.',
    sections: [
      { id: 'context', title: 'Context', markdown: 'The request needs discovery.' },
      { id: 'goals', title: 'Goals', markdown: '- Preserve user intent' },
      { id: 'decisions', title: 'Decisions', markdown: '- Persist every choice' },
      { id: 'open_questions', title: 'Open Questions', markdown: '- Which deployment target?' },
      { id: 'constraints', title: 'Constraints', markdown: '- Never auto-advance' },
      { id: 'proposed_direction', title: 'Proposed Direction', markdown: direction },
      { id: 'additional_info', title: 'Additional Info', markdown: '' }
    ]
  }
}

async function setup(): Promise<{ projectRoot: string; storage: StorageEngine; db: Database }> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-brainstorm-persistence-'))
  temporaryRoots.push(root)
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const storage = new StorageEngine(root)
  await storage.initialize()
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'Brainstorm project',
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
    title: 'Optional Brainstorm Stage',
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
  return { projectRoot, storage, db }
}

function engine(storage: StorageEngine, db: Database): BrainstormEngine {
  let id = 0
  let now = 100
  return new BrainstormEngine(storage, db, {
    generateId: () => `entity-${++id}`,
    now: () => ++now
  })
}

afterEach(async () => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('brainstorm session-report persistence', () => {
  it('lands the session report under .cio/specs/<feature-slug>/versions/ with *-brainstorm.md naming', async () => {
    const { projectRoot, storage, db } = await setup()
    const brainstorm = engine(storage, db)
    brainstorm.chooseEntry('project-1', 'thread-1', 'brainstorm')
    const draft = await brainstorm.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })

    const versionsDir = join(projectRoot, '.cio', 'specs', 'optional-brainstorm-stage', 'versions')
    const files = await readdir(versionsDir)
    expect(files).toContain(`${draft.id}-v1-brainstorm.md`)
    expect(files).toContain(`${draft.id}-v1-brainstorm.md`)

    const report = await readFile(join(versionsDir, `${draft.id}-v1-brainstorm.md`), 'utf-8')
    expect(report).toContain(`# Optional planning stage`)
    expect(report).toContain('## Session Snapshot')
    expect(report).toContain('## Proposed Direction')

    // A revision bumped while drafting is persisted as a new *-brainstorm.md version.
    await brainstorm.createVersion({
      projectId: 'project-1',
      threadId: 'thread-1',
      brainstormId: draft.id,
      baseVersion: draft.version,
      content: content('Include restart recovery.'),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    const filesAfterRevision = await readdir(versionsDir)
    expect(filesAfterRevision).toContain(`${draft.id}-v2-brainstorm.md`)
    const revision = await readFile(join(versionsDir, `${draft.id}-v2-brainstorm.md`), 'utf-8')
    expect(revision).toContain('Include restart recovery.')
  })

  it('keeps validation authoritative: malformed session reports never persist', async () => {
    const { projectRoot, storage, db } = await setup()
    const brainstorm = engine(storage, db)
    brainstorm.chooseEntry('project-1', 'thread-1', 'brainstorm')

    // Missing a canonical core section is rejected before any write.
    const malformed: BrainstormContent = {
      ...content(),
      sections: content().sections.filter((section) => section.id !== 'goals')
    }
    expect(() => parseGeneratedBrainstormContent(malformed)).toThrow('goals is required')

    await expect(
      brainstorm.createDraft({
        projectId: 'project-1',
        threadId: 'thread-1',
        content: malformed,
        provenance: { source: 'agent', actor: 'Sr. Engineer' }
      })
    ).rejects.toThrow('goals is required')

    const versionsDir = join(projectRoot, '.cio', 'specs', 'optional-brainstorm-stage', 'versions')
    await expect(readdir(versionsDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finalizes a report to an immutable, hash-pinned version (repair loop resolves)', async () => {
    const { projectRoot, storage, db } = await setup()
    const brainstorm = engine(storage, db)
    brainstorm.chooseEntry('project-1', 'thread-1', 'brainstorm')
    const draft = await brainstorm.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    const v2 = await brainstorm.createVersion({
      projectId: 'project-1',
      threadId: 'thread-1',
      brainstormId: draft.id,
      baseVersion: draft.version,
      content: content('Buy the obsolete stack.'),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    const finalized = await brainstorm.finalize('project-1', 'thread-1', v2.id, v2.version, 'ship it')
    expect(finalized.status).toBe('finalized')
    expect(finalized.finalizedInputHash).toHaveLength(64)

    const versionsDir = join(projectRoot, '.cio', 'specs', 'optional-brainstorm-stage', 'versions')
    const files = await readdir(versionsDir)
    expect(files).toContain(`${draft.id}-v2-brainstorm.md`)
  })
})
