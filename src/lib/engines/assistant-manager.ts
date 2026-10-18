import { generateId, getAssistantPath } from '../utils'
import { rm } from 'fs/promises'
import { readIconDataUrl, removeIconFile, storeCustomIconFile } from '../icon-file'
import type { CustomIconImage } from '../custom-icon'
import {
  ASSISTANT_PLACEHOLDER_NAME,
  ASSISTANT_SPACE_ID,
  isAssistantSetupThread,
  isAssistantRunThread
} from '../types'
import { pickRandomColor } from '../project-colors'
import { sortAssistants } from '../assistant-order'
import { assistantOwnedDirectories } from '../thread-storage-paths'
import { Logger } from '../../main/system/logger'
import type { Database } from '../../main/database/database'
import { AssistantRepo } from '../../main/database/repositories/assistant-repo'
import { ThreadRepo } from '../../main/database/repositories/thread-repo'
import {
  assistantFirstKnowledgeSave,
  assistantIsScheduled,
  type CreateAssistantInput,
  type Assistant,
  type AssistantAgents,
  type AssistantDeletionResult,
  type AssistantSchedule,
  type Thread,
  type UpdateAssistantInput
} from '../types'

/**
 * Whether two schedules are the same, so re-saving an assistant's knowledge does not
 * restart its schedule clock and suppress a genuine missed fire.
 */
function schedulesEqual(
  a: AssistantSchedule | null | undefined,
  b: AssistantSchedule | null | undefined
): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null)
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * AssistantManager   CRUD and task-grouping for assistants.
 *
 * Mirrors ProjectManager's SQLite-backed shape. An assistant owns the knowledge and
 * the default schedule; tasks are assistant-space threads that optionally
 * reference an assistant and may override its schedule.
 */
export class AssistantManager {
  private assistantRepo: AssistantRepo
  private threadRepo: ThreadRepo
  /**
   * Removes a thread through the canonical path (session teardown, DB cleanup,
   * disk artifacts). Attached by the IPC layer once the thread manager exists,
   * so deleting an assistant sweeps its threads instead of orphaning them.
   */
  private threadDeleter: ((threadId: string) => Promise<void>) | null = null

  constructor(
    private database: Database,
    /** Injectable clock so schedule-anchor bookkeeping is deterministic in tests. */
    private now: () => number = () => Date.now()
  ) {
    this.assistantRepo = new AssistantRepo(database)
    this.threadRepo = new ThreadRepo(database)
  }

  /** Attach the canonical thread deleter used when an assistant is deleted. */
  attachThreadDeleter(deleter: (threadId: string) => Promise<void>): void {
    this.threadDeleter = deleter
  }

  /**
   * Every assistant in sidebar order: pinned first, then the user's manual
   * arrangement, then creation (newest first). `sortAssistants` is the single
   * definition of that order, shared with the sidebar that renders it, so no
   * assistant ever moves because someone edited it.
   */
  listAssistants(): Assistant[] {
    return sortAssistants(this.assistantRepo.list())
  }

  /**
   * The sidebar position an assistant created right now takes: above every
   * assistant the user has already arranged, so a fresh assistant still reads as
   * the newest one whatever the arrangement looks like. Dragged positions are
   * non-negative and start at 0, so a negative stamp sits above all of them,
   * while two assistants created minutes apart stay in creation order.
   *
   * Returned without reading the table: a synchronous read here would be a new
   * main-thread SQLite read on the create path.
   */
  private topPosition(): number {
    return -this.now()
  }

  getAssistant(assistantId: string): Assistant | null {
    return this.assistantRepo.get(assistantId)
  }

