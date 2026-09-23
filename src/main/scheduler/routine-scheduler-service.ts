import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { RoutineManager } from '../../lib/engines/routine-manager'
import {
  previousDueAt,
  scheduleIsActive,
  type MissedRun,
  type Routine,
  type Thread
} from '../../lib/types'
import { MissedRunStore } from './missed-run-store'

/** How often the scheduler checks whether a configured time has come due. */
const TICK_MS = 30_000

/**
 * A due slot this far in the past is treated as missed rather than run: it
 * covers both an app that was closed at fire time and a machine that slept
 * through it, without a burst of catch-up runs.
 */
const MISS_GRACE_MS = 2 * 60_000

/** Dispatch one scheduled run on the task's continuous thread. */
export type RoutineDispatch = (task: Thread, routine: Routine | null) => Promise<unknown> | void

export interface RoutineSchedulerDeps {
  routines: RoutineManager
  dispatch: RoutineDispatch
  /** Injectable clock so evaluation windows are testable. Defaults to Date.now. */
  now?: () => number
}

/**
 * RoutineSchedulerService   the main-process clock for Assistant View.
 *
 * Fires scheduled agent runs on each task's continuous thread while the app is
 * open. A slot the app was not open to run is recorded as a missed run (never
 * auto-run), so relaunching after an outage surfaces the miss instead of
 * dumping a burst of catch-up runs. Evaluation is bounded per tick (a plain
 * loop over the assistant tasks) and dispatch is fire-and-forget, so the main
 * process is never blocked waiting on a run.
 */
export class RoutineSchedulerService {
  private readonly missed: MissedRunStore
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private changeListener: (() => void) | null = null
  private tickChain: Promise<void> = Promise.resolve()

  constructor(
    storage: StorageEngine,
    private readonly deps: RoutineSchedulerDeps
  ) {
    this.missed = new MissedRunStore(storage)
    this.now = deps.now ?? (() => Date.now())
  }

  /** Load persisted missed runs, detect app-closed misses, and arm the ticker. */
  async start(): Promise<void> {
    await this.missed.load()
    this.missed.pruneSettled()
    this.startedAt = this.now()
    // Detect misses that happened while the app was closed before ticking, so a
    // slot that comes due only after startup is fired, not mis-recorded.
    this.evaluate(false)
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.notifyChange()
  }

  /** Register a callback fired whenever missed-run state changes. */
  attachChangeListener(callback: () => void): void {
    this.changeListener = callback
  }

  listMissedRuns(): MissedRun[] {
    return this.missed.list()
  }

  dismissMissedRun(id: string): void {
    this.missed.dismiss(id)
    this.notifyChange()
  }

  /** Run a missed schedule immediately and clear its record on success. */
  async runMissedRunNow(id: string): Promise<void> {
    const run = this.missed.listAll().find((entry) => entry.id === id)
    if (!run) throw new Error(`Missed run not found: ${id}`)
    const task = this.deps.routines.listAssistantTasks().find((entry) => entry.id === run.threadId)
    if (!task) {
      // The task is gone; settle the orphan so it stops badging.
      this.missed.dismiss(id)
      this.notifyChange()
      return
    }
    const routine = task.routineId ? this.deps.routines.getRoutine(task.routineId) : null
    try {
      await this.deps.dispatch(task, routine)
      this.deps.routines.setTaskLastRun(task.id, run.dueAt)
      this.missed.markRun(id)
    } catch (error) {
      Logger.error('Missed run dispatch failed', error)
      throw error
    } finally {
      this.notifyChange()
    }
  }

  /** Evaluate every scheduled task once (used by start and by tests). */
  evaluate(allowDispatch = true): void {
    const tasks = this.deps.routines.listAssistantTasks()
    for (const task of tasks) {
      try {
        this.evaluateTask(task, allowDispatch)
      } catch (error) {
        Logger.error('Routine schedule evaluation failed', error)
      }
    }
  }

  /** Await pending missed-run writes (used by shutdown and tests). */
  async flush(): Promise<void> {
    await this.missed.flush()
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.stop()
    this.changeListener = null
  }

  private tick(): void {
    // Serialize ticks: a slow tick must not overlap the next one.
    this.tickChain = this.tickChain
      .then(() => {
        this.evaluate(true)
      })
      .catch((error) => {
        Logger.error('Routine scheduler tick failed', error)
      })
  }

  private evaluateTask(task: Thread, allowDispatch: boolean): void {
    // A paused routine keeps its tasks and how-to but never fires.
    if (this.deps.routines.isTaskPaused(task)) return
    const schedule = this.deps.routines.resolveTaskSchedule(task)
    if (!scheduleIsActive(schedule)) return
    const now = this.now()
    const due = previousDueAt(schedule, now)
    if (due === null) return
    const last = task.lastRunAt ?? 0
    if (due <= last) return

    const isMissed = due < this.startedAt || now - due > MISS_GRACE_MS
    if (isMissed) {
      const before = this.missed.list().length
      this.missed.record({
        threadId: task.id,
        routineId: task.routineId,
        dueAt: due,
        title: task.title
      })
      // Claim the slot so a repeated tick cannot re-detect the same fire.
      this.deps.routines.setTaskLastRun(task.id, due)
      if (this.missed.list().length !== before) this.notifyChange()
      return
    }

    if (!allowDispatch) return
    this.fire(task, due)
  }

  private fire(task: Thread, dueAt: number): void {
    // Claim the slot before the async dispatch so the next tick cannot double-fire.
    this.deps.routines.setTaskLastRun(task.id, dueAt)
    const routine = task.routineId ? this.deps.routines.getRoutine(task.routineId) : null
    void Promise.resolve(this.deps.dispatch(task, routine)).catch((error) => {
      Logger.error('Routine scheduled run failed', error)
    })
    this.notifyChange()
  }

  private notifyChange(): void {
    this.changeListener?.()
  }
}
