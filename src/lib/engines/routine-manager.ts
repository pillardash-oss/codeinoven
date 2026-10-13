import { generateId, getRoutinePath } from '../utils'
import { rm } from 'fs/promises'
import { readIconDataUrl, removeIconFile, storeCustomIconFile } from '../icon-file'
import type { CustomIconImage } from '../custom-icon'
import { ASSISTANT_SPACE_ID, isAssistantSetupThread, isAssistantRunThread } from '../types'
import { pickColorForSeed } from '../project-colors'
import { sortRoutines } from '../routine-order'
import { routineOwnedDirectories } from '../thread-storage-paths'
import { Logger } from '../../main/system/logger'
import type { Database } from '../../main/database/database'
import { RoutineRepo } from '../../main/database/repositories/routine-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import {
  routineFirstHowToSave,
  routineIsScheduled,
  type CreateRoutineInput,
  type Routine,
  type RoutineAgents,
  type RoutineDeletionResult,
  type RoutineSchedule,
  type Thread,
  type UpdateRoutineInput
} from '../types'

/**
 * Whether two schedules are the same, so re-saving a routine's how-to does not
 * restart its schedule clock and suppress a genuine missed fire.
 */
function schedulesEqual(
  a: RoutineSchedule | null | undefined,
  b: RoutineSchedule | null | undefined
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null)
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * RoutineManager   CRUD and task-grouping for assistant routines.
 *
 * Mirrors ProjectManager's SQLite-backed shape. A routine owns the how-to and
 * the default schedule; tasks are assistant-space threads that optionally
 * reference a routine and may override its schedule.
 */
export class RoutineManager {
  private routineRepo: RoutineRepo
  private threadRepo: ThreadRepo
  /**
   * Removes a thread through the canonical path (session teardown, DB cleanup,
   * disk artifacts). Attached by the IPC layer once the thread manager exists,
   * so deleting a routine sweeps its threads instead of orphaning them.
   */
  private threadDeleter: ((threadId: string) => Promise<void>) | null = null

  constructor(
    private database: Database,
    /** Injectable clock so schedule-anchor bookkeeping is deterministic in tests. */
    private now: () => number = () => Date.now()
  ) {
    this.routineRepo = new RoutineRepo(database)
    this.threadRepo = new ThreadRepo(database)
  }

  /** Attach the canonical thread deleter used when a routine is deleted. */
  attachThreadDeleter(deleter: (threadId: string) => Promise<void>): void {
    this.threadDeleter = deleter
  }

  /**
   * Every routine in sidebar order: pinned first, then the user's manual
   * arrangement, then creation (newest first). `sortRoutines` is the single
   * definition of that order, shared with the sidebar that renders it, so no
   * routine ever moves because someone edited it.
   */
  listRoutines(): Routine[] {
    return sortRoutines(this.routineRepo.list())
  }

  /**
   * The sidebar position a routine created right now takes: above every
   * routine the user has already arranged, so a fresh routine still reads as
   * the newest one whatever the arrangement looks like. Dragged positions are
   * non-negative and start at 0, so a negative stamp sits above all of them,
   * while two routines created minutes apart stay in creation order.
   *
   * Returned without reading the table: a synchronous read here would be a new
   * main-thread SQLite read on the create path.
   */
  private topPosition(): number {
    return -this.now()
  }

  getRoutine(routineId: string): Routine | null {
    return this.routineRepo.get(routineId)
  }

  createRoutine(input: CreateRoutineInput): Routine {
    const now = this.now()
    // An unscheduled routine has no schedule at all: the flag is authoritative,
    // so a caller that passes both is read as unscheduled and its schedule is
    // dropped rather than kept hidden behind the flag.
    const scheduled = input.scheduled ?? true
    const routine: Routine = {
      id: generateId(),
      name: input.name.trim() || 'New Routine',
      description: input.description?.trim() || undefined,
      scheduled,
      color: input.color ?? pickColorForSeed(input.name),
      iconType: input.iconType,
      schedule: scheduled ? (input.schedule ?? null) : null,
      scheduleUpdatedAt: scheduled && input.schedule ? now : undefined,
      howTo: input.howTo ?? '',
      howToUpdatedAt: input.howTo ? now : undefined,
      connections: input.connections ?? [],
      delivery: input.delivery,
      priority: input.priority,
      agents: input.agents,
      execution: input.execution,
      paused: input.paused ?? false,
      sortOrder: this.topPosition(),
      createdAt: now,
      updatedAt: now
    }
    this.routineRepo.upsert(routine)
    return routine
  }

