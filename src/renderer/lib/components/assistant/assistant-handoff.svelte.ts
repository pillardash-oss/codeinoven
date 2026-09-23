import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
import { isThreadBusy, type Project, type Thread } from '$shared/types'
import { handoffSummary } from './assistant-view'

export interface AssistantHandoffConfig {
  /** Resolved on every access so the controller tracks the current task. */
  getTask: () => Thread | null | undefined
  /** Called after the fork lands, so the workspace can open the new thread. */
  onHandedOff: (forked: Thread) => void
}

/**
 * Assistant task hand-off, driven from the task's own context menu.
 *
 * Forking is the only hand-off: the task thread and its schedule stay intact and
 * the project gets a new thread seeded with a context summary, so work continues
 * with the full picture. A hand-off requested mid-run forks a thread that is
 * still being written to, so it always passes a confirmation gate first
 * (destructive-action rule).
 */
export function createAssistantHandoff(config: AssistantHandoffConfig) {
  let projects = $state<Project[]>([])
  const projectIcons = new SvelteMap<string, string>()
  let pickerOpen = $state(false)
  let confirmOpen = $state(false)
  let busy = $state(false)

  async function loadProjects(): Promise<void> {
    try {
      const all = await invoke('project:list')
      projects = all.filter((project) => !project.hidden)
    } catch (error) {
      reportError(error, 'Could not load projects')
    }
  }

  async function beginPick(): Promise<void> {
    if (projects.length === 0) await loadProjects()
    pickerOpen = true
  }

  /** Open the picker, gated by a confirmation while the task is running. */
  function open(): void {
    const task = config.getTask()
    if (!task) return
    if (isThreadBusy(task)) {
      confirmOpen = true
      return
    }
    void beginPick()
  }

  function confirm(): void {
    confirmOpen = false
    void beginPick()
  }

  function cancelConfirm(): void {
    confirmOpen = false
  }

  function closePicker(): void {
    if (busy) return
    pickerOpen = false
  }

  function addProject(project: Project): void {
    projects = [...projects, project]
  }

  /** The context summary that seeds the fork so work continues with the picture. */
  function buildSummary(task: Thread): string {
    return handoffSummary(task, assistantRoutines.routineForTask(task))
  }

  async function continueInProject(project: Project): Promise<void> {
    const task = config.getTask()
    if (!task || busy) return
    busy = true
    try {
      const forked = await invoke(
        'thread:fork',
        task.projectId,
        task.id,
        task.title,
        undefined,
        undefined,
        project.id
      )
      try {
        await invoke('history:append', forked.projectId, forked.id, 'system', buildSummary(task))
      } catch {
        // The summary is additive context; a failed seed must not lose the fork.
      }
      pickerOpen = false
      config.onHandedOff(forked)
    } catch (error) {
      reportError(error, 'The task could not be handed off to the project')
    } finally {
      busy = false
    }
  }

  return {
    get projects(): Project[] {
      return projects
    },
    projectIcons,
    get pickerOpen(): boolean {
      return pickerOpen
    },
    get confirmOpen(): boolean {
      return confirmOpen
    },
    get busy(): boolean {
      return busy
    },
    open,
    confirm,
    cancelConfirm,
    closePicker,
    addProject,
    continueInProject
  }
}

export type AssistantHandoff = ReturnType<typeof createAssistantHandoff>
