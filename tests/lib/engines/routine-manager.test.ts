import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { RoutineManager } from '../../../src/lib/engines/routine-manager'
import { ProjectManager } from '../../../src/lib/engines/project-manager'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import { ASSISTANT_SPACE_ID, routineHowToComplete } from '../../../src/lib/types'
import type { Database } from '../../../src/main/database/database'

describe('RoutineManager', () => {
  let db: Database
  let routines: RoutineManager
  let threads: ThreadManager

  beforeEach(async () => {
    db = await createTestDb()
    routines = new RoutineManager(db)
    threads = new ThreadManager(db)
    await new ProjectManager(db).ensureAssistantSpace()
  })

  afterEach(() => {
    destroyTestDb(db)
  })

  it('creates a routine with a colour and an empty (incomplete) how-to', () => {
    const routine = routines.createRoutine({ name: 'Triage PRs' })
    expect(routine.id).toBeTruthy()
    expect(routine.name).toBe('Triage PRs')
    expect(routine.color).toBeTruthy()
    expect(routine.howTo).toBe('')
    expect(routineHowToComplete(routine)).toBe(false)
    expect(routines.getRoutine(routine.id)?.name).toBe('Triage PRs')
  })

  it('updates the how-to and stamps howToUpdatedAt', () => {
    const routine = routines.createRoutine({ name: 'Morning report' })
    const updated = routines.updateRoutine(routine.id, { howTo: 'Check the inbox daily.' })
    expect(updated.howTo).toBe('Check the inbox daily.')
    expect(updated.howToUpdatedAt).toBeTypeOf('number')
    expect(routineHowToComplete(updated)).toBe(true)
  })

  it('persists the default schedule round-trip', () => {
    const routine = routines.createRoutine({
      name: 'Scheduled',
      schedule: { cadence: 'daily', times: ['09:00', '17:00'] }
    })
    expect(routines.getRoutine(routine.id)?.schedule).toEqual({
      cadence: 'daily',
      times: ['09:00', '17:00']
    })
  })

  it('persists a connection and the agent setup prompt it carries', () => {
    const routine = routines.createRoutine({
      name: 'Slack digest',
      connections: [
        {
          utilityId: 'required:slack',
          label: 'Slack',
          required: true,
          setup: 'Install the official Slack MCP from mcp.slack.com and collect the bot token.'
        }
      ]
    })
    expect(routines.getRoutine(routine.id)?.connections).toEqual([
      {
        utilityId: 'required:slack',
        label: 'Slack',
        required: true,
        setup: 'Install the official Slack MCP from mcp.slack.com and collect the bot token.'
      }
    ])
  })

  it('groups a task and resolves its schedule from the routine', async () => {
    const routine = routines.createRoutine({
      name: 'Triage',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage run'
    })
    routines.setTaskRoutine(task.id, routine.id)
    const grouped = routines.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(grouped?.routineId).toBe(routine.id)
    expect(routines.resolveTaskSchedule(grouped!)).toEqual({
      cadence: 'daily',
      times: ['09:00']
    })
  })

  it('prefers a task schedule override over the routine default', async () => {
    const routine = routines.createRoutine({
      name: 'Triage',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage run'
    })
    routines.setTaskRoutine(task.id, routine.id)
    routines.setTaskScheduleOverride(task.id, { cadence: 'hourly', times: [] })
    const grouped = routines.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(routines.resolveTaskSchedule(grouped!)).toEqual({ cadence: 'hourly', times: [] })
  })

  it('ungroups tasks when a routine is deleted', async () => {
    const routine = routines.createRoutine({ name: 'Temp' })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    routines.setTaskRoutine(task.id, routine.id)
    routines.deleteRoutine(routine.id)
    const remaining = routines.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(remaining?.routineId).toBeUndefined()
    expect(routines.getRoutine(routine.id)).toBeNull()
  })

  it('lists only assistant-space tasks', async () => {
    const project = await new ProjectManager(db).createProject({ name: 'Real', path: '' })
    await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Assistant task'
    })
    await threads.createThread({ projectId: project.id, providerId: 'pi', title: 'Project thread' })
    const tasks = routines.listAssistantTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Assistant task')
  })

  it('records a task last run', async () => {
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    routines.setTaskLastRun(task.id, 1_700_000_000_000)
    expect(routines.listAssistantTasks()[0].lastRunAt).toBe(1_700_000_000_000)
  })
})
