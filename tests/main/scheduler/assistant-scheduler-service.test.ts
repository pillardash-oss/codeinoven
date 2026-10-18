import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import { Database } from '../../../src/main/database/database'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { AssistantManager } from '../../../src/lib/engines/assistant-manager'
import { ProjectManager } from '../../../src/lib/engines/project-manager'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import { AssistantSchedulerService } from '../../../src/main/scheduler/assistant-scheduler-service'
import { MissedRunStore } from '../../../src/main/scheduler/missed-run-store'
import { ThreadRepo } from '../../../src/main/database/repositories/thread-repo'
import { ASSISTANT_SPACE_ID, type Assistant, type Thread } from '../../../src/lib/types'

/** Local-time epoch for a fixed wall clock so tests never depend on TZ. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('AssistantSchedulerService', () => {
  let db: Database
  let storage: StorageEngine
  let root: string
  let assistants: AssistantManager
  let threads: ThreadManager
  let clock = 0
  const dispatched: Array<{ run: Thread; task: Thread; assistant: Assistant | null }> = []

  beforeEach(async () => {
    db = await createTestDb()
    await mkdir(join(process.cwd(), '.cio', 'tmp'), { recursive: true })
    root = await mkdtemp(join(process.cwd(), '.cio', 'tmp', 'sched-'))
    storage = new StorageEngine(root)
    await storage.initialize()
    assistants = new AssistantManager(db, () => clock)
    threads = new ThreadManager(db)
    await new ProjectManager(db).ensureAssistantSpace()
    dispatched.length = 0
    clock = at(2026, 3, 10, 10, 0) // Tuesday 10:00
  })

  afterEach(async () => {
    destroyTestDb(db)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })
  })

  async function makeScheduledTask(
    schedule: Assistant['schedule'],
    title = 'Task',
    knowledge = 'Do the thing.'
  ): Promise<{ task: Thread; assistant: Assistant }> {
    // The assistant and its schedule came into being two hours before the moment
    // under test, so a due slot after that is a real fire or miss rather than a
    // slot that predates the schedule.
    const moment = clock
    const inception = moment - 2 * 60 * 60 * 1000
    clock = inception
    const assistant = assistants.createAssistant({ name: 'Assistant', schedule, knowledge })
    clock = moment
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title
    })
    // A task's schedule anchor is the later of its own creation and its
    // assistant's schedule clock, and the thread manager stamps `createdAt` from
    // the real clock. Pin it to the assistant's inception so this fixture models
    // a task that has belonged to the assistant from the start, which is what
    // every test below is about.
    new ThreadRepo(db).upsert({ ...task, createdAt: inception, lastActivity: inception })
    // Return the regrouped row: the scheduler reads a task's assistant from the
    // thread it is handed, exactly as the app hands it a fresh row.
    const grouped = assistants.assignTask(task.id, assistant.id)
    return { task: grouped, assistant }
  }

  function service(): AssistantSchedulerService {
    return new AssistantSchedulerService(storage, {
      assistants,
      now: () => clock,
      // Every run gets its own thread, exactly as the app does it: the run is a
      // real row linked to its task through `assistantTaskId`.
      createRunThread: async (task) =>
        threads.createThread({
          projectId: ASSISTANT_SPACE_ID,
          providerId: 'pi',
          title: `Run · ${dispatched.length + 1}`,
          assistantId: task.assistantId,
          assistantTaskId: task.id
        }),
      dispatch: (run, task, assistant) => {
        dispatched.push({ run, task, assistant })
      }
    })
  }

  it('dispatches exactly one run when a schedule comes due while open', async () => {
    const { assistant, task } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    const scheduler = service()
    await scheduler.start() // startedAt === clock; does not fire during detection
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].assistant?.id).toBe(assistant.id)
    // The run executes on a fresh thread linked to its task, never on the task.
    expect(dispatched[0].run.id).not.toBe(task.id)
    expect(dispatched[0].run.assistantTaskId).toBe(task.id)
    expect(dispatched[0].run.assistantId).toBe(assistant.id)
    // A second tick in the same slot must not fire again.
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })

  it('never schedules a run thread as a task of its own', async () => {
    const { task, assistant } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    await scheduler.flush()
    const run = dispatched[0].run
    expect(run.assistantTaskId).toBe(task.id)
    // The run thread carries a schedule through its assistant, yet only its task
    // is evaluated: a run can never have a run.
    expect(assistants.listAssistantTasks().map((entry) => entry.id)).toEqual([task.id])
    expect(assistants.listTaskRuns(task.id).map((entry) => entry.id)).toEqual([run.id])
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(assistant.id).toBeTruthy()
    scheduler.dispose()
  })

  it('stamps the task, not the run thread, when a run settles', async () => {
    const { task } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    await scheduler.flush()
    const run = dispatched[0].run
    scheduler.settleRun(run.id, 'completed')
    const updated = assistants.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(updated?.lastSuccessAt).toBe(clock)
    scheduler.dispose()
  })

  it('gives every manual run its own thread', async () => {
    const { task, assistant } = await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    assistants.updateAssistant(assistant.id, { knowledge: 'Check the inbox, then report.' })
    const scheduler = service()
    await scheduler.start()
    const first = await scheduler.runTaskNow(task)
    const second = await scheduler.runTaskNow(task)
    expect(first.id).not.toBe(second.id)
    expect(dispatched.map((entry) => entry.run.id)).toEqual([first.id, second.id])
    scheduler.dispose()
  })

  it('passes the assistant knowledge to the dispatch as prompt context', async () => {
    const { assistant } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    assistants.updateAssistant(assistant.id, { knowledge: 'Check the inbox, then report.' })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched[0].assistant?.knowledge).toBe('Check the inbox, then report.')
    scheduler.dispose()
  })

  it('records a missed run instead of firing when the app was closed at fire time', async () => {
    const { task, assistant } = await makeScheduledTask({
      cadence: 'daily',
      times: ['09:00']
    })
    const scheduler = service()
    await scheduler.start() // now 10:00, 09:00 already passed -> missed
    const missed = scheduler.listMissedRuns()
    expect(dispatched).toHaveLength(0)
    expect(missed).toHaveLength(1)
    expect(missed[0].threadId).toBe(task.id)
    expect(missed[0].assistantId).toBe(assistant.id)
    expect(missed[0].dueAt).toBe(at(2026, 3, 10, 9, 0))
    scheduler.dispose()
  })

  it('never double-records the same missed fire across repeated evaluation', async () => {
    await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    scheduler.evaluate()
    expect(scheduler.listMissedRuns()).toHaveLength(1)
    scheduler.dispose()
  })

  it('dismiss clears the missed record without running it', async () => {
    await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    const scheduler = service()
    await scheduler.start()
    const [missed] = scheduler.listMissedRuns()
    scheduler.dismissMissedRun(missed.id)
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    expect(dispatched).toHaveLength(0)
    scheduler.dispose()
  })

  it('Run Now dispatches the missed run on a fresh thread and settles its record', async () => {
    const { task } = await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    const scheduler = service()
    await scheduler.start()
    const [missed] = scheduler.listMissedRuns()
    const run = await scheduler.runMissedRunNow(missed.id)
    expect(dispatched).toHaveLength(1)
    expect(run?.assistantTaskId).toBe(task.id)
    scheduler.settleRun(run?.id ?? '', 'completed')
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })

  it('persists missed runs across a restart and prunes settled records on load', async () => {
    await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    const first = service()
    await first.start()
    expect(first.listMissedRuns()).toHaveLength(1)
    const [missed] = first.listMissedRuns()
    first.dismissMissedRun(missed.id)
    await first.flush()
    first.dispose()

    // A fresh service over the same storage starts with no pending records,
    // because settled records are pruned on load.
    const second = service()
    await second.start()
    expect(second.listMissedRuns()).toHaveLength(0)
    second.dispose()
  })

  it('never records a miss for a slot that predates the schedule', async () => {
    // The assistant (and its schedule) came into being at 10:00, so the 09:00
    // slot the same day was never due for it. This is the reported bug: a
    // assistant created in the afternoon must not badge a morning slot as missed.
    const assistant = assistants.createAssistant({
      name: 'Assistant',
      schedule: { cadence: 'daily', times: ['09:00'] },
      knowledge: 'Do the thing.'
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    assistants.assignTask(task.id, assistant.id)
    const scheduler = service()
    await scheduler.start()
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })

  it('drops a persisted miss that predates the schedule on load', async () => {
    const assistant = assistants.createAssistant({
      name: 'Assistant',
      schedule: { cadence: 'daily', times: ['09:00'] },
      knowledge: 'Do the thing.'
    })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    const grouped = assistants.assignTask(task.id, assistant.id)
    // Simulate a record written by an older build: a slot before the assistant
    // existed. The scheduler must drop it rather than keep badging it.
    const store = new MissedRunStore(storage)
    await store.load()
    store.record({
      threadId: grouped.id,
      assistantId: assistant.id,
      dueAt: at(2026, 3, 10, 8, 0),
      title: 'Task'
    })
    await store.flush()

    const scheduler = service()
    await scheduler.start()
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })

  it('never schedules an assistant that has no knowledge yet', async () => {
    // A half-configured assistant cannot run, so it has nothing to fire or miss.
    const moment = clock
    clock = moment - 2 * 60 * 60 * 1000
    const assistant = assistants.createAssistant({
      name: 'Assistant',
      schedule: { cadence: 'daily', times: ['09:00'] }
    })
    clock = moment
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title: 'Task'
    })
    assistants.assignTask(task.id, assistant.id)
    const scheduler = service()
    await scheduler.start()
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })
})
