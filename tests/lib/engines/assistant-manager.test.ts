import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, destroyTestDb } from '../../main/database/test-helper'
import { AssistantManager } from '../../../src/lib/engines/assistant-manager'
import { ProjectManager } from '../../../src/lib/engines/project-manager'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import { ASSISTANT_SPACE_ID, assistantKnowledgeComplete } from '../../../src/lib/types'
import type { Database } from '../../../src/main/database/database'

describe('AssistantManager', () => {
  let db: Database
  let assistants: AssistantManager
  let threads: ThreadManager

  beforeEach(async () => {
    db = await createTestDb()
    assistants = new AssistantManager(db)
    threads = new ThreadManager(db)
    await new ProjectManager(db).ensureAssistantSpace()
  })

  afterEach(() => {
    destroyTestDb(db)
  })

  it('creates an assistant with a colour and an empty (incomplete) knowledge', () => {
    const assistant = assistants.createAssistant({ name: 'Triage PRs' })
    expect(assistant.id).toBeTruthy()
    expect(assistant.name).toBe('Triage PRs')
    expect(assistant.color).toBeTruthy()
    expect(assistant.knowledge).toBe('')
    expect(assistantKnowledgeComplete(assistant)).toBe(false)
    expect(assistants.getAssistant(assistant.id)?.name).toBe('Triage PRs')
  })

  it('updates the knowledge and stamps knowledgeUpdatedAt', () => {
    const assistant = assistants.createAssistant({ name: 'Morning report' })
    const updated = assistants.updateAssistant(assistant.id, {
      knowledge: 'Check the inbox daily.'
    })
    expect(updated.knowledge).toBe('Check the inbox daily.')
    expect(updated.knowledgeUpdatedAt).toBeTypeOf('number')
    expect(assistantKnowledgeComplete(updated)).toBe(true)
  })

  it('persists the default schedule round-trip', () => {
    const assistant = assistants.createAssistant({
      name: 'Scheduled',
      schedule: { cadence: 'daily', times: ['09:00', '17:00'] }
    })
    expect(assistants.getAssistant(assistant.id)?.schedule).toEqual({
      cadence: 'daily',
      times: ['09:00', '17:00']
    })
  })

  it('persists a connection and the agent setup prompt it carries', () => {
    const assistant = assistants.createAssistant({
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
    expect(assistants.getAssistant(assistant.id)?.connections).toEqual([
      {
        utilityId: 'required:slack',
        label: 'Slack',
        required: true,
        setup: 'Install the official Slack MCP from mcp.slack.com and collect the bot token.'
      }
    ])
  })

  it('groups a task and resolves its schedule from the assistant', async () => {
    const assistant = assistants.createAssistant({
      name: 'Triage',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage run'
    })
    assistants.assignTask(task.id, assistant.id)
    const grouped = assistants.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(grouped?.assistantId).toBe(assistant.id)
    expect(assistants.resolveTaskSchedule(grouped!)).toEqual({
      cadence: 'daily',
      times: ['09:00']
    })
  })

  it('prefers a task schedule override over the assistant default', async () => {
    const assistant = assistants.createAssistant({
      name: 'Triage',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage run'
    })
    assistants.assignTask(task.id, assistant.id)
    assistants.setTaskScheduleOverride(task.id, { cadence: 'hourly', times: [] })
    const grouped = assistants.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(assistants.resolveTaskSchedule(grouped!)).toEqual({ cadence: 'hourly', times: [] })
  })

  it('lists a task runs and never counts a run as a task', async () => {
    const assistant = assistants.createAssistant({
      name: 'Triage',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage'
    })
    assistants.assignTask(task.id, assistant.id)
    const run = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Run · 09:00',
      assistantId: assistant.id,
      assistantTaskId: task.id
    })
    // A run is an execution of a task, never a task: it is not listed, not
    // schedulable, and not counted in the assistant's task count.
    expect(assistants.listAssistantTasks().map((entry) => entry.id)).toEqual([task.id])
    expect(assistants.listAssistantTasksFor(assistant.id).map((entry) => entry.id)).toEqual([
      task.id
    ])
    expect(assistants.listTaskRuns(task.id).map((entry) => entry.id)).toEqual([run.id])
    expect(assistants.taskIdForRun(run.id)).toBe(task.id)
    expect(assistants.taskIdForRun(task.id)).toBeNull()
  })

  it('deletes a task with its runs, so no orphan run row survives', async () => {
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Triage'
    })
    const run = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Run · 09:00',
      assistantTaskId: task.id
    })
    const sibling = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Unrelated task'
    })
    await threads.deleteThread(ASSISTANT_SPACE_ID, task.id)
    expect(await threads.getThread(ASSISTANT_SPACE_ID, run.id)).toBeNull()
    expect(await threads.getThread(ASSISTANT_SPACE_ID, sibling.id)).not.toBeNull()
  })

  it('deletes every thread of an assistant when it is removed, the hidden knowledge thread included', async () => {
    assistants.attachThreadDeleter((threadId) => threads.deleteThread(ASSISTANT_SPACE_ID, threadId))
    const assistant = assistants.createAssistant({ name: 'Temp' })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    const setup = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Getting started',
      assistantGettingStarted: true
    })
    assistants.assignTask(task.id, assistant.id)
    assistants.assignTask(setup.id, assistant.id)
    // Hidden knowledge thread: archived out of the sidebar but still owned.
    assistants.setKnowledgeHidden(assistant.id, true)
    expect(assistants.knowledgeThread(assistant.id)?.id).toBe(setup.id)

    await assistants.deleteAssistant(assistant.id)

    expect(assistants.getAssistant(assistant.id)).toBeNull()
    expect(assistants.knowledgeThread(assistant.id)).toBeNull()
    expect(assistants.listAssistantTasks().map((entry) => entry.id)).not.toContain(task.id)
    expect(await threads.getThread(ASSISTANT_SPACE_ID, setup.id)).toBeNull()
  })

  it('lists only assistant-space tasks', async () => {
    const project = await new ProjectManager(db).createProject({ name: 'Real', path: '' })
    await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Assistant task'
    })
    await threads.createThread({ projectId: project.id, providerId: 'pi', title: 'Project thread' })
    const tasks = assistants.listAssistantTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Assistant task')
  })

  it('records a task last run', async () => {
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    assistants.setTaskLastRun(task.id, 1_700_000_000_000)
    expect(assistants.listAssistantTasks()[0].lastRunAt).toBe(1_700_000_000_000)
  })
})
