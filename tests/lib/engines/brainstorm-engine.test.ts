import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { parseGeneratedBrainstormContent } from '../../../src/lib/brainstorm/brainstorm-validation'
import { exportBrainstormMarkdown } from '../../../src/lib/brainstorm/brainstorm-markdown'
import type { BrainstormContent } from '../../../src/lib/types'
import { BrainstormEngine, BrainstormEngineError } from '../../../src/lib/engines/brainstorm-engine'

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

async function setup(): Promise<{
  root: string
  projectRoot: string
  storage: StorageEngine
  db: Database
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-brainstorm-engine-'))
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
  return { root, projectRoot, storage, db }
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

describe('BrainstormEngine', () => {
  it('persists the entry choice and mirrors versioned Markdown under .cio/specs', async () => {
    const { projectRoot, storage, db } = await setup()
    const brainstorm = engine(storage, db)

    expect(brainstorm.ensureWorkflow('project-1', 'thread-1').stage).toBe('choice_pending')
    brainstorm.chooseEntry('project-1', 'thread-1', 'brainstorm')
    const draft = await brainstorm.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })

    expect(brainstorm.getWorkflowState('project-1', 'thread-1')).toMatchObject({
      entryChoice: 'brainstorm',
      stage: 'drafting',
      activeBrainstormId: draft.id,
      activeBrainstormVersion: 1
    })
    await expect(
      readFile(
        join(
          projectRoot,
          '.cio/specs/optional-brainstorm-stage/versions',
          `${draft.id}-v1-brainstorm.md`
        ),
        'utf-8'
      )
    ).resolves.toContain('## Proposed Direction')
    await expect(
      readFile(join(projectRoot, '.cio/specs/optional-brainstorm-stage/brainstorm.md'), 'utf-8')
    ).resolves.not.toContain('## Additional Info')
  })

  it('freezes a deterministic finalization input and keeps historical versions immutable', async () => {
    const { storage, db } = await setup()
    const brainstorm = engine(storage, db)
    brainstorm.chooseEntry('project-1', 'thread-1', 'brainstorm')
    const first = await brainstorm.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    const annotated = await brainstorm.addAnnotation('project-1', 'thread-1', first.id, 1, {
      section: 'goals',
      body: 'Also preserve restart behavior.',
      author: 'user'
    })
    expect(annotated.annotations).toHaveLength(1)
    const second = await brainstorm.createVersion({
      projectId: 'project-1',
      threadId: 'thread-1',
      brainstormId: first.id,
      baseVersion: first.version,
      content: content('Include restart recovery.'),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    expect(brainstorm.getVersion('project-1', 'thread-1', first.id, 1)?.status).toBe('superseded')
    await expect(
      brainstorm.saveDraft('project-1', 'thread-1', first.id, 1, content())
    ).rejects.toBeInstanceOf(BrainstormEngineError)
    await expect(
      brainstorm.createVersion({
        projectId: 'project-1',
        threadId: 'thread-1',
        brainstormId: first.id,
        baseVersion: first.version,
        content: content('A stale review must not overwrite the active version.'),
        provenance: { source: 'agent', actor: 'Sr. Engineer' }
      })
    ).rejects.toBeInstanceOf(BrainstormEngineError)

    const finalized = await brainstorm.finalize(
      'project-1',
      'thread-1',
      second.id,
      second.version,
      'Use this exact document for the specification.'
    )
    expect(finalized).toMatchObject({ status: 'finalized', finalizedInputHash: expect.any(String) })
    expect(finalized.finalizedInputHash).toHaveLength(64)
    expect(brainstorm.getWorkflowState('project-1', 'thread-1')).toMatchObject({
      stage: 'finalized',
      finalizedBrainstormVersion: 2,
      finalizedInputHash: finalized.finalizedInputHash
    })
    await expect(
      brainstorm.finalize('project-1', 'thread-1', second.id, second.version, 'retry')
    ).resolves.toEqual(finalized)
    await expect(
      brainstorm.saveDraft('project-1', 'thread-1', first.id, 2, content())
    ).rejects.toBeInstanceOf(BrainstormEngineError)
  })

  it('requires canonical core sections exactly once and omits empty additional info', () => {
    const ordinary = parseGeneratedBrainstormContent(content())
    expect(ordinary.sections).toHaveLength(6)
    expect(ordinary).not.toHaveProperty('prototypes')
    expect(exportBrainstormMarkdown({ content: ordinary })).not.toContain('Prototype')
    expect(() =>
      parseGeneratedBrainstormContent({
        ...content(),
        sections: content().sections.filter((section) => section.id !== 'goals')
      })
    ).toThrow('goals is required')
    expect(() =>
      parseGeneratedBrainstormContent({
        ...content(),
        sections: [...content().sections, content().sections[0]]
      })
    ).toThrow('at most once')
  })

  it('retains requested prototype metadata and renders it conditionally', () => {
    const parsed = parseGeneratedBrainstormContent({
      ...content(),
      prototypes: [
        {
          id: 'H1',
          fidelity: 'hifi',
          title: 'Refined toolbox',
          entryFile: 'index.html',
          artifactPath: '.cio/specs/toolbox/prototypes/H1',
          previewPath: 'cio/toolbox-h1/',
          contentHash: 'a'.repeat(64),
          createdAt: 10
        }
      ]
    })
    expect(parsed.prototypes).toMatchObject([{ id: 'H1', fidelity: 'hifi' }])
    expect(exportBrainstormMarkdown({ content: parsed })).toContain('## Prototypes')
  })

  it('persists the skip choice without creating a document', async () => {
    const { storage, db } = await setup()
    const brainstorm = engine(storage, db)
    expect(brainstorm.chooseEntry('project-1', 'thread-1', 'spec')).toMatchObject({
      entryChoice: 'spec',
      stage: 'skipped'
    })
    await expect(
      brainstorm.createDraft({
        projectId: 'project-1',
        threadId: 'thread-1',
        content: content(),
        provenance: { source: 'agent', actor: 'Sr. Engineer' }
      })
    ).rejects.toBeInstanceOf(BrainstormEngineError)
  })
})
