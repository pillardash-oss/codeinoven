import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { ProjectRepo } from '../../main/database/repositories/project-repo'
import { StorageEngine } from '../../main/storage-engine'
import type { AssignmentPlanContent } from '../types'
import type { Database } from '../../main/database/database'
import { ThreadManager } from './thread-manager'
import { AssignmentEngine } from './assignment-engine'
import {
  CUSTOM_WORKER_NAMES_FILE,
  FALLBACK_WORKER_NAMES,
  WORKER_NAMES_FILE
} from '../assignment/worker-names'

const SETTINGS = {
  harnessId: 'codex',
  providerId: 'openai',
  modelId: 'gpt-5.6',
  thinkingLevel: 'medium',
  permissionLevel: 'full_access',
  engineeringMode: true,
  assignmentMode: true
} as const

function content(): AssignmentPlanContent {
  return {
    title: 'Sparkling water website',
    summary: 'Build the site in dependency order.',
    phases: [
      {
        id: 'bootstrap',
        title: 'Bootstrap',
        description: 'Set up the foundation.'
      },
      {
        id: 'pages',
        title: 'Pages',
        description: 'Build the pages.'
      }
    ],
    tasks: [
      {
        id: 'setup',
        phaseId: 'bootstrap',
        title: 'Set up project',
        description: 'Initialize the project.',
        prompt: 'Initialize the project.',
        owner: 'senior',
        dependsOn: [],
        expectedFiles: ['package.json'],
        auditChecklist: ['Project installs'],
        status: 'planned'
      },
      {
        id: 'design',
        phaseId: 'bootstrap',
        title: 'Set up design guide',
        description: 'Create shared styles.',
        prompt: 'Create the design guide.',
        owner: 'worker',
        dependsOn: ['setup'],
        expectedFiles: ['src/app.css'],
        auditChecklist: ['Shared colors are defined'],
        status: 'planned'
      },
      {
        id: 'home',
        phaseId: 'pages',
        title: 'Create homepage',
        description: 'Create the homepage.',
        prompt: 'Create the homepage.',
        owner: 'worker',
        dependsOn: ['design'],
        expectedFiles: ['src/routes/+page.svelte'],
        auditChecklist: ['Homepage renders'],
        status: 'planned'
      }
    ]
  }
}

