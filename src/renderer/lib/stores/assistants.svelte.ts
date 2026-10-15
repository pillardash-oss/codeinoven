import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { CustomIconImage } from '$shared/custom-icon'
import {
  nextRunAtExcluding,
  assistantIsScheduled,
  type BackgroundRun,
  type CreateAssistantInput,
  type MissedRun,
  type Project,
  type Assistant,
  type AssistantDeletionResult,
  type AssistantSchedule,
  type SkippedRun,
  type Thread,
  type UpdateAssistantInput
} from '$shared/types'

const EMPTY_SKIP_TIMES: ReadonlySet<number> = new Set<number>()

/** Value compare for two resolved icon maps, so an unchanged refresh publishes
 *  nothing and leaves icon consumers untouched. */
function mapsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

/**
 * Assistants   the renderer's live view of assistants and the
 * pending missed runs and user-skipped scheduled slots.
 *
 * Assistant mutations broadcast the full assistant list, and the scheduler
 * broadcasts full snapshots of its run ledgers. Batched replacement keeps
 * state consistent without per-item reconcile churn.
 */
class AssistantsState {
  assistants: Assistant[] = $state([])
  missedRuns: MissedRun[] = $state([])
  skippedRuns: SkippedRun[] = $state([])
  skippedRunTimesByTask: SvelteMap<string, SvelteSet<number>> = $state(new SvelteMap())
  /**
   * How much unattended-run history a panel renders. The ledger keeps up to 200
   * entries (months of runs), so a surface shows only the recent past instead of
   * growing into an unbounded wall the panel has to lay out.
   */
  static readonly BACKGROUND_RUN_HISTORY_LIMIT = 20
  /**
   * The durable ledger of unattended runs, newest first. Kept independently of
   * the run threads, so a run whose thread was later deleted still has evidence
   * to show in the "While you were away" and assistant-history surfaces.
   */
  backgroundRuns: BackgroundRun[] = $state([])
  /**
   * The hidden assistant space's accent colour. Assistant notifications brand
   * themselves with it (the bell badge, the panel entry dot and the toast), so
   * the renderer needs it even when only a missed run is pending and no
   * notification payload is carrying the colour.
   */
  spaceColor: string | null = $state(null)
  /** Custom icon data URLs for assistants that store one, keyed by assistant id. */
  iconUrls: SvelteMap<string, string> = $state(new SvelteMap())
  /**
   * Getting started checkpoints by assistant id: what the authoring interview has
   * agreed so far. `null` means the interview has not saved one yet. Pushed by
   * `assistant:checkpointChanged` and read on demand by the knowledge panel, so an
   * open panel follows the interview instead of waiting to be reopened.
   */
  checkpoints: SvelteMap<string, string | null> = $state(new SvelteMap())
  /** Assistant id -> stored icon filename. A mutation both broadcasts
   *  `assistant:changed` and runs an explicit `refresh()`, so without this every
   *  mutation re-fetched each assistant's icon over IPC twice. */
  private iconSignatures = new Map<string, string>()
  private initialized = false
  private disposers: Array<() => void> = []
  /**
   * Assistant ids the user already removed from the UI while the main process
   * finishes the background cleanup. An assistant list pushed in that window (a
   * scheduler tick, a checkpoint write, another window's mutation) must not
   * resurrect the container the user just removed.
   */
  private removing = new Set<string>()

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.disposers.push(
      subscribe('assistant:changed', (assistants) => {
        this.publishAssistants(assistants)
        void this.refreshIcons()
      }),
      subscribe('assistant:missedRunsChanged', (runs) => {
        this.missedRuns = runs
      }),
      subscribe('assistant:backgroundRunsChanged', (runs) => {
        this.backgroundRuns = runs
      }),
      subscribe('assistant:skippedAssistantRunsChanged', (runs) => {
        this.publishSkippedRuns(runs)
      }),
      subscribe('assistant:checkpointChanged', (assistantId) => {
        void this.refreshCheckpoint(assistantId)
      })
    )
    void this.ensureSpace().catch(() => undefined)
    void this.refresh()
    void this.refreshMissedRuns()
    void this.refreshBackgroundRuns()
    void this.refreshSkippedRuns()
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
    this.initialized = false
  }

  async refresh(): Promise<void> {
    this.publishAssistants(await invoke('assistant:list'))
    await this.refreshIcons()
  }

  /**
   * Publish an assistant list from the main process, minus any assistant the user
   * already removed from the UI and whose cleanup is still running.
   */
  private publishAssistants(assistants: Assistant[]): void {
    this.assistants =
      this.removing.size === 0
        ? assistants
        : assistants.filter((assistant) => !this.removing.has(assistant.id))
  }

  /**
   * Load custom icon data URLs for the assistants that declare one. Batched into
   * one pass so an assistant mutation never triggers a per-row IPC storm, and
   * diffed against the stored icon filename so an assistant whose icon did not
   * change is served from the previous result instead of a second IPC round.
   */
  private async refreshIcons(): Promise<void> {
    const next = new SvelteMap<string, string>()
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const signatures = new Map<string, string>()
    await Promise.all(
      this.assistants.map(async (assistant) => {
        const signature = assistant.icon ?? ''
        signatures.set(assistant.id, signature)
        if (!signature) return
        const cached =
          this.iconSignatures.get(assistant.id) === signature
            ? this.iconUrls.get(assistant.id)
            : undefined
        if (cached !== undefined) {
          next.set(assistant.id, cached)
          return
        }
        try {
          const url = await invoke('assistant:getIcon', assistant.id)
          if (url) next.set(assistant.id, url)
        } catch {
          // Icon loading is best-effort; the row falls back to its SVG/Workflow icon.
        }
      })
    )
    this.iconSignatures = signatures
    if (!mapsEqual(this.iconUrls, next)) this.iconUrls = next
  }

  async refreshMissedRuns(): Promise<void> {
    this.missedRuns = await invoke('assistant:listMissedRuns')
  }

  async refreshBackgroundRuns(): Promise<void> {
    this.backgroundRuns = await invoke('assistant:listBackgroundRuns')
  }

  async refreshSkippedRuns(): Promise<void> {
    this.publishSkippedRuns(await invoke('assistant:listSkippedRuns'))
  }

  private publishSkippedRuns(runs: SkippedRun[]): void {
    const byTask = new SvelteMap<string, SvelteSet<number>>()
    for (const run of runs) {
      const times = byTask.get(run.taskId) ?? new SvelteSet<number>()
      times.add(run.dueAt)
      byTask.set(run.taskId, times)
    }
    this.skippedRuns = runs
    this.skippedRunTimesByTask = byTask
  }

  /** Ensure the hidden assistant-space container exists, and keep its accent
   *  colour so assistant notification surfaces can brand themselves with it. */
  async ensureSpace(): Promise<Project> {
    const project = await invoke('assistant:ensureSpace')
    this.spaceColor = project.color ?? null
    return project
  }

  assistantForTask(task: Thread | null | undefined): Assistant | null {
    if (!task?.assistantId) return null
    return this.assistants.find((assistant) => assistant.id === task.assistantId) ?? null
  }

  /**
   * Whether a task runs on a clock at all. The task's own flag wins when set,
   * so one function of an assistant can be scheduled and another not; absent, a
   * task follows its assistant, and an assistant-less task is unscheduled unless it
   * carries its own schedule. Mirrors AssistantManager.resolveTaskScheduled so
   * the sidebar and the scheduler never disagree.
   */
  taskScheduled(task: Thread): boolean {
    if (task.scheduled !== undefined) return task.scheduled
    if (!task.assistantId) return task.scheduleOverride !== undefined
    const assistant = this.assistantForTask(task)
    if (!assistant) return task.scheduleOverride !== undefined
    return assistantIsScheduled(assistant)
  }

  /** The schedule a task runs on: its override when set, else its assistant's.
   *  A task that is not scheduled has none. */
  scheduleForTask(task: Thread): AssistantSchedule | null {
    if (!this.taskScheduled(task)) return null
    if (task.scheduleOverride) return task.scheduleOverride
    return this.assistantForTask(task)?.schedule ?? null
  }

  /** Next intended fire for a task, or null when it is not scheduled. */
  nextRunForTask(task: Thread, now = Date.now()): number | null {
    return nextRunAtExcluding(
      this.scheduleForTask(task),
      Math.max(now, task.lastRunAt ?? 0),
      this.skippedRunTimesByTask.get(task.id) ?? EMPTY_SKIP_TIMES
    )
  }

  async skipNextRun(assistantId: string): Promise<void> {
    this.publishSkippedRuns(await invoke('assistant:skipNextRun', assistantId))
  }

  hasRunsToday(assistantId: string): Promise<boolean> {
    return invoke('assistant:hasRunsToday', assistantId)
  }

  async skipRunsToday(assistantId: string): Promise<void> {
    this.publishSkippedRuns(await invoke('assistant:skipRunsToday', assistantId))
  }

  /** Pending missed runs belonging to one task. */
  missedForTask(threadId: string): MissedRun[] {
    return this.missedRuns.filter((run) => run.threadId === threadId)
  }

  /** Pending missed runs belonging to any task of one assistant. */
  missedForAssistant(assistantId: string): MissedRun[] {
    return this.missedRuns.filter((run) => run.assistantId === assistantId)
  }

  /** Ledger-entried unattended runs belonging to one task. */
  backgroundForTask(taskId: string): BackgroundRun[] {
    return this.backgroundRuns.filter((run) => run.taskId === taskId)
  }

  /** The recent unattended runs a panel renders, newest first. */
  get recentBackgroundRuns(): BackgroundRun[] {
    return this.backgroundRuns.slice(0, AssistantsState.BACKGROUND_RUN_HISTORY_LIMIT)
  }

  /** Ledger-entried unattended runs belonging to any task of one assistant. */
  backgroundForAssistant(assistantId: string): BackgroundRun[] {
    return this.backgroundRuns.filter((run) => run.assistantId === assistantId)
  }

  hasMissedForAssistant(assistantId: string): boolean {
    return this.missedRuns.some((run) => run.assistantId === assistantId)
  }

  async createAssistant(input: CreateAssistantInput): Promise<Assistant> {
    const assistant = await invoke('assistant:create', input)
    await this.refresh()
    return assistant
  }

  async updateAssistant(assistantId: string, input: UpdateAssistantInput): Promise<Assistant> {
    const assistant = await invoke('assistant:update', assistantId, input)
    await this.refresh()
    return assistant
  }

  /** Store a custom icon image for an assistant, mirroring project icons. */
  async setAssistantIcon(assistantId: string, image: CustomIconImage): Promise<Assistant> {
    const assistant = await invoke('assistant:setIcon', assistantId, image)
    await this.refresh()
    return assistant
  }

  /** Remove an assistant's custom icon image. */
  async clearAssistantIcon(assistantId: string): Promise<Assistant> {
    const assistant = await invoke('assistant:clearIcon', assistantId)
    await this.refresh()
    return assistant
  }

  /**
   * Remove an assistant: the container and its pending missed runs leave the UI at
   * once, and the main process does the cleanup in the background   its threads
   * and their runs, the scheduler's records, the database rows, and the
   * assistant's artifact folder. The promise resolves with what the sweep removed
   * so the caller can report it, and a failed sweep puts the assistant back rather
   * than leaving a container that silently reappears on the next refresh.
   */
  async removeAssistant(assistantId: string): Promise<AssistantDeletionResult> {
    this.removing.add(assistantId)
    this.assistants = this.assistants.filter((assistant) => assistant.id !== assistantId)
    this.missedRuns = this.missedRuns.filter((run) => run.assistantId !== assistantId)
    this.checkpoints.delete(assistantId)
    try {
      return await invoke('assistant:delete', assistantId)
    } catch (error) {
      // The main process still has the assistant, so restore it instead of
      // pretending it is gone.
      this.removing.delete(assistantId)
      await this.refresh()
      await this.refreshMissedRuns()
      throw error
    } finally {
      this.removing.delete(assistantId)
    }
  }

  async setAssistantPinned(assistantId: string, pinned: boolean): Promise<Assistant> {
    const assistant = await invoke('assistant:setPinned', assistantId, pinned)
    await this.refresh()
    return assistant
  }

  async reorderAssistants(orderedIds: string[]): Promise<void> {
    await invoke('assistant:reorder', orderedIds)
    await this.refresh()
  }

  async assignTask(threadId: string, assistantId: string | null): Promise<Thread> {
    return invoke('assistant:assignTask', threadId, assistantId)
  }

  /**
   * An assistant's knowledge ("Getting started") thread, hidden or not. Hidden rows
   * never reach the hydrated thread list, so the knowledge panel asks for its own
   * assistant's thread here instead of reading the workspace's rows.
   */
  knowledgeThread(assistantId: string): Promise<Thread | null> {
    return invoke('assistant:knowledgeThread', assistantId)
  }

  /**
   * The assistant's Getting started checkpoint, or null while the interview has
   * not saved one. Read-only: the authoring agent's own turn writes it.
   */
  gettingStartedCheckpoint(assistantId: string): Promise<string | null> {
    return invoke('assistant:gettingStartedCheckpoint', assistantId)
  }

  /**
   * Load one assistant's checkpoint into the store. Best-effort: a read that fails
   * leaves the last known value in place rather than blanking a panel that is
   * showing the interview's agreed state.
   */
  async refreshCheckpoint(assistantId: string): Promise<void> {
    try {
      this.checkpoints.set(assistantId, await this.gettingStartedCheckpoint(assistantId))
    } catch {
      // Nothing to surface: the panel simply keeps what it already shows.
    }
  }

  /** Hide or reveal an assistant's knowledge thread. It stays pinned either way. */
  setKnowledgeHidden(assistantId: string, hidden: boolean): Promise<Thread> {
    return invoke('assistant:setKnowledgeHidden', assistantId, hidden)
  }

  /**
   * Post the saved-knowledge next-steps turn into an assistant's Getting started
   * thread. Hidden internal turn; a no-op when that thread is hidden or gone.
   */
  postSetup(assistantId: string): Promise<void> {
    return invoke('assistant:postSetup', assistantId)
  }

  async setTaskSchedule(threadId: string, schedule: AssistantSchedule | null): Promise<Thread> {
    return invoke('assistant:setTaskSchedule', threadId, schedule)
  }

  /** Turn one function's clock on, off, or back to following its assistant. */
  async setTaskScheduled(threadId: string, scheduled: boolean | null): Promise<Thread> {
    return invoke('assistant:setTaskScheduled', threadId, scheduled)
  }

  async dismissMissedRun(id: string): Promise<void> {
    await invoke('assistant:dismissMissedRun', id)
  }

  /**
   * Acknowledge one unattended run. The ledger removal is durable and main
   * pushes the fresh list; the local filter makes the row leave the panel at
   * once, without waiting for the push to land.
   */
  async dismissBackgroundRun(id: string): Promise<void> {
    await invoke('assistant:dismissBackgroundRun', id)
    this.backgroundRuns = this.backgroundRuns.filter((run) => run.runThreadId !== id)
  }

  async runMissedRunNow(id: string): Promise<Thread | null> {
    return invoke('assistant:runMissedRunNow', id)
  }

  /** Run an assistant now, returning the fresh run threads it created. */
  runNow(assistantId: string): Promise<Thread[]> {
    return invoke('assistant:runNow', assistantId)
  }
}

export const assistants = new AssistantsState()
