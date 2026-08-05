import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { StorageEngine } from '../../main/storage-engine'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import type { Database } from '../../main/database/database'
import type { EngineeringSpecContent, SpecContextReference, SpecValidationResult } from '../types'
import {
  SpecEngine,
  SpecEngineError,
  type NewSpecProvenance,
  type SpecApprovalValidator
} from './spec-engine'

const temporaryRoots: string[] = []
const temporaryDatabases: Database[] = []

async function createStorage(): Promise<{
  root: string
  projectRoot: string
  storage: StorageEngine
  db: Database
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-spec-engine-'))
  temporaryRoots.push(root)
  const storage = new StorageEngine(root)
  await storage.initialize()
  const projectRoot = join(root, 'project')
  await mkdir(projectRoot)
  const db = await createTestDb()
  temporaryDatabases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'Specification project',
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
    title: 'Specification Workflow',
    titleSource: 'default',
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

function content(problem = 'Build a reliable specification workflow'): EngineeringSpecContent {
  return {
    problem,
    resolutionSummary: 'Persist versioned specifications and gate approval.',
    phases: [
      {
        id: 'phase-1',
        title: 'Foundation',
        objective: 'Persist the workflow',
        checkpoints: [
          {
            id: 'checkpoint-1',
            description: 'Restart preserves the draft',
            evidence: 'Targeted persistence test'
          }
        ],
        fileOperations: [
          {
            path: 'src/lib/engines/spec-engine.ts',
            operation: 'create',
            reason: 'Own the specification lifecycle'
          }
        ],
        commit: 'feat(spec): persist workflow'
      }
    ],
    successCriteria: ['Approved versions cannot be edited'],
    testStrategy: 'Run focused lifecycle and restart tests.',
    documentationRequirements: ['Document the version layout.'],
    additionalInfo: 'Keep migration notes with the reviewed specification.',
    commitPattern: 'feat(spec): <scope>',
    constraints: ['Keep project data local'],
    risks: ['Concurrent edits']
  }
}

const provenance: NewSpecProvenance = {
  source: 'manual',
  actor: 'engineer'
}

function validResult(): SpecValidationResult {
  return { valid: true, issues: [] }
}

function deterministicEngine(
  storage: StorageEngine,
  db: Database,
  validateForApproval?: SpecApprovalValidator
): SpecEngine {
  let id = 0
  let timestamp = 1_000
  return new SpecEngine(storage, db, {
    validateForApproval,
    generateId: () => `entity-${++id}`,
    now: () => ++timestamp
  })
}

afterEach(async () => {
  temporaryDatabases.splice(0).forEach(destroyTestDb)
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('SpecEngine', () => {
  it('keeps spec state in config and mirrors agent-readable Markdown into .cio', async () => {
    const { root, projectRoot, storage, db } = await createStorage()
    const engine = deterministicEngine(storage, db, validResult)
    const spec = await engine.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance
    })

    expect(
      db.get<{ data: string }>(
        'SELECT data FROM spec_versions WHERE spec_id=? AND version=?',
        spec.id,
        1
      )
    ).toMatchObject({ data: expect.stringContaining(`"id":"${spec.id}"`) })
    await expect(
      import('fs/promises').then(({ readFile }) =>
        readFile(join(projectRoot, '.cio', 'specs', 'specification-workflow', 'spec.md'), 'utf8')
      )
    ).resolves.toContain(`# ${spec.id} — Specification v1`)
    await expect(
      import('fs/promises').then(({ access }) =>
        access(
          join(root, 'projects', 'project-1', '.cio', 'specs', 'specification-workflow', 'spec.md')
        )
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('persists draft, review, approval, workflow stage, and version history across restart', async () => {
    const { storage, db } = await createStorage()
    const engine = deterministicEngine(storage, db, validResult)

    const draft = await engine.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance
    })
    expect(draft).toMatchObject({
      id: 'entity-1',
      version: 1,
      status: 'draft',
      schemaVersion: 1
    })
    expect(await engine.getWorkflowState('project-1', 'thread-1')).toMatchObject({
      stage: 'spec_drafting',
      activeSpecId: draft.id,
      activeSpecVersion: 1
    })

    const edited = await engine.saveDraft(
      'project-1',
      'thread-1',
      draft.id,
      1,
      content('Clarified problem')
    )
    expect(edited.content.problem).toBe('Clarified problem')

    await engine.setReview('project-1', 'thread-1', draft.id, 1)
    const approved = await engine.approve('project-1', 'thread-1', draft.id, 1)
    expect(approved.status).toBe('approved')
    expect(await engine.getWorkflowState('project-1', 'thread-1')).toMatchObject({
      stage: 'spec_approved',
      approvedSpecVersion: 1
    })

    const next = await engine.createVersion({
      projectId: 'project-1',
      threadId: 'thread-1',
      specId: draft.id,
      content: content('Follow-up problem'),
      provenance: { source: 'agent', actor: 'planner', modelId: 'small-model' }
    })
    expect(next).toMatchObject({
      id: draft.id,
      version: 2,
      status: 'draft',
      provenance: { parentVersion: 1 }
    })

    const restarted = new SpecEngine(storage, db)
    expect(await restarted.listVersions('project-1', 'thread-1', draft.id)).toHaveLength(2)
    expect(await restarted.getLatest('project-1', 'thread-1', draft.id)).toEqual(next)
    expect(await restarted.getVersion('project-1', 'thread-1', draft.id, 1)).toEqual(approved)
    expect(await restarted.getWorkflowState('project-1', 'thread-1')).toMatchObject({
      stage: 'spec_drafting',
      activeSpecVersion: 2,
      approvedSpecVersion: 1
    })
  })

  it('persists annotations and selected context before approval', async () => {
    const { storage, db } = await createStorage()
    const engine = deterministicEngine(storage, db, validResult)
    const draft = await engine.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance
    })

    const annotated = await engine.addAnnotation('project-1', 'thread-1', draft.id, 1, {
      section: 'problem',
      body: 'State the user impact.',
      author: 'reviewer'
    })
    const annotationId = annotated.annotations[0].id
    const resolved = await engine.resolveAnnotation(
      'project-1',
      'thread-1',
      draft.id,
      1,
      annotationId
    )
    expect(resolved.annotations[0]).toMatchObject({ status: 'resolved' })

    const context: SpecContextReference[] = [
      {
        id: 'context-1',
        type: 'project_file',
        label: 'Project rules',
        path: 'AGENTS.md',
        contentHash: 'sha256:abc',
        selectedAt: 2_000
      }
    ]
    const selected = await engine.setContext('project-1', 'thread-1', draft.id, 1, context)
    expect(selected.context).toEqual(context)
  })

  it('requires successful injected validation and keeps approved versions immutable', async () => {
    const { storage, db } = await createStorage()
    const invalid: SpecValidationResult = {
      valid: false,
      issues: [
        {
          code: 'required',
          section: 'success_criteria',
          message: 'Add measurable success criteria.',
          path: 'content.successCriteria'
        }
      ]
    }
    const engine = deterministicEngine(storage, db, () => invalid)
    const draft = await engine.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance
    })
    await engine.setReview('project-1', 'thread-1', draft.id, 1)

    await expect(engine.approve('project-1', 'thread-1', draft.id, 1)).rejects.toMatchObject({
      code: 'validation_failed',
      validation: invalid
    })

    const approver = new SpecEngine(storage, db, { validateForApproval: validResult })
    const approved = await approver.approve('project-1', 'thread-1', draft.id, 1)
    expect(approved.status).toBe('approved')

    await expect(
      approver.saveDraft('project-1', 'thread-1', draft.id, 1, content('Mutation'))
    ).rejects.toMatchObject({ code: 'immutable' })
    await expect(
      approver.addAnnotation('project-1', 'thread-1', draft.id, 1, {
        section: 'problem',
        body: 'Mutation',
        author: 'reviewer'
      })
    ).rejects.toMatchObject({ code: 'immutable' })
    expect((await approver.getVersion('project-1', 'thread-1', draft.id, 1))?.content.problem).toBe(
      content().problem
    )
  })

  it('rejects approval without a validator, unsafe identifiers, and unsafe context paths', async () => {
    const { storage, db } = await createStorage()
    const engine = deterministicEngine(storage, db)
    const draft = await engine.createDraft({
      projectId: 'project-1',
      threadId: 'thread-1',
      content: content(),
      provenance
    })
    await engine.setReview('project-1', 'thread-1', draft.id, 1)
    await expect(engine.approve('project-1', 'thread-1', draft.id, 1)).rejects.toMatchObject({
      code: 'validator_missing'
    })

    await expect(engine.getLatest('../escape', 'thread-1', draft.id)).rejects.toBeInstanceOf(
      SpecEngineError
    )
    await expect(
      engine.setContext('project-1', 'thread-1', draft.id, 1, [
        {
          id: 'context-1',
          type: 'project_file',
          label: 'Unsafe',
          path: '../outside.md',
          selectedAt: 2_000
        }
      ])
    ).rejects.toMatchObject({ code: 'invalid_context_path' })
    await expect(
      engine.setContext('project-1', 'thread-1', draft.id, 1, [
        {
          id: 'context-1',
          type: 'memory',
          label: 'One',
          selectedAt: 2_000
        },
        {
          id: 'context-1',
          type: 'memory',
          label: 'Duplicate',
          selectedAt: 2_001
        }
      ])
    ).rejects.toMatchObject({ code: 'duplicate_id' })
  })
})
