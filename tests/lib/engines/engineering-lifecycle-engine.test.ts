import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import {
  deriveEngineeringLifecycleSwitchState,
  EngineeringLifecycleEngine,
  normalizeLifecycleStages
} from '../../../src/lib/engines/engineering-lifecycle-engine'
import type { EngineeringLifecycleState } from '../../../src/lib/types'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'

const databases: Database[] = []

async function setup(): Promise<{ db: Database; lifecycle: EngineeringLifecycleEngine }> {
  const db = await createTestDb()
  databases.push(db)
  new ProjectRepo(db).upsert({
    id: 'project-1',
    name: 'Lifecycle project',
    source: 'local',
    path: '/tmp/lifecycle-project',
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
    title: 'Lifecycle',
    titleSource: 'manual',
    status: 'created',
    pinned: false,
    archived: false,
    read: true,
    createdAt: 1,
    updatedAt: 1,
    lastActivity: 1,
    workingDirectory: '/tmp/lifecycle-project'
  })
  let now = 10
  let token = 0
  return {
    db,
    lifecycle: new EngineeringLifecycleEngine(db, {
      now: () => ++now,
      generateToken: () => `resume-${++token}`
    })
  }
}

afterEach(() => databases.splice(0).forEach(destroyTestDb))

describe('EngineeringLifecycleEngine', () => {
  it('applies cascade dependencies so Assignment and Achievement enable Spec', () => {
    expect(normalizeLifecycleStages(['assignment'])).toEqual(['spec', 'assignment'])
    expect(normalizeLifecycleStages(['achievement'])).toEqual(['spec', 'achievement'])
    // Achievement is a loop mode: it never drags Assignment in.
    expect(normalizeLifecycleStages(['achievement'])).not.toContain('assignment')
    expect(normalizeLifecycleStages(['prd', 'brainstorm'])).toEqual(['brainstorm', 'prd'])
  })

  it('derives every stage as selected and immutable while Auto Pilot is on', () => {
    const autopilot: EngineeringLifecycleState = {
      projectId: 'p',
      threadId: 't',
      selection: 'run_all',
      selectedStages: [],
      autopilot: true,
      completedStages: [],
      updatedAt: 1
    }
    expect(deriveEngineeringLifecycleSwitchState(autopilot, 'brainstorm')).toEqual({
      checked: true,
      disabled: true
    })
    expect(deriveEngineeringLifecycleSwitchState(autopilot, 'achievement')).toEqual({
      checked: true,
      disabled: true
    })
    const prd: EngineeringLifecycleState = {
      projectId: 'p',
      threadId: 't',
      selection: 'prd',
      selectedStages: ['prd'],
      autopilot: false,
      completedStages: [],
      updatedAt: 1
    }
    expect(deriveEngineeringLifecycleSwitchState(prd, 'prd')).toEqual({
      checked: true,
      disabled: false
    })
    expect(deriveEngineeringLifecycleSwitchState(prd, 'spec')).toEqual({
      checked: false,
      disabled: false
    })
  })

  it('does not mark history until the selected stage starts and never clears it', async () => {
    const { db, lifecycle } = await setup()
    expect(
      lifecycle.select('project-1', 'thread-1', { stages: ['spec'] }).startedAt
    ).toBeUndefined()
    const started = lifecycle.start('project-1', 'thread-1').state
    expect(started).toMatchObject({
      selection: 'spec',
      selectedStages: ['spec'],
      activeStage: 'spec'
    })
    expect(started.startedAt).toBeTypeOf('number')
    const terminal = lifecycle.advance('project-1', 'thread-1', {
      completedStage: 'spec',
      terminal: true
    })
    expect(terminal).toMatchObject({
      selection: 'none',
      selectedStages: ['spec'],
      completedStages: ['spec'],
      startedAt: started.startedAt
    })
    expect(new EngineeringLifecycleEngine(db).get('project-1', 'thread-1')).toMatchObject({
      selection: 'none',
      startedAt: started.startedAt
    })
  })

  it('turns each completed manual circle off and ends terminally after the last stage', async () => {
    const { lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', { stages: ['brainstorm', 'prd'] })
    lifecycle.start('project-1', 'thread-1')
    expect(lifecycle.completeStage('project-1', 'thread-1', 'brainstorm')).toMatchObject({
      selection: 'prd',
      selectedStages: ['prd'],
      activeStage: undefined,
      completedStages: ['brainstorm']
    })
    lifecycle.start('project-1', 'thread-1')
    expect(lifecycle.completeStage('project-1', 'thread-1', 'prd')).toMatchObject({
      selection: 'none',
      activeStage: undefined,
      completedStages: ['brainstorm', 'prd']
    })
  })

  it('starts Auto Pilot at Brainstorm and advances the whole chain', async () => {
    const { lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', { stages: [], autopilot: true })
    expect(lifecycle.get('project-1', 'thread-1')).toMatchObject({
      selection: 'run_all',
      autopilot: true,
      selectedStages: []
    })
    lifecycle.start('project-1', 'thread-1')
    expect(lifecycle.completeStage('project-1', 'thread-1', 'brainstorm')).toMatchObject({
      selection: 'run_all',
      activeStage: 'prd',
      completedStages: ['brainstorm']
    })
    expect(lifecycle.completeStage('project-1', 'thread-1', 'prd')).toMatchObject({
      selection: 'run_all',
      activeStage: 'spec',
      completedStages: ['brainstorm', 'prd']
    })
    expect(lifecycle.completeStage('project-1', 'thread-1', 'spec')).toMatchObject({
      selection: 'run_all',
      activeStage: 'assignment'
    })
    expect(lifecycle.completeStage('project-1', 'thread-1', 'assignment')).toMatchObject({
      selection: 'run_all',
      activeStage: 'achievement'
    })
    expect(lifecycle.completeStage('project-1', 'thread-1', 'achievement')).toMatchObject({
      selection: 'none'
    })
  })

  it('preserves startedAt after confirmed cancellation', async () => {
    const { lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', { stages: ['assignment'] })
    const started = lifecycle.start('project-1', 'thread-1').state
    const cancelled = lifecycle.cancel('project-1', 'thread-1')
    expect(cancelled).toMatchObject({
      selection: 'none',
      selectedStages: [],
      autopilot: false,
      startedAt: started.startedAt
    })
  })

  it('resumes Auto Pilot at a persisted gate and treats replayed tokens as idempotent', async () => {
    const { db, lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', { stages: [], autopilot: true })
    lifecycle.start('project-1', 'thread-1')
    const gated = lifecycle.advance('project-1', 'thread-1', {
      completedStage: 'brainstorm',
      gate: 'brainstorm_finalization'
    })
    expect(gated).toMatchObject({
      selection: 'run_all',
      completedStages: ['brainstorm'],
      humanGate: 'brainstorm_finalization',
      resumeToken: 'resume-1'
    })
    const reopened = new EngineeringLifecycleEngine(db)
    expect(reopened.get('project-1', 'thread-1')).toMatchObject({
      selection: 'run_all',
      autopilot: true,
      completedStages: ['brainstorm'],
      humanGate: 'brainstorm_finalization',
      resumeToken: 'resume-1',
      startedAt: gated.startedAt
    })
    expect(reopened.resume('project-1', 'thread-1', 'resume-1', 'continue', 'prd')).toMatchObject({
      idempotent: false,
      state: { activeStage: 'prd' }
    })
    expect(reopened.resume('project-1', 'thread-1', 'resume-1', 'continue', 'prd')).toMatchObject({
      idempotent: true,
      state: { activeStage: 'prd' }
    })
  })

  it('keeps the failed stage selected and resumes it without duplicating history', async () => {
    const { db, lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', { stages: [], autopilot: true })
    const started = lifecycle.start('project-1', 'thread-1').state
    const failed = lifecycle.fail('project-1', 'thread-1', 'Provider unavailable')

    expect(failed).toMatchObject({
      selection: 'run_all',
      autopilot: true,
      activeStage: 'brainstorm',
      humanGate: 'terminal_failure',
      failure: 'Provider unavailable',
      resumeToken: 'resume-1',
      startedAt: started.startedAt
    })

    const reopened = new EngineeringLifecycleEngine(db)
    const retried = reopened.retry('project-1', 'thread-1', 'resume-1')
    expect(retried).toMatchObject({
      selection: 'run_all',
      autopilot: true,
      activeStage: 'brainstorm',
      startedAt: started.startedAt
    })
    expect(retried.humanGate).toBeUndefined()
    expect(retried.failure).toBeUndefined()
  })

  it('derives a single legacy selection into the multi-select set on read', async () => {
    const { db, lifecycle } = await setup()
    const dbConnection = db.raw()
    dbConnection
      .prepare(
        'INSERT INTO engineering_lifecycle(project_id, thread_id, selection, selected_stages_json, autopilot, completed_stages_json, updated_at) VALUES(?,?,?,?,?,?,?)'
      )
      .run('project-1', 'thread-1', 'prd', '[]', 0, '[]', 5)
    expect(lifecycle.get('project-1', 'thread-1')).toMatchObject({
      selection: 'prd',
      selectedStages: ['prd'],
      autopilot: false
    })
  })
})
