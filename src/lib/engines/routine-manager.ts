import { generateId, getRoutinePath } from '../utils'
import { extname } from 'path'
import {
  isSupportedIconExtension,
  readIconDataUrl,
  removeIconFile,
  storeIconFile
} from '../icon-file'
import { ASSISTANT_SPACE_ID } from '../types'
import { pickColorForSeed } from '../project-colors'
import type { Database } from '../../main/database/database'
import { RoutineRepo } from '../../main/database/repositories/routine-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import type {
  CreateRoutineInput,
  Routine,
  RoutineAgents,
  RoutineSchedule,
  Thread,
  UpdateRoutineInput
} from '../types'

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

  constructor(private database: Database) {
    this.routineRepo = new RoutineRepo(database)
    this.threadRepo = new ThreadRepo(database)
  }

  listRoutines(): Routine[] {
    return this.routineRepo.list()
  }

  getRoutine(routineId: string): Routine | null {
    return this.routineRepo.get(routineId)
  }

  createRoutine(input: CreateRoutineInput): Routine {
    const now = Date.now()
    const routine: Routine = {
      id: generateId(),
      name: input.name.trim() || 'New Routine',
      color: input.color ?? pickColorForSeed(input.name),
      iconType: input.iconType,
      schedule: input.schedule ?? null,
      howTo: input.howTo ?? '',
      howToUpdatedAt: input.howTo ? now : undefined,
      connections: input.connections ?? [],
      agents: input.agents,
      paused: input.paused ?? false,
      createdAt: now,
      updatedAt: now
    }
    this.routineRepo.upsert(routine)
    return routine
  }

  updateRoutine(routineId: string, input: UpdateRoutineInput): Routine {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)
    const now = Date.now()
    const howToChanged = input.howTo !== undefined && input.howTo !== existing.howTo
    const updated: Routine = {
      ...existing,
      name: input.name?.trim() || existing.name,
      color: 'color' in input ? (input.color ?? undefined) : existing.color,
      icon: input.icon === null ? undefined : (input.icon ?? existing.icon),
      iconType: 'iconType' in input ? (input.iconType ?? undefined) : existing.iconType,
      schedule: input.schedule !== undefined ? input.schedule : existing.schedule,
      howTo: input.howTo ?? existing.howTo,
      howToUpdatedAt: howToChanged ? now : existing.howToUpdatedAt,
      connections: input.connections ?? existing.connections,
      agents: input.agents !== undefined ? input.agents : existing.agents,
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
  async setIcon(routineId: string, sourcePath: string): Promise<Routine> {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)

    const ext = extname(sourcePath).toLowerCase() || '.png'
    if (!isSupportedIconExtension(ext)) throw new Error(`Unsupported icon format: ${ext}`)

    const iconFile = await storeIconFile(getRoutinePath(routineId), sourcePath, existing.icon)
    const updated: Routine = { ...existing, icon: iconFile, updatedAt: Date.now() }
    this.routineRepo.upsert(updated)
    return updated
  }

  /** Remove a routine's custom icon image, if it has one. */
  async clearIcon(routineId: string): Promise<Routine> {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)

    if (existing.icon) await removeIconFile(getRoutinePath(routineId), existing.icon)

    const updated: Routine = { ...existing, icon: undefined, updatedAt: Date.now() }
    this.routineRepo.upsert(updated)
    return updated
  }

  /** Read a routine's custom icon image as a data URL, or null when it has none. */
  async getIconDataUrl(routineId: string): Promise<string | null> {
    const routine = this.routineRepo.get(routineId)
    if (!routine?.icon) return null
    return readIconDataUrl(getRoutinePath(routineId), routine.icon)
  }

  /** Delete a routine and ungroup its tasks (they survive as routine-less). */
  deleteRoutine(routineId: string): void {
    const tasks = this.listRoutineTasks(routineId)
    for (const task of tasks) {
      const ungrouped: Thread = { ...task, routineId: undefined, updatedAt: Date.now() }
      this.threadRepo.upsert(ungrouped)
    }
    this.routineRepo.delete(routineId)
  }

  /** Pin or unpin a routine. Pinning records the time so newest pins sort first. */
  setPinned(routineId: string, pinned: boolean): Routine {
    const existing = this.routineRepo.get(routineId)
    if (!existing) throw new Error(`Routine not found: ${routineId}`)
    const updated: Routine = {
      ...existing,
      pinned,
      pinnedAt: pinned ? Date.now() : undefined,
      updatedAt: Date.now()
    }
    this.routineRepo.upsert(updated)
    return updated
  }

  reorderRoutines(orderedIds: string[]): Routine[] {
    const result: Routine[] = []
    for (let index = 0; index < orderedIds.length; index++) {
      const existing = this.routineRepo.get(orderedIds[index])
      if (!existing) continue
      const updated: Routine = { ...existing, sortOrder: index, updatedAt: Date.now() }
      this.routineRepo.upsert(updated)
      result.push(updated)
    }
    return result
  }

  /** Every assistant task thread, newest activity first. */
  listAssistantTasks(): Thread[] {
    return [...this.threadRepo.listByProject(ASSISTANT_SPACE_ID)].sort(
      (a, b) => b.lastActivity - a.lastActivity
    )
  }

  /** Tasks grouped under one routine, ordered by activity. */
  listRoutineTasks(routineId: string): Thread[] {
    return this.listAssistantTasks().filter((task) => task.routineId === routineId)
  }

  /** Group a task into a routine, or ungroup it with `null`. */
  setTaskRoutine(threadId: string, routineId: string | null): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = {
      ...existing,
      routineId: routineId ?? undefined,
      updatedAt: Date.now()
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
      updatedAt: Date.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Record that a scheduled run fired on a task. */
  setTaskLastRun(threadId: string, at: number): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = { ...existing, lastRunAt: at, updatedAt: Date.now() }
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
    const updated: Thread = { ...existing, lastSuccessAt: at, updatedAt: Date.now() }
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
    const updated: Thread = { ...existing, lastDispatchedAt: at, updatedAt: Date.now() }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** The schedule a task runs on: its override when set, else its routine's. */
  resolveTaskSchedule(task: Thread): RoutineSchedule | null {
    if (task.scheduleOverride) return task.scheduleOverride
    if (!task.routineId) return null
    const routine = this.routineRepo.get(task.routineId)
    return routine?.schedule ?? null
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
