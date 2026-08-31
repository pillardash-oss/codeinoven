import { invoke, subscribe } from '$lib/ipc.svelte'
import type { ProjectAction, ProjectActionInput } from '$shared/project-actions'
import { SvelteMap } from 'svelte/reactivity'

export interface ProjectActionRun {
  actionId: string
  terminalId: string
  script: string
  variables: Record<string, string>
  running: boolean
  expanded: boolean
}

class ProjectActionsState {
  actionsByProject = new SvelteMap<string, ProjectAction[]>()
  runs = new SvelteMap<string, ProjectActionRun>()
  private loading = new Map<string, Promise<void>>()
  private exitSubscriptions = new Map<string, () => void>()

  actions(projectId: string): ProjectAction[] {
    return this.actionsByProject.get(projectId) ?? []
  }
  run(actionId: string): ProjectActionRun | undefined {
    return this.runs.get(actionId)
  }
  runningCount(projectId: string): number {
    const ids = new Set(this.actions(projectId).map((action) => action.id))
    return [...this.runs.values()].filter((run) => ids.has(run.actionId) && run.running).length
  }
  async load(projectId: string): Promise<void> {
    if (this.actionsByProject.has(projectId)) return
    const pending = this.loading.get(projectId)
    if (pending) return pending
    const request = invoke('projectActions:list', projectId)
      .then((actions) => {
        this.actionsByProject.set(projectId, actions)
      })
      .finally(() => this.loading.delete(projectId))
    this.loading.set(projectId, request)
    return request
  }
  async save(projectId: string, actionId: string | null, input: ProjectActionInput): Promise<void> {
    const saved = await invoke('projectActions:save', projectId, actionId, input)
    const current = this.actions(projectId)
    this.actionsByProject.set(
      projectId,
      actionId
        ? current.map((action) => (action.id === saved.id ? saved : action))
        : [...current, saved]
    )
  }
  async delete(projectId: string, actionId: string): Promise<void> {
    if (this.run(actionId)?.running) await this.stop(actionId)
    if (await invoke('projectActions:delete', projectId, actionId))
      this.actionsByProject.set(
        projectId,
        this.actions(projectId).filter((action) => action.id !== actionId)
      )
  }
  start(action: ProjectAction, variables: Record<string, string>): void {
    const terminalId = `action-${action.id}-${crypto.randomUUID()}`
    this.exitSubscriptions.get(action.id)?.()
    this.runs.set(action.id, {
      actionId: action.id,
      terminalId,
      script: action.script,
      variables,
      running: true,
      expanded: true
    })
    this.exitSubscriptions.set(
      action.id,
      subscribe(`pty:exit:${terminalId}`, () => {
        const run = this.runs.get(action.id)
        if (run) this.runs.set(action.id, { ...run, running: false })
        this.exitSubscriptions.get(action.id)?.()
        this.exitSubscriptions.delete(action.id)
      })
    )
  }
  async stop(actionId: string): Promise<void> {
    const run = this.runs.get(actionId)
    if (!run?.running) return
    await invoke('pty:destroy', run.terminalId)
    this.runs.set(actionId, { ...run, running: false })
  }
  toggle(actionId: string): void {
    const run = this.runs.get(actionId)
    if (run) this.runs.set(actionId, { ...run, expanded: !run.expanded })
  }
}

export const projectActionsState = new ProjectActionsState()