describe('AssignmentEngine', () => {
  let db: Database
  let root: string
  let projectPath: string
  let storage: StorageEngine
  let coordinatorId: string

  beforeEach(async () => {
    db = await createTestDb()
    root = await mkdtemp(join(tmpdir(), 'cio-assignment-'))
    projectPath = join(root, 'project')
    storage = new StorageEngine(join(root, 'config'))
    await storage.initialize()
    new ProjectRepo(db).upsert({
      id: 'project-1',
      name: 'Website',
      path: projectPath,
      source: 'local',
      providerId: 'openai',
      workflowId: 'default',
      threadLimit: 70,
      changeTrackingMode: 'manual',
      createdAt: 1,
      updatedAt: 1
    })
    const coordinator = await new ThreadManager(db).createThread({
      projectId: 'project-1',
      providerId: 'openai',
      title: 'Sparkling water website',
      settings: SETTINGS,
      workingDirectory: projectPath
    })
    coordinatorId = coordinator.id
    db.run(
      'INSERT INTO spec_versions(spec_id, version, project_id, thread_id, data, created_at) VALUES(?,?,?,?,?,?)',
      'spec-1',
      1,
      'project-1',
      coordinatorId,
      '{}',
      1
    )
  })

  afterEach(async () => {
    destroyTestDb(db)
    await rm(root, { recursive: true, force: true })
  })

  it('activates, keeps the coordinator steerable and scopes it', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })

    const activated = await engine.activate('project-1', coordinatorId)
    const coordinator = await new ThreadManager(db).getThread('project-1', coordinatorId)

    expect(activated.status).toBe('approved')
    expect(activated.content.tasks.map((task) => task.status)).toEqual([
      'ready',
      'blocked',
      'blocked'
    ])
    expect(coordinator?.userInputLocked).toBe(false)
    expect(coordinator?.assignmentRole).toBe('coordinator')
    expect(coordinator?.pinned).toBe(true)
    expect(coordinator?.scopeBucketId).toBe('assignment-assignment-1')

    const firstSnapshot = await engine.claimCoordinatorSnapshot(activated.id)
    const restartedEngine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'unused'
    )
    expect(firstSnapshot).toMatch(/^[a-f0-9]{64}$/u)
    expect(await restartedEngine.claimCoordinatorSnapshot(activated.id)).toBeNull()

    await engine.assignTask(activated.id, 'setup', 'assign-setup')
    expect(await restartedEngine.claimCoordinatorSnapshot(activated.id)).not.toBeNull()
    await restartedEngine.rememberCoordinatorSnapshot(activated.id)
    expect(await engine.claimCoordinatorSnapshot(activated.id)).toBeNull()
  })

  it('rebinds a draft assignment to a revised specification', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    db.run(
      'INSERT INTO spec_versions(spec_id, version, project_id, thread_id, data, created_at) VALUES(?,?,?,?,?,?)',
      'spec-1',
      2,
      'project-1',
      coordinatorId,
      '{}',
      2
    )
    const revisedContent = {
      ...content(),
      summary: 'Use the corrected execution graph.'
    }

    const synced = await engine.syncDraftToSpec(
      'project-1',
      coordinatorId,
      'spec-1',
      2,
      revisedContent,
      { source: 'agent', actor: 'Sr. Engineer' }
    )

    expect(synced.version).toBe(2)
    expect(synced.specVersion).toBe(2)
    expect(synced.content.summary).toBe('Use the corrected execution graph.')
    expect(synced.provenance.parentVersion).toBe(1)
  })

  it('assigns durable workers idempotently and disables engineering mode', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1',
      () => 0
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: {
        ...content(),
        tasks: content().tasks.map((task) =>
          task.id === 'design' ? { ...task, dependsOn: [] } : task
        )
      },
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)
    const persistedDefaultNames: unknown = JSON.parse(
      await readFile(join(root, 'config', WORKER_NAMES_FILE), 'utf-8')
    )
    expect(Array.isArray(persistedDefaultNames)).toBe(true)
    expect(persistedDefaultNames).toContain('aaron')
    await storage.saveCustomWorkerNames(['zipporah'])
    await storage.saveConfig({
      ...(await storage.getConfig()),
      agentDefaults: {
        syncFromThreadChanges: false,
        worker: {
          harnessId: 'opencode',
          providerId: 'anthropic',
          modelId: 'claude-sonnet'
        }
      }
    })

    const selectedModel = {
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5.6-mini',
      thinkingLevel: 'low' as const
    }
    const updatedBeforeAssignment = await engine.updateUnlinkedWorkerModel(
      'project-1',
      coordinatorId,
      'design',
      selectedModel
    )
    expect(
      updatedBeforeAssignment.content.tasks.find((task) => task.id === 'design')?.model
    ).toEqual(selectedModel)

    const first = await engine.assignTask('assignment-1', 'design', 'operation-1')
    const repeated = await engine.assignTask('assignment-1', 'design', 'operation-1')

    expect(await storage.getWorkerNames()).toHaveLength(10)
    expect(first.thread?.title).toBe('wrk-zipporah: Set up design guide')
    expect(first.thread?.settings?.engineeringMode).toBe(false)
    expect(first.thread?.settings?.assignmentMode).toBe(false)
    expect(first.thread?.settings).toMatchObject({
      harnessId: 'opencode',
      providerId: 'openai',
      modelId: 'gpt-5.6-mini',
      thinkingLevel: 'low'
    })
    expect(first.thread?.assignmentTaskId).toBe('design')
    expect(repeated.thread?.id).toBe(first.thread?.id)
    expect(repeated.idempotent).toBe(true)
    await expect(
      engine.updateUnlinkedWorkerModel('project-1', coordinatorId, 'design', selectedModel)
    ).rejects.toThrow('already been assigned')
    await Promise.all([
      rm(join(root, 'config', WORKER_NAMES_FILE), { force: true }),
      rm(join(root, 'config', CUSTOM_WORKER_NAMES_FILE), { force: true })
    ])
    expect(await storage.getWorkerNames()).toEqual(FALLBACK_WORKER_NAMES)
    await expect(
      engine.reportTask(
        'assignment-1',
        'design',
        first.thread?.id ?? '',
        {
          status: 'ready_for_audit',
          summary: 'Ready',
          evidence: ['Checks passed'],
          reportedAt: 100
        },
        'report-without-test-evidence'
      )
    ).rejects.toThrow('baseline and check')
    const checklist = await readFile(
      join(
        projectPath,
        '.cio/specs/sparkling-water-website/tasks',
        first.thread?.id ?? '',
        'audit-checklist.md'
      ),
      'utf-8'
    )
    expect(checklist).toContain('Shared colors are defined')
  })

  it('lets the coordinator rework an attention report in the same durable worker thread', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: {
        ...content(),
        tasks: content().tasks.map((task) =>
          task.id === 'design' ? { ...task, dependsOn: [] } : task
        )
      },
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)

    const assigned = await engine.assignTask('assignment-1', 'design', 'assign-design')
    const workerThreadId = assigned.thread?.id ?? ''
    const testEvidencePath = join(
      projectPath,
      '.cio/specs/sparkling-water-website/tasks',
      workerThreadId,
      'test'
    )
    await mkdir(testEvidencePath, { recursive: true })
    await Promise.all([
      writeFile(join(testEvidencePath, 'baseline.txt'), 'baseline passed'),
      writeFile(join(testEvidencePath, 'check.txt'), 'final check passed')
    ])
    await engine.reportTask(
      'assignment-1',
      'design',
      workerThreadId,
      {
        status: 'blocked',
        summary: 'The shared token contract needs correction.',
        evidence: ['bun run check failed'],
        reportedAt: 100
      },
      'report-design'
    )
    const reviewed = await engine.reviewTask(
      'assignment-1',
      'design',
      coordinatorId,
      {
        decision: 'rework',
        checklistResults: [
          {
            item: 'Shared colors are defined',
            passed: false,
            evidence: 'The token contract is incomplete.'
          }
        ],
        notes: 'Correct the token contract and rerun the check.',
        reviewedAt: 100
      },
      'review-design'
    )
    const reassigned = await engine.assignTask('assignment-1', 'design', 'reassign-design')

    expect(reviewed.task?.status).toBe('rework')
    expect(reassigned.thread?.id).toBe(workerThreadId)
    expect(reassigned.task?.status).toBe('running')
  })

  it('creates one durable linked auditor after Assignment completion', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1',
      () => 0
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)
    await expect(engine.ensureAuditorThread('project-1', coordinatorId, SETTINGS)).rejects.toThrow(
      'only after the Assignment completes'
    )

    const active = engine.getActive('project-1', coordinatorId)
    if (!active) throw new Error('Assignment should be active')
    db.run(
      'UPDATE assignment_workflow SET status=? WHERE project_id=? AND coordinator_thread_id=?',
      'completed',
      'project-1',
      coordinatorId
    )
    db.run(
      'UPDATE assignment_versions SET data=? WHERE assignment_id=? AND version=?',
      JSON.stringify({ ...active, status: 'completed', completedAt: 100, updatedAt: 100 }),
      active.id,
      active.version
    )

    const first = await engine.ensureAuditorThread('project-1', coordinatorId, SETTINGS)
    const second = await engine.ensureAuditorThread('project-1', coordinatorId, SETTINGS)
    const completed = engine.getActive('project-1', coordinatorId)

    expect(first.id).toBe(second.id)
    expect(first.title).toBe('audit-aaron: Sparkling water website')
    expect(first.assignmentId).toBe('assignment-1')
    expect(first.assignmentRole).toBeUndefined()
    expect(first.coordinatorThreadId).toBe(coordinatorId)
    expect(first.scopeBucketId).toBe('assignment-assignment-1')
    expect(first.workingDirectory).toBe(projectPath)
    expect(first.settings).toMatchObject({
      permissionLevel: 'auto_review',
      engineeringMode: false,
      assignmentMode: false,
      loopMode: false
    })
    expect(completed?.auditorThreadId).toBe(first.id)
  })

  it('persists audited completion and enables post-audit rework workloads', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1',
      () => 0
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)
    const active = engine.getActive('project-1', coordinatorId)
    if (!active) throw new Error('Assignment should be active')
    const completedPlan = {
      ...active,
      status: 'completed' as const,
      completedAt: 100,
      auditCycle: { status: 'available' as const, availableAt: 100 },
      content: {
        ...active.content,
        tasks: active.content.tasks.map((task) => ({ ...task, status: 'completed' as const }))
      }
    }
    db.run(
      'UPDATE assignment_workflow SET status=? WHERE project_id=? AND coordinator_thread_id=?',
      'completed',
      'project-1',
      coordinatorId
    )
    db.run(
      'UPDATE assignment_versions SET data=? WHERE assignment_id=? AND version=?',
      JSON.stringify(completedPlan),
      active.id,
      active.version
    )

    const running = await engine.beginAuditCycle('project-1', coordinatorId)
    const reportReady = await engine.reportAuditCycle('project-1', coordinatorId, 'audit-1', 1)

    expect(running.auditCycle?.status).toBe('running')
    expect(reportReady.auditCycle).toMatchObject({
      status: 'report_ready',
      reportId: 'audit-1',
      reportVersion: 1
    })
    const available = await engine.makeAuditAvailable('project-1', coordinatorId)
    expect(available.auditCycle?.status).toBe('available')
    expect(available.auditCycle?.reportId).toBe('audit-1')
    await engine.beginAuditCycle('project-1', coordinatorId)
    const reaudited = await engine.reportAuditCycle('project-1', coordinatorId, 'audit-2', 2)
    const accepted = await engine.completeAuditCycle('project-1', coordinatorId)
    expect(accepted.status).toBe('completed')
    expect(accepted.auditCycle?.status).toBe('completed')

    db.run(
      'UPDATE assignment_versions SET data=? WHERE assignment_id=? AND version=?',
      JSON.stringify({ ...accepted, auditCycle: { ...reaudited.auditCycle } }),
      active.id,
      active.version
    )
    const planning = await engine.beginAuditRework('project-1', coordinatorId)
    expect(planning.version).toBe(1)
    expect(planning.auditCycle?.status).toBe('planning_rework')

    const proposed = await engine.proposeAuditReworkDraft(
      'project-1',
      coordinatorId,
      { ...content(), title: 'Audit corrections' },
      { source: 'agent', actor: 'Sr. Engineer' }
    )
    expect(proposed.version).toBe(2)
    expect(proposed.status).toBe('draft')
    expect(proposed.auditCycle).toMatchObject({
      status: 'awaiting_rework_approval',
      reworkAssignmentVersion: 2
    })
    expect(engine.listVersions(proposed.id)).toHaveLength(2)

    const reworking = await engine.activate('project-1', coordinatorId)
    expect(reworking.version).toBe(2)
    expect(reworking.status).toBe('approved')
    expect(reworking.auditCycle?.status).toBe('reworking')
  })

  it('re-dispatches a failed worker task to a fresh worker thread', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: {
        ...content(),
        tasks: content().tasks.map((task) =>
          task.id === 'design' ? { ...task, dependsOn: [] } : task
        )
      },
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)

    const first = await engine.assignTask('assignment-1', 'design', 'assign-design')
    const firstThreadId = first.thread?.id ?? ''

    await engine.reportTask(
      'assignment-1',
      'design',
      firstThreadId,
      { status: 'failed', summary: 'crashed', evidence: [], reportedAt: 100 },
      'report-fail'
    )
    const failed = await engine.reviewTask(
      'assignment-1',
      'design',
      coordinatorId,
      {
        decision: 'fail',
        checklistResults: [
          { item: 'Shared colors are defined', passed: false, evidence: 'missing' }
        ],
        notes: 'Worker crashed; re-dispatch.',
        reviewedAt: 100
      },
      'review-fail'
    )
    expect(failed.task?.status).toBe('failed')

    const redispatch = await engine.assignTask('assignment-1', 'design', 'redispatch')
    expect(redispatch.task?.status).toBe('running')
    expect(redispatch.task?.report).toBeUndefined()
    expect(redispatch.task?.review).toBeUndefined()
    expect(redispatch.thread?.id).not.toBe(firstThreadId)
    expect(redispatch.thread?.assignmentTaskId).toBe('design')

    const abandoned = await new ThreadManager(db).getThread('project-1', firstThreadId)
    expect(abandoned?.assignmentId).toBeUndefined()
    expect(abandoned?.assignmentRole).toBeUndefined()
    expect(abandoned?.assignmentTaskId).toBeUndefined()
    expect(abandoned?.coordinatorThreadId).toBeUndefined()
  })

  it('lets the coordinator re-review a failed task as rework', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: {
        ...content(),
        tasks: content().tasks.map((task) =>
          task.id === 'design' ? { ...task, dependsOn: [] } : task
        )
      },
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)
    const assigned = await engine.assignTask('assignment-1', 'design', 'assign-design')
    await engine.reportTask(
      'assignment-1',
      'design',
      assigned.thread?.id ?? '',
      { status: 'failed', summary: 'crashed', evidence: [], reportedAt: 100 },
      'report-fail'
    )
    await engine.reviewTask(
      'assignment-1',
      'design',
      coordinatorId,
      {
        decision: 'fail',
        checklistResults: [],
        notes: 'crash',
        reviewedAt: 100
      },
      'review-fail'
    )
    const rework = await engine.reviewTask(
      'assignment-1',
      'design',
      coordinatorId,
      {
        decision: 'rework',
        checklistResults: [
          { item: 'Shared colors are defined', passed: false, evidence: 'missing' }
        ],
        notes: 'Re-dispatch after crash.',
        reviewedAt: 101
      },
      'review-rework'
    )
    expect(rework.task?.status).toBe('rework')
    const reassigned = await engine.assignTask('assignment-1', 'design', 'reassign')
    expect(reassigned.task?.status).toBe('running')
  })

  it('persists and restores Assignment API capability tokens across engine instances', async () => {
    const engine = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'assignment-1'
    )
    await engine.createDraft({
      projectId: 'project-1',
      coordinatorThreadId: coordinatorId,
      specId: 'spec-1',
      specVersion: 1,
      content: content(),
      provenance: { source: 'agent', actor: 'Sr. Engineer' }
    })
    await engine.activate('project-1', coordinatorId)

    engine.saveApiPort(54916)
    expect(engine.loadApiPort()).toBe(54916)
    engine.saveApiCapability('token-a', {
      role: 'worker',
      assignmentId: 'assignment-1',
      threadId: 'thread-1',
      taskId: 'design'
    })
    engine.saveApiCapability('token-b', {
      role: 'coordinator',
      assignmentId: 'assignment-1',
      threadId: coordinatorId
    })

    const restarted = new AssignmentEngine(
      storage,
      db,
      () => 100,
      () => 'unused'
    )
    expect(restarted.loadApiPort()).toBe(54916)
    const restored = restarted.loadApiCapabilities()
    expect(restored.get('token-a')).toEqual({
      role: 'worker',
      assignmentId: 'assignment-1',
      threadId: 'thread-1',
      taskId: 'design'
    })
    expect(restored.get('token-b')).toEqual({
      role: 'coordinator',
      assignmentId: 'assignment-1',
      threadId: coordinatorId
    })
    restarted.removeApiCapabilitiesForAssignment('assignment-1')
    expect(restarted.loadApiCapabilities().size).toBe(0)
  })
})
