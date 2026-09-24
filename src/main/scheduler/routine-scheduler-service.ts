import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import type { RoutineManager } from '../../lib/engines/routine-manager'
import {
  previousDueAt,
  scheduleIsActive,
  type MissedRun,
  type Routine,
  type Thread,
  type ThreadStatus
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

/**
 * Create the fresh thread a run executes on. Every run gets its own thread, so
 * a run never lands in the task's own conversation; only a routine's Getting
 * started thread hosts its authoring conversation.
 */
export type RoutineRunThreadFactory = (task: Thread, routine: Routine | null) => Promise<Thread>

/** Dispatch one run onto the thread created for it. */
export type RoutineDispatch = (
  run: Thread,
  task: Thread,
  routine: Routine | null
) => Promise<unknown> | void

export interface RoutineSchedulerDeps {
  routines: RoutineManager
  createRunThread: RoutineRunThreadFactory
  dispatch: RoutineDispatch
  /** Injectable clock so evaluation windows are testable. Defaults to Date.now. */
  now?: () => number
  /**
   * Notified whenever the scheduler writes run bookkeeping (last run, last
   * successful run) onto a task, so the workspace can push the fresh row to
   * every renderer without the scheduler depending on Electron.
   */
  onTaskChanged?: (task: Thread) => void
}

/**
 * RoutineSchedulerService   the main-process clock for Assistant View.
 *
 * Fires scheduled agent runs while the app is open. Each run is dispatched
 * onto a brand-new thread linked to its task (`Thread.assistantTaskId`), so the
 * task's own conversation stays the user's and a run's transcript holds only
 * that execution. A slot the app was not open to run is recorded as a missed
 * run (never auto-run), so relaunching after an outage surfaces the miss
 * instead of dumping a burst of catch-up runs. Evaluation is bounded per tick (a
 * plain loop over the assistant tasks) and dispatch is fire-and-forget, so the
 * main process is never blocked waiting on a run.
 */
export class RoutineSchedulerService {
  private readonly missed: MissedRunStore
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private changeListener: (() => void) | null = null
  private tickChain: Promise<void> = Promise.resolve()
  /**
   * Serialized chain of scheduled run dispatches. Ticks never overlap, and the
   * chain is what `flush` awaits, so a shutdown (and a test) can be sure every
   * dispatched run was handed to the engine before the process tears down.
   */
  private dispatchChain: Promise<void> = Promise.resolve()
  /**
   * Run-thread id -> task id for every dispatched run whose turn has not
   * settled yet. Dispatch returns once the prompt is accepted, so success is
   * only known when the session idles; the engine reports the settled run
   * thread back through `settleRun`. A run the scheduler never dispatched is
   * never stamped, so a user's own chat on a task never counts as a run.
   */
  private readonly inFlightRuns = new Map<string, string>()

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
    // Drop records that predate their schedule (or whose task is gone) before
    // anything else, so a miss written by an older build cannot keep badging.
    this.pruneStaleMisses()
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

  /**
   * Forget everything the scheduler holds for a routine that is being removed:
   * its pending missed runs, which would otherwise keep badging until the next
   * launch, and the in-flight run bookkeeping of its tasks.
   *
   * Nothing else needs resetting. Every tick re-reads the assistant tasks from
   * the database, so a removed task is never evaluated, fired, or recorded as
   * missed again, and a run already in flight is stopped by the deletion of its
   * run thread through the canonical thread path.
   */
  forgetRoutine(routineId: string, removedThreadIds: readonly string[]): void {
    const threads = new Set(removedThreadIds)
    for (const [runThreadId, taskId] of this.inFlightRuns) {
      if (threads.has(taskId) || threads.has(runThreadId)) this.inFlightRuns.delete(runThreadId)
    }
    if (this.missed.removeForRoutine(routineId, removedThreadIds) > 0) this.notifyChange()
  }

  /**
   * Run a missed schedule immediately on a fresh run thread and clear its
   * record on success. Returns the created run, or null when the task it
   * belonged to is gone (the orphan is settled so it stops badging).
   */
  async runMissedRunNow(id: string): Promise<Thread | null> {
    const missed = this.missed.listAll().find((entry) => entry.id === id)
    if (!missed) throw new Error(`Missed run not found: ${id}`)
    const task = this.deps.routines
      .listAssistantTasks()
      .find((entry) => entry.id === missed.threadId)
    if (!task) {
      // The task is gone; settle the orphan so it stops badging.
      this.missed.dismiss(id)
      this.notifyChange()
      return null
    }
    const routine = task.routineId ? this.deps.routines.getRoutine(task.routineId) : null
    try {
      const run = await this.startRun(task, routine)
      this.recordLastRun(task.id, missed.dueAt)
      this.recordDispatch(task.id)
      this.missed.markRun(id)
      return run
    } finally {
      this.notifyChange()
    }
  }

  /**
   * Run one task immediately on a fresh run thread, ignoring its schedule and
   * its routine's pause state   the manual "test this routine" action. Fails
   * when the routine has no how-to yet: a run with no instructions would do
   * nothing useful, and the user is still in the authoring conversation.
   */
  async runTaskNow(task: Thread): Promise<Thread> {
    const routine = task.routineId ? this.deps.routines.getRoutine(task.routineId) : null
    if (!routine?.howTo.trim()) {
      throw new Error('This routine has no how-to yet. Describe it to the agent first.')
    }
    const run = await this.startRun(task, routine)
    this.recordLastRun(task.id, this.now())
    this.recordDispatch(task.id)
    this.notifyChange()
    return run
  }

  /**
   * Report that a dispatched run's turn settled on its run thread with a final
   * status. A `completed` turn records the last successful run on the run's task
   * and releases the run; a `failed` or `interrupted` turn releases it without a
   * success stamp; an `awaiting_approval` or `working-paused` turn is left
   * tracked, because the run is still in progress (waiting on the user or a
   * provider reset) and its eventual completion must still count. A run thread
   * the scheduler never dispatched is ignored, so a user's own chat never counts
   * as a run.
   */
  settleRun(runThreadId: string, status: ThreadStatus): void {
    const taskId = this.inFlightRuns.get(runThreadId)
    if (taskId === undefined) return
    if (status === 'completed') {
      this.inFlightRuns.delete(runThreadId)
      const updated = this.deps.routines.markTaskRunSuccess(taskId, this.now())
      if (updated) this.deps.onTaskChanged?.(updated)
      return
    }
    if (status === 'failed' || status === 'interrupted') {
      this.inFlightRuns.delete(runThreadId)
    }
  }

  /**
   * Run every runnable task of a routine now, each on its own fresh thread, and
   * return the created runs in dispatch order so the panel can open the first
   * one and the sidebar can show them nested under their tasks.
   */
  async runRoutineNow(routineId: string): Promise<Thread[]> {
    const routine = this.deps.routines.getRoutine(routineId)
    if (!routine) throw new Error(`Routine not found: ${routineId}`)
    if (!routine.howTo.trim()) {
      throw new Error('This routine has no how-to yet. Describe it to the agent first.')
    }
    const tasks = this.deps.routines.listRoutineTasks(routineId)
    if (tasks.length === 0) throw new Error('This routine has no task to run.')
    return Promise.all(tasks.map((task) => this.runTaskNow(task)))
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

  /**
   * Drop persisted misses that are no longer real: a slot that predates its
   * schedule's activation (the routine or its schedule did not exist then), or
   * one whose task is gone. A schedule cannot have missed a fire that predates
   * it, so such a record is misinformation rather than a pending run.
   */
  private pruneStaleMisses(): void {
    const tasks = new Map(this.deps.routines.listAssistantTasks().map((task) => [task.id, task]))
    for (const run of this.missed.list()) {
      const task = tasks.get(run.threadId)
      if (!task) {
        this.missed.remove(run.id)
        continue
      }
      if (run.dueAt < this.deps.routines.resolveTaskScheduleAnchor(task)) {
        this.missed.remove(run.id)
      }
    }
  }

  /** Await pending missed-run writes and dispatched runs (used by shutdown and tests). */
  async flush(): Promise<void> {
    await this.missed.flush()
    await this.dispatchChain
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
    // A routine with no how-to cannot run: there is nothing to fire and nothing
    // to miss until it is set up. Gating here also keeps a half-configured
    // routine from badging a "missed run" for a slot it could never have run.
    if (this.deps.routines.resolveTaskHowTo(task).trim() === '') return
    const schedule = this.deps.routines.resolveTaskSchedule(task)
    if (!scheduleIsActive(schedule)) return
    const now = this.now()
    const due = previousDueAt(schedule, now)
    if (due === null) return
    // The floor is the later of the task's last fire and the moment its
    // schedule became active. A slot before the schedule existed was never
    // really due, so it is neither fired nor recorded as missed.
    const anchor = this.deps.routines.resolveTaskScheduleAnchor(task)
    const floor = Math.max(task.lastRunAt ?? 0, anchor)
    if (due <= floor) return

    const appClosed = due < this.startedAt
    const isMissed = appClosed || now - due > MISS_GRACE_MS
    if (isMissed) {
      const before = this.missed.list().length
      this.missed.record({
        threadId: task.id,
        routineId: task.routineId,
        dueAt: due,
        title: task.title,
        reason: appClosed ? 'app-closed' : 'delayed'
      })
      // Claim the slot so a repeated tick cannot re-detect the same fire.
      this.recordLastRun(task.id, due)
      if (this.missed.list().length !== before) this.notifyChange()
      return
    }

    if (!allowDispatch) return
    this.fire(task, due)
  }

  /**
   * Dispatch one scheduled run onto a fresh thread. The slot is claimed before
   * the async run-thread creation so the next tick cannot double-fire, and the
   * work runs on a serialized chain: a slow create never blocks the ticker, and
   * a failure only logs.
   */
  private fire(task: Thread, dueAt: number): void {
    this.recordLastRun(task.id, dueAt)
    this.dispatchChain = this.dispatchChain
      .then(() => this.startRun(task))
      .then(() => {
        this.recordDispatch(task.id)
        this.notifyChange()
      })
      .catch((error) => {
        Logger.error('Routine scheduled run failed', error)
      })
  }

  /**
   * Create the run's thread and hand the run to the dispatcher. The run is
   * tracked against its task so a settled turn stamps the task, not the run.
   */
  private async startRun(task: Thread, knownRoutine?: Routine | null): Promise<Thread> {
    const routine =
      knownRoutine !== undefined
        ? knownRoutine
        : task.routineId
          ? this.deps.routines.getRoutine(task.routineId)
          : null
    const run = await this.deps.createRunThread(task, routine)
    this.inFlightRuns.set(run.id, task.id)
    try {
      await this.deps.dispatch(run, task, routine)
    } catch (error) {
      this.inFlightRuns.delete(run.id)
      throw error
    }
    return run
  }

  /** Claim a schedule slot (fired or recorded as missed). */
  private recordLastRun(threadId: string, at: number): void {
    const updated = this.deps.routines.setTaskLastRun(threadId, at)
    this.deps.onTaskChanged?.(updated)
  }

  /** Record that a run was actually dispatched, so the panel can show it. */
  private recordDispatch(threadId: string): void {
    const updated = this.deps.routines.markTaskRunDispatched(threadId, this.now())
    if (updated) this.deps.onTaskChanged?.(updated)
  }

  private notifyChange(): void {
    this.changeListener?.()
  }
}
