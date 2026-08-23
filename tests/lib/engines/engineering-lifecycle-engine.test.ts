import { afterEach, describe, expect, it } from 'vitest'
import type { Database } from '../../../src/main/database/database'
import { ProjectRepo } from '../../../src/main/database/repositories/project-repo'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { EngineeringLifecycleEngine } from '../../../src/lib/engines/engineering-lifecycle-engine'
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
  it('does not mark history until the selected stage starts and never clears it', async () => {
    const { db, lifecycle } = await setup()
    expect(lifecycle.select('project-1', 'thread-1', 'spec').startedAt).toBeUndefined()
    const started = lifecycle.start('project-1', 'thread-1').state
    expect(started).toMatchObject({ selection: 'spec', activeStage: 'spec' })
    expect(started.startedAt).toBeTypeOf('number')
    const terminal = lifecycle.advance('project-1', 'thread-1', {
      completedStage: 'spec',
      terminal: true
    })
    expect(terminal).toMatchObject({
      selection: 'none',
      completedStages: ['spec'],
      startedAt: started.startedAt
    })
    expect(new EngineeringLifecycleEngine(db).get('project-1', 'thread-1')).toMatchObject({
      selection: 'none',
      startedAt: started.startedAt
    })
  })

  it('resumes Run all at a persisted gate and treats replayed tokens as idempotent', async () => {
    const { db, lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', 'run_all')
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

  it('preserves startedAt after confirmed cancellation', async () => {
    const { lifecycle } = await setup()
    lifecycle.select('project-1', 'thread-1', 'assignment')
    const started = lifecycle.start('project-1', 'thread-1').state
    const cancelled = lifecycle.cancel('project-1', 'thread-1')
    expect(cancelled).toMatchObject({ selection: 'none', startedAt: started.startedAt })
  })
})