  createAssistant(input: CreateAssistantInput): Assistant {
    const now = this.now()
    // An unscheduled assistant has no schedule at all: the flag is authoritative,
    // so a caller that passes both is read as unscheduled and its schedule is
    // dropped rather than kept hidden behind the flag.
    const scheduled = input.scheduled ?? true
    const assistant: Assistant = {
      id: generateId(),
      name: input.name.trim() || ASSISTANT_PLACEHOLDER_NAME,
      description: input.description?.trim() || undefined,
      personality: input.personality?.trim() || undefined,
      scheduled,
      // A schedule's name only exists while there is a schedule to name, so an
      // unscheduled assistant never keeps one behind its flag.
      scheduleName: scheduled ? input.scheduleName?.trim() || undefined : undefined,
      // The accent is chosen once, here, and never derived from the name: an
      // assistant built by talking has no name yet, and the one it is given later
      // must not repaint a colour it has already been wearing.
      color: input.color ?? pickRandomColor(),
      iconType: input.iconType,
      schedule: scheduled ? (input.schedule ?? null) : null,
      scheduleUpdatedAt: scheduled && input.schedule ? now : undefined,
      knowledge: input.knowledge ?? '',
      knowledgeUpdatedAt: input.knowledge ? now : undefined,
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
    this.assistantRepo.upsert(assistant)
    return assistant
  }

  updateAssistant(assistantId: string, input: UpdateAssistantInput): Assistant {
    const existing = this.assistantRepo.get(assistantId)
    if (!existing) throw new Error(`Assistant not found: ${assistantId}`)
    const now = this.now()
    const knowledgeChanged = input.knowledge !== undefined && input.knowledge !== existing.knowledge
    const scheduleChanged =
      input.schedule !== undefined && !schedulesEqual(input.schedule, existing.schedule)
    // The schedule's clock starts when the schedule is set and when the assistant
    // first becomes runnable (its knowledge is written), because the authoring
    // flow saves the knowledge and the schedule in one call. A due slot before
    // this moment was never really due, so it is neither fired nor recorded as
    // missed.
    const nextKnowledge = input.knowledge ?? existing.knowledge
    const becameRunnable = assistantFirstKnowledgeSave(existing, { knowledge: nextKnowledge })
    // The flag is the authority on whether a schedule exists. Turning it off
    // clears the schedule outright, so nothing downstream can fire a slot the
    // assistant no longer has; turning it back on leaves the assistant re-authored
    // rather than silently restoring a cadence the user may have forgotten.
    const scheduled = input.scheduled ?? assistantIsScheduled(existing)
    const nextSchedule = scheduled
      ? input.schedule !== undefined
        ? input.schedule
        : existing.schedule
      : null
    const updated: Assistant = {
      ...existing,
      name: input.name?.trim() || existing.name,
      description:
        'description' in input ? input.description?.trim() || undefined : existing.description,
      personality:
        'personality' in input ? input.personality?.trim() || undefined : existing.personality,
      scheduled,
      scheduleName: scheduled
        ? 'scheduleName' in input
          ? input.scheduleName?.trim() || undefined
          : existing.scheduleName
        : undefined,
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
      knowledge: nextKnowledge,
      knowledgeUpdatedAt: knowledgeChanged ? now : existing.knowledgeUpdatedAt,
      connections: input.connections ?? existing.connections,
      delivery: 'delivery' in input ? (input.delivery ?? undefined) : existing.delivery,
      priority: 'priority' in input ? (input.priority ?? undefined) : existing.priority,
      agents: input.agents !== undefined ? input.agents : existing.agents,
      execution: 'execution' in input ? (input.execution ?? undefined) : existing.execution,
      paused: input.paused !== undefined ? input.paused : existing.paused,
      updatedAt: now
    }
    this.assistantRepo.upsert(updated)
    return updated
  }

  /**
   * Store a custom icon image for an assistant, mirroring project icon storage.
   * The previous icon file is replaced; the assistant's colour and SVG icon type
   * stay in place so clearing the image later restores the prior appearance.
   */
  async setIcon(assistantId: string, image: CustomIconImage): Promise<Assistant> {
    const existing = this.assistantRepo.get(assistantId)
    if (!existing) throw new Error(`Assistant not found: ${assistantId}`)

    const iconFile = await storeCustomIconFile(getAssistantPath(assistantId), image, existing.icon)
    const updated: Assistant = { ...existing, icon: iconFile, updatedAt: this.now() }
    this.assistantRepo.upsert(updated)
    return updated
  }

  /** Remove an assistant's custom icon image, if it has one. */
  async clearIcon(assistantId: string): Promise<Assistant> {
    const existing = this.assistantRepo.get(assistantId)
    if (!existing) throw new Error(`Assistant not found: ${assistantId}`)

    if (existing.icon) await removeIconFile(getAssistantPath(assistantId), existing.icon)

    const updated: Assistant = { ...existing, icon: undefined, updatedAt: this.now() }
    this.assistantRepo.upsert(updated)
    return updated
  }

  /** Read an assistant's custom icon image as a data URL, or null when it has none. */
  async getIconDataUrl(assistantId: string): Promise<string | null> {
    const assistant = this.assistantRepo.get(assistantId)
    if (!assistant?.icon) return null
    return readIconDataUrl(getAssistantPath(assistantId), assistant.icon)
  }

  /**
   * Delete an assistant and every thread it owns   the hidden knowledge thread
   * included   so nothing survives pointing at an assistant that no longer
   * exists.
   *
   * Swept in two passes. Roots first   the assistant's tasks and its knowledge
   * thread   because a task owns its runs: the canonical deleter already sweeps
   * a task's runs (`assistantRunDescendants`), so handing it a run id whose task
   * was just removed would fail the whole assistant deletion on "thread not
   * found". The second pass sweeps whatever the roots did not cover: runs whose
   * task lives outside the assistant, and any thread a concurrent sweep left
   * behind.
   *
   * Threads go through the canonical deleter when one is attached (the app
   * always attaches it); without one they are ungrouped instead, so a unit
   * context can never leave a dangling `assistantId`.
   *
   * The assistant's artifact folder goes with it, and the returned summary is what
   * lets the caller clear the scheduler's records for the removed tasks and tell
   * the user what was swept.
   */
  async deleteAssistant(assistantId: string): Promise<AssistantDeletionResult> {
    // Collected across both passes, keyed by id, so a run an earlier pass already
    // swept is still counted and reported.
    const owned = new Map<string, Thread>()
    const collect = (threads: Thread[]): void => {
      for (const thread of threads) owned.set(thread.id, thread)
    }
    collect(this.allAssistantThreads(assistantId))
    for (const thread of owned.values()) {
      if (isAssistantRunThread(thread)) continue
      await this.removeAssistantThread(thread)
    }
    const leftovers = this.allAssistantThreads(assistantId)
    collect(leftovers)
    for (const thread of leftovers) {
      await this.removeAssistantThread(thread)
    }
    this.assistantRepo.delete(assistantId)
    const artifactsRemoved = await this.removeAssistantArtifacts(assistantId)
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
   * Remove the directories an assistant owns on disk   its icon and knowledge
   * checkpoint folder, and the workspace its tasks ran in. Best-effort, exactly
   * like project deletion: the database rows are already gone either way, so a
   * failed removal is reported to the caller instead of thrown, and logged.
   */
  private async removeAssistantArtifacts(assistantId: string): Promise<boolean> {
    let removed = true
    for (const directory of assistantOwnedDirectories(assistantId)) {
      try {
        // `force` treats an already-missing directory as removed; a real failure
        // (permissions, a path that is a file) still throws.
        await rm(directory, { recursive: true, force: true })
      } catch (error) {
        removed = false
        Logger.error('Assistant artifact directory could not be removed', {
          assistantId,
          directory,
          error: String(error)
        })
      }
    }
    return removed
  }

  /**
   * Remove one thread from the assistant's ownership. A thread that is already
   * gone is not a failure: it was swept as a descendant of another deletion or
   * removed concurrently, which is exactly the outcome this wants. A thread
   * that still exists keeps its error, so a real cleanup failure is never
   * swallowed.
   */
  private async removeAssistantThread(thread: Thread): Promise<void> {
    if (!this.threadDeleter) {
      const ungrouped: Thread = { ...thread, assistantId: undefined, updatedAt: this.now() }
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

  /** Pin or unpin an assistant. Pinning records the time so newest pins sort first. */
  setPinned(assistantId: string, pinned: boolean): Assistant {
    const existing = this.assistantRepo.get(assistantId)
    if (!existing) throw new Error(`Assistant not found: ${assistantId}`)
    const updated: Assistant = {
      ...existing,
      pinned,
      pinnedAt: pinned ? this.now() : undefined,
      updatedAt: this.now()
    }
    this.assistantRepo.upsert(updated)
    return updated
  }

  /**
   * Apply the user's drag arrangement: the given ids in the given order, from
   * the top down. A position is not content, so `updatedAt` stays where it was
   * and the assistant's "updated" label keeps reporting its last real edit.
   */
  reorderAssistants(orderedIds: string[]): Assistant[] {
    const result: Assistant[] = []
    for (let index = 0; index < orderedIds.length; index++) {
      const existing = this.assistantRepo.get(orderedIds[index])
      if (!existing) continue
      const updated: Assistant = { ...existing, sortOrder: index }
      this.assistantRepo.upsert(updated)
      result.push(updated)
    }
    return result
  }

  /**
   * Every assistant task thread, newest activity first. Run threads are not
   * tasks: a run is one execution of a task, so it is never listed here, never
   * scheduled, and never counted as a task in an assistant.
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

  /** Tasks grouped under one assistant, ordered by activity. */
  listAssistantTasksFor(assistantId: string): Thread[] {
    return this.listAssistantTasks().filter((task) => task.assistantId === assistantId)
  }

  /** Every thread of an assistant, hidden ones included. */
  private allAssistantThreads(assistantId: string): Thread[] {
    return this.threadRepo
      .listByProject(ASSISTANT_SPACE_ID)
      .filter((task) => task.assistantId === assistantId)
  }

  /**
   * The assistant's knowledge ("Getting started") thread, whether or not it is
   * hidden. An assistant is created with exactly one, the user can only hide it,
   * so this is how the panel knows what it is hiding and revealing.
   */
  knowledgeThread(assistantId: string): Thread | null {
    const threads = this.allAssistantThreads(assistantId).filter(isAssistantSetupThread)
    if (threads.length === 0) return null
    return threads.reduce((newest, thread) =>
      thread.createdAt > newest.createdAt ? thread : newest
    )
  }

  /**
   * Hide or reveal an assistant's knowledge thread by archiving it. The thread stays
   * pinned in both states, so it is never evicted and never unpinnable; the
   * archive flag is only what takes it out of the sidebar's lists.
   */
  setKnowledgeHidden(assistantId: string, hidden: boolean): Thread {
    const existing = this.knowledgeThread(assistantId)
    if (!existing) throw new Error(`Assistant has no knowledge thread: ${assistantId}`)
    const updated: Thread = {
      ...existing,
      archived: hidden,
      pinned: true,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Group a task into an assistant, or ungroup it with `null`. */
  assignTask(threadId: string, assistantId: string | null): Thread {
    const existing = this.threadRepo.get(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    const updated: Thread = {
      ...existing,
      assistantId: assistantId ?? undefined,
      updatedAt: this.now()
    }
    this.threadRepo.upsert(updated)
    return updated
  }

  /** Set (or clear) a task's per-task schedule override. */
  setTaskScheduleOverride(threadId: string, schedule: AssistantSchedule | null): Thread {
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
   * Turn one function's clock on or off independently of its assistant. `true`
   * schedules it even under an unscheduled assistant, `false` keeps it off the
   * clock even under a scheduled one, and `null` clears the override so the
   * task follows its assistant again.
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
   * set, so one function of an assistant can be scheduled while another is not,
   * and an unscheduled assistant does not force its functions off. Absent, a task
   * follows its assistant's flag; an assistant-less task is unscheduled unless it
   * carries its own schedule.
   */
  resolveTaskScheduled(task: Thread): boolean {
    if (task.scheduled !== undefined) return task.scheduled
    if (!task.assistantId) return task.scheduleOverride !== undefined
    const assistant = this.assistantRepo.get(task.assistantId)
    if (!assistant) return task.scheduleOverride !== undefined
    return assistantIsScheduled(assistant)
  }

  /** The schedule a task runs on: its override when set, else its assistant's. A
   *  task that is not scheduled has none, so nothing fires for it. */
  resolveTaskSchedule(task: Thread): AssistantSchedule | null {
    if (!this.resolveTaskScheduled(task)) return null
    if (task.scheduleOverride) return task.scheduleOverride
    if (!task.assistantId) return null
    const assistant = this.assistantRepo.get(task.assistantId)
    return assistant?.schedule ?? null
  }

  /**
   * The moment a task's schedule became active. The scheduler uses it as the
   * floor below which a due slot was never really due: a schedule cannot have
   * missed a fire that predates it.
   *
   * A task with its own schedule override is anchored to its own creation: the
   * override is the task's schedule, so the assistant's schedule clock does not
   * apply to it. A task that inherits its assistant's schedule is anchored to the
   * later of its own creation and the assistant's schedule clock.
   *
   * The task's own creation is what keeps a thread the user creates *after* the
   * assistant was set up from inheriting every slot the assistant already passed.
   * Without it, a task created at 11:00 inside an assistant that runs daily at
   * 09:00 was immediately badged as having missed that morning's 09:00 fire   a
   * run the task could never have produced, because it did not exist yet.
   */
  resolveTaskScheduleAnchor(task: Thread): number {
    if (!task.assistantId || task.scheduleOverride) return task.createdAt
    const assistant = this.assistantRepo.get(task.assistantId)
    const assistantAnchor = assistant?.scheduleUpdatedAt ?? assistant?.createdAt ?? 0
    return Math.max(task.createdAt, assistantAnchor)
  }

  /**
   * Whether a task's assistant is paused. A paused assistant keeps its tasks and
   * knowledge but the scheduler never fires them; an assistant-less task is never
   * paused.
   */
  isTaskPaused(task: Thread): boolean {
    if (!task.assistantId) return false
    return this.assistantRepo.get(task.assistantId)?.paused === true
  }

  /** The knowledge a task runs under, from its assistant. */
  resolveTaskKnowledge(task: Thread): string {
    if (!task.assistantId) return ''
    const assistant = this.assistantRepo.get(task.assistantId)
    return assistant?.knowledge ?? ''
  }

  /**
   * The model set a task runs on, from its assistant. An assistant-less task has
   * none: its own thread settings are authoritative.
   */
  resolveTaskAgents(task: Thread): AssistantAgents | undefined {
    if (!task.assistantId) return undefined
    return this.assistantRepo.get(task.assistantId)?.agents
  }
}
