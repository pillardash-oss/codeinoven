import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import {
  nextRunAt,
  type MissedRun,
  type Routine,
  type RoutineAgents,
  type RoutineConnection,
  type RoutineSchedule,
  type Thread
} from '$shared/types'

/**
 * AssistantRoutines   the renderer's live view of assistant routines and the
 * pending missed scheduled runs.
 *
 * Both lists arrive as full snapshots from the main process: routine mutations
 * broadcast the whole list, and the scheduler broadcasts the whole pending
 * missed-run list. Batched full-list replacement keeps badge counts consistent
 * without per-item reconcile churn.
 */
class AssistantRoutinesState {
  routines: Routine[] = $state([])
  missedRuns: MissedRun[] = $state([])
  /** Custom icon data URLs for routines that store one, keyed by routine id. */
  iconUrls: SvelteMap<string, string> = $state(new SvelteMap())
  private initialized = false
  private disposers: Array<() => void> = []

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.disposers.push(
      subscribe('routine:changed', (routines) => {
        this.routines = routines
        void this.refreshIcons()
      }),
      subscribe('assistant:missedRunsChanged', (runs) => {
        this.missedRuns = runs
      })
    )
    void this.ensureSpace().catch(() => undefined)
    void this.refresh()
    void this.refreshMissedRuns()
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.initialized = false
  }

  async refresh(): Promise<void> {
    this.routines = await invoke('routine:list')
    await this.refreshIcons()
  }

  /**
   * Load custom icon data URLs for the routines that declare one. Batched into
   * one pass so a routine mutation never triggers a per-row IPC storm.
   */
  private async refreshIcons(): Promise<void> {
    const next = new SvelteMap<string, string>()
    await Promise.all(
      this.routines
        .filter((routine) => routine.icon)
        .map(async (routine) => {
          try {
            const url = await invoke('routine:getIcon', routine.id)
            if (url) next.set(routine.id, url)
          } catch {
            // Icon loading is best-effort; the row falls back to its SVG/Workflow icon.
          }
        })
    )
    this.iconUrls = next
  }

  async refreshMissedRuns(): Promise<void> {
    this.missedRuns = await invoke('assistant:listMissedRuns')
  }

  /** Ensure the hidden assistant-space container exists. */
  ensureSpace(): Promise<{ id: string }> {
    return invoke('routine:ensureSpace')
  }

  routineForTask(task: Thread | null | undefined): Routine | null {
    if (!task?.routineId) return null
    return this.routines.find((routine) => routine.id === task.routineId) ?? null
  }

  /** The schedule a task runs on: its override when set, else its routine's. */
  scheduleForTask(task: Thread): RoutineSchedule | null {
    if (task.scheduleOverride) return task.scheduleOverride
    return this.routineForTask(task)?.schedule ?? null
  }

  /** Next intended fire for a task, or null when it is not scheduled. */
  nextRunForTask(task: Thread, now = Date.now()): number | null {
    return nextRunAt(this.scheduleForTask(task), now)
  }

  /** Pending missed runs belonging to one task. */
  missedForTask(threadId: string): MissedRun[] {
    return this.missedRuns.filter((run) => run.threadId === threadId)
  }

  /** Pending missed runs belonging to any task of one routine. */
  missedForRoutine(routineId: string): MissedRun[] {
    return this.missedRuns.filter((run) => run.routineId === routineId)
  }

  hasMissedForRoutine(routineId: string): boolean {
    return this.missedRuns.some((run) => run.routineId === routineId)
  }

  async createRoutine(input: {
    name: string
    color?: string
    iconType?: string
    schedule?: RoutineSchedule | null
    howTo?: string
    connections?: RoutineConnection[]
    agents?: RoutineAgents
  }): Promise<Routine> {
    const routine = await invoke('routine:create', input)
    await this.refresh()
    return routine
  }

  async updateRoutine(
    routineId: string,
    input: {
      name?: string
      color?: string | null
      icon?: string | null
      iconType?: string | null
      schedule?: RoutineSchedule | null
      howTo?: string
      connections?: RoutineConnection[]
      agents?: RoutineAgents
      paused?: boolean
    }
  ): Promise<Routine> {
    const routine = await invoke('routine:update', routineId, input)
    await this.refresh()
    return routine
  }

  /** Store a custom icon image for a routine, mirroring project icons. */
  async setRoutineIcon(routineId: string, sourcePath: string): Promise<Routine> {
    const routine = await invoke('routine:setIcon', routineId, sourcePath)
    await this.refresh()
    return routine
  }

  /** Remove a routine's custom icon image. */
  async clearRoutineIcon(routineId: string): Promise<Routine> {
    const routine = await invoke('routine:clearIcon', routineId)
    await this.refresh()
    return routine
  }

  async deleteRoutine(routineId: string): Promise<void> {
    await invoke('routine:delete', routineId)
    await this.refresh()
  }

  async setRoutinePinned(routineId: string, pinned: boolean): Promise<Routine> {
    const routine = await invoke('routine:setPinned', routineId, pinned)
    await this.refresh()
    return routine
  }

  async reorderRoutines(orderedIds: string[]): Promise<void> {
    await invoke('routine:reorder', orderedIds)
    await this.refresh()
  }

  async setTaskRoutine(threadId: string, routineId: string | null): Promise<Thread> {
    return invoke('assistant:setTaskRoutine', threadId, routineId)
  }

  async setTaskSchedule(threadId: string, schedule: RoutineSchedule | null): Promise<Thread> {
    return invoke('assistant:setTaskSchedule', threadId, schedule)
  }

  async dismissMissedRun(id: string): Promise<void> {
    await invoke('assistant:dismissMissedRun', id)
  }

  async runMissedRunNow(id: string): Promise<void> {
    await invoke('assistant:runMissedRunNow', id)
  }

  /** Run a routine now, returning how many tasks were dispatched. */
  runRoutineNow(routineId: string): Promise<number> {
    return invoke('assistant:runRoutineNow', routineId)
  }
}

export const assistantRoutines = new AssistantRoutinesState()
