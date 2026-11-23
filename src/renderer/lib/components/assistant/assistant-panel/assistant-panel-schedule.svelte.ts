import { SvelteSet } from 'svelte/reactivity'
import type { Thread } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'

/**
 * Every task an assistant owns, and the one place the Schedule tab writes them.
 *
 * The list is read from the database, not from the threads this window happens to
 * have loaded: a task Don scheduled is owned by the assistant in charge, so it
 * belongs on that assistant's clock even if the user never opened it. Newest
 * created first, so a task the user just set up is the first one they see.
 *
 * Writes go through here so the tab's per-row switch and its bulk actions share
 * one path, one set of pending marks, and one error surface.
 */
export class AssistantPanelSchedule {
  /** The assistant's tasks, newest created first. */
  tasks = $state<Thread[]>([])
  /** Rows mid-write, so one control cannot double-fire while its own write is out. */
  private pending = new SvelteSet<string>()
  /** True while a bulk action is writing. */
  busy = $state(false)
  /** The assistant the list currently belongs to. */
  private loadedFor: string | null = null
  /** The newest read, so an older slow one cannot overwrite a newer list. */
  private ticket = 0

  /** Read the list for one assistant. A repeat call for the same one is a no-op. */
  async load(assistantId: string | null): Promise<void> {
    if (!assistantId) {
      this.tasks = []
      this.loadedFor = null
      return
    }
    if (this.loadedFor === assistantId) return
    this.loadedFor = assistantId
    const token = ++this.ticket
    try {
      const rows = await assistants.listTasks(assistantId)
      if (token !== this.ticket) return
      this.tasks = rows
    } catch (error) {
      if (token === this.ticket) this.loadedFor = null
      reportError(error, 'Could not read this assistant\u2019s tasks')
    }
  }

  /** Whether one row's write is out, so its control reads as busy. */
  isPending(taskId: string): boolean {
    return this.pending.has(taskId)
  }

  /** Whether one task runs on the clock. Unset follows the assistant, which is on here. */
  isScheduled(task: Thread): boolean {
    return task.scheduled !== false
  }

  /** Whether every listed task has been taken off the clock. */
  get allPaused(): boolean {
    return this.tasks.length > 0 && this.tasks.every((task) => !this.isScheduled(task))
  }

  /**
   * Pause or resume one task. Pausing writes the task's own flag; resuming clears
   * it, so the task follows its assistant again and a later clock change carries
   * it along.
   */
  async setOne(task: Thread, next: boolean): Promise<void> {
    if (this.pending.has(task.id)) return
    this.pending.add(task.id)
    try {
      this.replace(await assistants.setTaskScheduled(task.id, next ? null : false))
    } catch (error) {
      reportError(error, 'Could not change this function\u2019s schedule')
    } finally {
      this.pending.delete(task.id)
    }
  }

  /** Take every task of this assistant off the clock in one write. */
  async pauseAll(assistantId: string): Promise<void> {
    await this.setAll(assistantId, false, 'Could not pause the schedule for these tasks')
  }

  /** Put every task back on the assistant's clock in one write. */
  async resumeAll(assistantId: string): Promise<void> {
    await this.setAll(assistantId, null, 'Could not put these tasks back on the schedule')
  }

  /**
   * Delete every task of this assistant, and with each one its runs. The task's
   * thread is what the scheduler fires, so removing it is what ends the job; the
   * runs hang off it and would otherwise be left with nothing to belong to.
   */
  async deleteAll(assistantId: string): Promise<void> {
    const doomed = this.tasks.filter((task) => task.assistantId === assistantId)
    if (doomed.length === 0) return
    this.busy = true
    const removed: string[] = []
    try {
      for (const task of doomed) {
        try {
          await invoke('thread:delete', task.projectId, task.id)
          removed.push(task.id)
        } catch (error) {
          reportError(error, `Could not delete ${task.title}`)
        }
      }
      this.tasks = this.tasks.filter((task) => !removed.includes(task.id))
    } finally {
      this.busy = false
    }
  }

  private async setAll(
    assistantId: string,
    scheduled: boolean | null,
    failure: string
  ): Promise<void> {
    this.busy = true
    try {
      const rows = await assistants.setTasksScheduled(assistantId, scheduled)
      this.tasks = rows
    } catch (error) {
      reportError(error, failure)
    } finally {
      this.busy = false
    }
  }

  /** Patch one row in place, keeping the newest-created-first order. */
  private replace(updated: Thread): void {
    this.tasks = this.tasks.map((task) => (task.id === updated.id ? updated : task))
  }
}
