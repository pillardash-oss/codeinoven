import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import {
  projectDeletionLabel,
  type ProjectDeletionEvent,
  type ProjectDeletionPhase
} from '$shared/project-deletion'

/**
 * Which projects the user asked to delete and what the main process is doing
 * about it.
 *
 * Deletion no longer waits on an IPC reply: the request is accepted at once and
 * the work runs in the main process's own queue, so this is where the row's
 * state lives. A project enters `pending` the moment Remove is confirmed, which
 * greys its sidebar row and blocks interaction with it, and leaves on the
 * `project:deletion` event: gone on `deleted`, usable again on `failed`.
 */
class ProjectDeletionState {
  private readonly pendingIds = new SvelteSet<string>()
  private readonly phases = new SvelteMap<string, ProjectDeletionPhase>()
  private readonly progress = new SvelteMap<string, { done: number; total: number }>()

  /** The project is on its way out; its row stays visible but inert. */
  isPending(projectId: string): boolean {
    return this.pendingIds.has(projectId)
  }

  /** Accept a request locally, before the main process has said anything. */
  begin(projectId: string): void {
    this.pendingIds.add(projectId)
    this.phases.delete(projectId)
    this.progress.delete(projectId)
  }

  /** Drop the pending state: the project is gone, or it is usable again. */
  settle(projectId: string): void {
    this.pendingIds.delete(projectId)
    this.phases.delete(projectId)
    this.progress.delete(projectId)
  }

  /** Apply one stage reported by the main process. */
  applyEvent(event: ProjectDeletionEvent): void {
    switch (event.status) {
      case 'started':
        this.pendingIds.add(event.projectId)
        break
      case 'progress':
        if (!this.pendingIds.has(event.projectId)) this.pendingIds.add(event.projectId)
        if (event.phase) this.phases.set(event.projectId, event.phase)
        if (event.phase === 'threads' && event.total !== undefined) {
          this.progress.set(event.projectId, { done: event.done ?? 0, total: event.total })
        }
        break
      default:
        this.settle(event.projectId)
    }
  }

  /** What the greyed row says, e.g. `Removing threads 3/12`. */
  label(projectId: string): string | null {
    if (!this.pendingIds.has(projectId)) return null
    const phase = this.phases.get(projectId)
    const progress = this.progress.get(projectId)
    return projectDeletionLabel({ phase, done: progress?.done, total: progress?.total })
  }
}

export const projectDeletionState = new ProjectDeletionState()