  updateRoutine(routineId: string, input: UpdateRoutineInput): Routine {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)
    const now = this.now()
    const howToChanged = input.howTo !== undefined && input.howTo !== existing.howTo
    const scheduleChanged =
      input.schedule !== undefined && !schedulesEqual(input.schedule, existing.schedule)
    // The schedule's clock starts when the schedule is set and when the routine
    // first becomes runnable (its how-to is written), because the authoring
    // flow saves the how-to and the schedule in one call. A due slot before
    // this moment was never really due, so it is neither fired nor recorded as
    // missed.
    const nextHowTo = input.howTo ?? existing.howTo
    const becameRunnable = routineFirstHowToSave(existing, { howTo: nextHowTo })
    // The flag is the authority on whether a schedule exists. Turning it off
    // clears the schedule outright, so nothing downstream can fire a slot the
    // routine no longer has; turning it back on leaves the routine re-authored
    // rather than silently restoring a cadence the user may have forgotten.
    const scheduled = input.scheduled ?? routineIsScheduled(existing)
    const nextSchedule = scheduled
      ? input.schedule !== undefined
        ? input.schedule
        : existing.schedule
      : null
    const updated: Routine = {
      ...existing,
      name: input.name?.trim() || existing.name,
      description:
        'description' in input ? input.description?.trim() || undefined : existing.description,
      scheduled,
      color: 'color' in input ? (input.color ?? undefined) : existing.color,
      icon: input.icon === null ? undefined : (input.icon ?? existing.icon),
      iconType: 'iconType' in input ? (input.iconType ?? undefined) : existing.iconType,
      customSvg: 'customSvg' in input ? (input.customSvg ?? undefined) : existing.customSvg,
      schedule: nextSchedule,
      scheduleUpdatedAt: scheduled
        ? scheduleChanged || becameRunnable
          ? now
          : existing.scheduleUpdatedAt
        : undefined,
      howTo: nextHowTo,
      howToUpdatedAt: howToChanged ? now : existing.howToUpdatedAt,
      connections: input.connections ?? existing.connections,
      delivery: 'delivery' in input ? (input.delivery ?? undefined) : existing.delivery,
      priority: 'priority' in input ? (input.priority ?? undefined) : existing.priority,
      agents: input.agents !== undefined ? input.agents : existing.agents,
      execution: 'execution' in input ? (input.execution ?? undefined) : existing.execution,
      paused: input.paused !== undefined ? input.paused : existing.paused,
      updatedAt: now
    }
    this.routineRepo.upsert(updated)
    return updated
  }

  /**
   * Store a custom icon image for a routine, mirroring project icon storage.
   * The previous icon file is replaced; the routine's colour and SVG icon type
   * stay in place so clearing the image later restores the prior appearance.
   */
  async setIcon(routineId: string, image: CustomIconImage): Promise<Routine> {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)

    const iconFile = await storeCustomIconFile(getRoutinePath(routineId), image, existing.icon)
    const updated: Routine = { ...existing, icon: iconFile, updatedAt: this.now() }
    this.routineRepo.upsert(updated)
    return updated
  }

  /** Remove a routine's custom icon image, if it has one. */
  async clearIcon(routineId: string): Promise<Routine> {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)

    if (existing.icon) await removeIconFile(getRoutinePath(routineId), existing.icon)

    const updated: Routine = { ...existing, icon: undefined, updatedAt: this.now() }
    this.routineRepo.upsert(updated)
    return updated
  }

  /** Read a routine's custom icon image as a data URL, or null when it has none. */
  async getIconDataUrl(routineId: string): Promise<string | null> {
    const routine = this.routineRepo.get(routineId)
    if (!routine?.icon) return null
    return readIconDataUrl(getRoutinePath(routineId), routine.icon)
  }

  /**
   * Delete a routine and every thread it owns   the hidden how-to thread
   * included   so nothing survives pointing at a routine that no longer
   * exists.
   *
   * Swept in two passes. Roots first   the routine's tasks and its how-to
   * thread   because a task owns its runs: the canonical deleter already sweeps
   * a task's runs (`assistantRunDescendants`), so handing it a run id whose task
   * was just removed would fail the whole routine deletion on "thread not
   * found". The second pass sweeps whatever the roots did not cover: runs whose
   * task lives outside the routine, and any thread a concurrent sweep left
   * behind.
   *
   * Threads go through the canonical deleter when one is attached (the app
   * always attaches it); without one they are ungrouped instead, so a unit
   * context can never leave a dangling `routineId`.
   *
   * The routine's artifact folder goes with it, and the returned summary is what
   * lets the caller clear the scheduler's records for the removed tasks and tell
   * the user what was swept.
   */
  async deleteRoutine(routineId: string): Promise<RoutineDeletionResult> {
    // Collected across both passes, keyed by id, so a run an earlier pass already
    // swept is still counted and reported.
    const owned = new Map<string, Thread>()
    const collect = (threads: Thread[]): void => {
      for (const thread of threads) owned.set(thread.id, thread)
    }
    collect(this.allRoutineThreads(routineId))
    for (const thread of owned.values()) {
      if (isAssistantRunThread(thread)) continue
      await this.removeRoutineThread(thread)
    }
    const leftovers = this.allRoutineThreads(routineId)
    collect(leftovers)
    for (const thread of leftovers) {
      await this.removeRoutineThread(thread)
    }
    this.routineRepo.delete(routineId)
    const artifactsRemoved = await this.removeRoutineArtifacts(routineId)
    const threads = [...owned.values()]
    return {
      removedThreadIds: threads.map((thread) => thread.id),
      taskCount: threads.filter(
        (thread) => !isAssistantRunThread(thread) && !isAssistantSetupThread(thread)
      ).length,
      runCount: threads.filter(isAssistantRunThread).length,
      artifactsRemoved
    }
  }

  /**
   * Remove the directories a routine owns on disk   its icon and how-to
   * checkpoint folder, and the workspace its tasks ran in. Best-effort, exactly
   * like project deletion: the database rows are already gone either way, so a
   * failed removal is reported to the caller instead of thrown, and logged.
   */
  private async removeRoutineArtifacts(routineId: string): Promise<boolean> {
    let removed = true
    for (const directory of routineOwnedDirectories(routineId)) {
      try {
        // `force` treats an already-missing directory as removed; a real failure
        // (permissions, a path that is a file) still throws.
        await rm(directory, { recursive: true, force: true })
      } catch (error) {
        removed = false
        Logger.error('Routine artifact directory could not be removed', {
          routineId,
          directory,
          error: String(error)
        })
      }
    }
    return removed
  }

  /**
   * Remove one thread from the routine's ownership. A thread that is already
   * gone is not a failure: it was swept as a descendant of another deletion or
   * removed concurrently, which is exactly the outcome this wants. A thread
   * that still exists keeps its error, so a real cleanup failure is never
   * swallowed.
   */
  private async removeRoutineThread(thread: Thread): Promise<void> {
    if (!this.threadDeleter) {
      const ungrouped: Thread = { ...thread, routineId: undefined, updatedAt: this.now() }
      this.threadRepo.upsert(ungrouped)
      return
    }
    try {
      await this.threadDeleter(thread.id)
    } catch (error) {
      if (!this.threadRepo.get(thread.id)) return
      throw error
    }
  }

  /** Pin or unpin a routine. Pinning records the time so newest pins sort first. */
  setPinned(routineId: string, pinned: boolean): Routine {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)
    const updated: Routine = {
      ...existing,
      pinned,
      pinnedAt: pinned ? this.now() : undefined,
      updatedAt: this.now()
    }
    this.routineRepo.upsert(updated)
    return updated
  }

  /**
   * Apply the user's drag arrangement: the given ids in the given order, from
   * the top down. A position is not content, so `updatedAt` stays where it was
   * and the routine's "updated" label keeps reporting its last real edit.
   */
  reorderRoutines(orderedIds: string[]): Routine[] {
    const result: Routine[] = []
    for (let index = 0; index < orderedIds.length; index++) {
      const existing = this.routineRepo.get(orderedIds[index])
      if (!existing) continue
      const updated: Routine = { ...existing, sortOrder: index }
      this.routineRepo.upsert(updated)
      result.push(updated)
    }
    return result
  }

  /**
   * Every assistant task thread, newest activity first. Run threads are not
   * tasks: a run is one execution of a task, so it is never listed here, never
   * scheduled, and never counted as a task in a routine.
   */
  listAssistantTasks(): Thread[] {
    // Archived tasks are hidden tasks: they keep their thread and their
    // history but are never listed, scheduled, or counted again.
    return [...this.threadRepo.listByProject(ASSISTANT_SPACE_ID, { includeArchived: false })]
      .filter((thread) => !isAssistantRunThread(thread))
      .sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /**
   * Every run of one task, newest first. A run is a fresh thread per execution
   * (`Thread.assistantTaskId`), so it never lands in the task's own
   * conversation and the two never blur together.
   */
  listTaskRuns(taskId: string): Thread[] {
    return this.threadRepo
      .listByProject(ASSISTANT_SPACE_ID, { includeArchived: false })
      .filter((thread) => thread.assistantTaskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The task a run thread belongs to, or null when it is not a run. */
  taskIdForRun(runThreadId: string): string | null {
    return this.threadRepo.get(runThreadId)?.assistantTaskId ?? null
  }

  /** Tasks grouped under one routine, ordered by activity. */
  listRoutineTasks(routineId: string): Thread[] {
    return this.listAssistantTasks().filter((task) => task.routineId === routineId)
  }

  /** Every thread of a routine, hidden ones included. */
  private allRoutineThreads(routineId: string): Thread[] {
    return this.threadRepo
      .listByProject(ASSISTANT_SPACE_ID)
      .filter((task) => task.routineId === routineId)
  }

  /**
   * The routine's how-to ("Getting started") thread, whether or not it is
   * hidden. A routine is created with exactly one, the user can only hide it,
   * so this is how the panel knows what it is hiding and revealing.
   */
  howToThread(routineId: string): Thread | null {
    const threads = this.allRoutineThreads(routineId).filter(isAssistantSetupThread)
    if (threads.length === 0) return null
    return threads.reduce((newest, thread) =>
      thread.createdAt > newest.createdAt ? thread : newest
    )
  }

  /**
   * Hide or reveal a routine's how-to thread by archiving it. The thread stays
   * pinned in both states, so it is never evicted and never unpinnable; the
   * archive flag is only what takes it out of the sidebar's lists.
   */
  setHowToHidden(routineId: string, hidden: boolean): Thread {
    const existing = this.howToThread(routineId)
    if (!existing) throw new Error(`Routine has no how-to thread: ${routineId}`)
    const updated: Thread = {
      ...existing,
      archived: hidden,
      pinned: true,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Group a task into a routine, or ungroup it with `null`. */
  setTaskRoutine(threadId: string, routineId: string | null): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = {
      ...existing,
      routineId: routineId ?? undefined,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Set (or clear) a task's per-task schedule override. */
  setTaskScheduleOverride(threadId: string, schedule: RoutineSchedule | null): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = {
      ...existing,
      scheduleOverride: schedule,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /**
   * Turn one function's clock on or off independently of its routine. `true`
   * schedules it even under an unscheduled routine, `false` keeps it off the
   * clock even under a scheduled one, and `null` clears the override so the
   * task follows its routine again.
   */
  setTaskScheduled(threadId: string, scheduled: boolean | null): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = {
      ...existing,
      scheduled: scheduled ?? undefined,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Record that a scheduled run fired on a task. */
  setTaskLastRun(threadId: string, at: number): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = { ...existing, lastRunAt: at, updatedAt: this.now() }
    this.threadRepo.upsert(updated)
    return updated
  }

  /**
   * Record that a run's turn finished successfully on a task. Best-effort: a
   * task removed while its run was in flight simply reports null so the caller
   * does not fail on a deleted row.
   */
  markTaskRunSuccess(threadId: string, at: number): Thread | null {
    const existing = this.threadRepo.get(threadId)
    if (!existing) return null
    const updated: Thread = { ...existing, lastSuccessAt: at, updatedAt: this.now() }
    this.threadRepo.upsert(updated)
    return updated
  }

  /**
   * Record that a run was actually dispatched on a task, scheduled or manual.
   * Kept apart from `setTaskLastRun`, which the scheduler also writes when it
   * only claims a slot as missed, so the panel's "last run" never reports a
   * slot that never ran. Best-effort on a task removed mid-dispatch.
   */
  markTaskRunDispatched(threadId: string, at: number): Thread | null {
    const existing = this.threadRepo.get(threadId)
    if (!existing) return null
    const updated: Thread = { ...existing, lastDispatchedAt: at, updatedAt: this.now() }
    this.threadRepo.upsert(updated)
    return updated
  }

  /**
   * Whether a task runs on a clock at all. The task's own override wins when
   * set, so one function of a routine can be scheduled while another is not,
   * and an unscheduled routine does not force its functions off. Absent, a task
   * follows its routine's flag; a routine-less task is unscheduled unless it
   * carries its own schedule.
   */
  resolveTaskScheduled(task: Thread): boolean {
    if (task.scheduled !== undefined) return task.scheduled
    if (!task.routineId) return task.scheduleOverride !== undefined
    const routine = this.routineRepo.get(task.routineId)
    if (!routine) return task.scheduleOverride !== undefined
    return routineIsScheduled(routine)
  }

  /** The schedule a task runs on: its override when set, else its routine's. A
   *  task that is not scheduled has none, so nothing fires for it. */
  resolveTaskSchedule(task: Thread): RoutineSchedule | null {
    if (!this.resolveTaskScheduled(task)) return null
    if (task.scheduleOverride) return task.scheduleOverride
    if (!task.routineId) return null
    const routine = this.routineRepo.get(task.routineId)
    return routine?.schedule ?? null
  }

  /**
   * The moment a task's schedule became active. The scheduler uses it as the
   * floor below which a due slot was never really due: a schedule cannot have
   * missed a fire that predates it.
   *
   * A task with its own schedule override is anchored to its own creation: the
   * override is the task's schedule, so the routine's schedule clock does not
   * apply to it. A task that inherits its routine's schedule is anchored to the
   * later of its own creation and the routine's schedule clock.
   *
   * The task's own creation is what keeps a thread the user creates *after* the
   * routine was set up from inheriting every slot the routine already passed.
   * Without it, a task created at 11:00 inside a routine that runs daily at
   * 09:00 was immediately badged as having missed that morning's 09:00 fire   a
   * run the task could never have produced, because it did not exist yet.
   */
  resolveTaskScheduleAnchor(task: Thread): number {
    if (!task.routineId || task.scheduleOverride) return task.createdAt
    const routine = this.routineRepo.get(task.routineId)
    const routineAnchor = routine?.scheduleUpdatedAt ?? routine?.createdAt ?? 0
    return Math.max(task.createdAt, routineAnchor)
  }

  /**
   * Whether a task's routine is paused. A paused routine keeps its tasks and
   * how-to but the scheduler never fires them; a routine-less task is never
   * paused.
   */
  isTaskPaused(task: Thread): boolean {
    if (!task.routineId) return false
    return this.routineRepo.get(task.routineId)?.paused === true
  }

  /** The how-to a task runs under, from its routine. */
  resolveTaskHowTo(task: Thread): string {
    if (!task.routineId) return ''
    const routine = this.routineRepo.get(task.routineId)
    return routine?.howTo ?? ''
  }

  /**
   * The model set a task runs on, from its routine. A routine-less task has
   * none: its own thread settings are authoritative.
   */
  resolveTaskAgents(task: Thread): RoutineAgents | undefined {
    if (!task.routineId) return undefined
    return this.routineRepo.get(task.routineId)?.agents
  }
}
