import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTestDb, destroyTestDb } from '../database/test-helper'
import { Database } from '../../../src/main/database/database'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import { RoutineManager } from '../../../src/lib/engines/routine-manager'
import { ProjectManager } from '../../../src/lib/engines/project-manager'
import { ThreadManager } from '../../../src/lib/engines/thread-manager'
import { RoutineSchedulerService } from '../../../src/main/scheduler/routine-scheduler-service'
import { ASSISTANT_SPACE_ID, type Routine, type Thread } from '../../../src/lib/types'

/** Local-time epoch for a fixed wall clock so tests never depend on TZ. */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

describe('RoutineSchedulerService', () => {
  let db: Database
  let storage: StorageEngine
  let root: string
  let routines: RoutineManager
  let threads: ThreadManager
  let clock = 0
  const dispatched: Array<{ run: Thread; task: Thread; routine: Routine | null }> = []

  beforeEach(async () => {
    db = await createTestDb()
    await mkdir(join(process.cwd(), '.cio', 'tmp'), { recursive: true })
    root = await mkdtemp(join(process.cwd(), '.cio', 'tmp', 'sched-'))
    storage = new StorageEngine(root)
    await storage.initialize()
    routines = new RoutineManager(db)
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
    schedule: Routine['schedule'],
    title = 'Task'
  ): Promise<{ task: Thread; routine: Routine }> {
    const routine = routines.createRoutine({ name: 'Routine', schedule })
    const task = await threads.createThread({
      projectId: ASSISTANT_SPACE_ID,
      providerId: 'pi',
      title
    })
    // Return the regrouped row: the scheduler reads a task's routine from the
    // thread it is handed, exactly as the app hands it a fresh row.
    const grouped = routines.setTaskRoutine(task.id, routine.id)
    return { task: grouped, routine }
  }

  function service(): RoutineSchedulerService {
    return new RoutineSchedulerService(storage, {
      routines,
      now: () => clock,
      // Every run gets its own thread, exactly as the app does it: the run is a
      // real row linked to its task through `assistantTaskId`.
      createRunThread: async (task) =>
        threads.createThread({
          projectId: ASSISTANT_SPACE_ID,
          providerId: 'pi',
          title: `Run · ${dispatched.length + 1}`,
          routineId: task.routineId,
          assistantTaskId: task.id
        }),
      dispatch: (run, task, routine) => {
        dispatched.push({ run, task, routine })
      }
    })
  }

  it('dispatches exactly one run when a schedule comes due while open', async () => {
    const { routine, task } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    const scheduler = service()
    await scheduler.start() // startedAt === clock; does not fire during detection
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].routine?.id).toBe(routine.id)
    // The run executes on a fresh thread linked to its task, never on the task.
    expect(dispatched[0].run.id).not.toBe(task.id)
    expect(dispatched[0].run.assistantTaskId).toBe(task.id)
    expect(dispatched[0].run.routineId).toBe(routine.id)
    // A second tick in the same slot must not fire again.
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(scheduler.listMissedRuns()).toHaveLength(0)
    scheduler.dispose()
  })

  it('never schedules a run thread as a task of its own', async () => {
    const { task, routine } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    await scheduler.flush()
    const run = dispatched[0].run
    expect(run.assistantTaskId).toBe(task.id)
    // The run thread carries a schedule through its routine, yet only its task
    // is evaluated: a run can never have a run.
    expect(routines.listAssistantTasks().map((entry) => entry.id)).toEqual([task.id])
    expect(routines.listTaskRuns(task.id).map((entry) => entry.id)).toEqual([run.id])
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched).toHaveLength(1)
    expect(routine.id).toBeTruthy()
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
    const updated = routines.listAssistantTasks().find((entry) => entry.id === task.id)
    expect(updated?.lastSuccessAt).toBe(clock)
    scheduler.dispose()
  })

  it('gives every manual run its own thread', async () => {
    const { task, routine } = await makeScheduledTask({ cadence: 'daily', times: ['09:00'] })
    routines.updateRoutine(routine.id, { howTo: 'Check the inbox, then report.' })
    const scheduler = service()
    await scheduler.start()
    const first = await scheduler.runTaskNow(task)
    const second = await scheduler.runTaskNow(task)
    expect(first.id).not.toBe(second.id)
    expect(dispatched.map((entry) => entry.run.id)).toEqual([first.id, second.id])
    scheduler.dispose()
  })

  it('passes the routine how-to to the dispatch as prompt context', async () => {
    const { routine } = await makeScheduledTask({ cadence: 'hourly', times: [] })
    routines.updateRoutine(routine.id, { howTo: 'Check the inbox, then report.' })
    const scheduler = service()
    await scheduler.start()
    scheduler.evaluate()
    await scheduler.flush()
    expect(dispatched[0].routine?.howTo).toBe('Check the inbox, then report.')
    scheduler.dispose()
  })

  it('records a missed run instead of firing when the app was closed at fire time', async () => {
    const { task, routine } = await makeScheduledTask({
      cadence: 'daily',
      times: ['09:00']
    })
    const scheduler = service()
    await scheduler.start() // now 10:00, 09:00 already passed -> missed
    const missed = scheduler.listMissedRuns()
    expect(dispatched).toHaveLength(0)
    expect(missed).toHaveLength(1)
    expect(missed[0].threadId).toBe(task.id)
    expect(missed[0].routineId).toBe(routine.id)
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
})
