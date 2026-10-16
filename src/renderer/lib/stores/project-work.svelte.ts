import { SvelteMap } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type { AuthoredWorkKind, ProjectWorkState } from '$shared/ipc-contract'

/**
 * The designs and videos a project holds, read without a thread.
 *
 * A session knows its work because it made it, but the right rail has to offer a
 * project's designs before any thread is chosen and while the thread on screen
 * has nothing to do with them. That is a project-level question, so it is asked
 * and cached per project rather than per thread, and refreshed when the work
 * changes rather than on every message.
 *
 * One read per project is in flight at a time: the dock and the board both ask as
 * they paint, and neither should be able to stack a second question on the first.
 */
class ProjectWorkStore {
  /** Last answer per project, so the rail can draw before its own read settles. */
  #states = new SvelteMap<string, ProjectWorkState>()
  /** Projects whose read is in flight, so callers share one request. */
  #pending = new Map<string, Promise<void>>()

  /** The last answer for a project, or null before the first one arrives. */
  stateFor(projectId: string): ProjectWorkState | null {
    return this.#states.get(projectId) ?? null
  }

  /** The folders of one kind a project holds, or an empty list before the read. */
  itemsFor(projectId: string, kind: AuthoredWorkKind): ProjectWorkState[AuthoredWorkKind] {
    return this.#states.get(projectId)?.[kind] ?? []
  }

  /** Last folder focused for each project and work kind, shared across threads. */
  #focused = new SvelteMap<string, string>()

  focusedDirectory(projectId: string, kind: AuthoredWorkKind): string {
    return this.#focused.get(`${projectId}:${kind}`) ?? ''
  }

  focusDirectory(projectId: string, kind: AuthoredWorkKind, directory: string): void {
    this.#focused.set(`${projectId}:${kind}`, directory)
  }

  /** Opening a panel discards its cached listing before checking recorded folders. */
  invalidate(projectId: string): void {
    this.#states.delete(projectId)
  }

  /** Read a project's work once, unless a read is already in flight. */
  ensure(projectId: string): Promise<void> {
    return this.#states.has(projectId) ? Promise.resolve() : this.refresh(projectId)
  }

  /** Read a project's work again, whether or not it was read before. */
  refresh(projectId: string): Promise<void> {
    const pending = this.#pending.get(projectId)
    if (pending) return pending
    const task = invoke('design:projectWork', projectId)
      .then((state) => {
        this.#states.set(projectId, state)
      })
      .catch(() => {
        // A project that cannot be read keeps the last answer rather than
        // blanking the rail entries the user is looking at.
      })
      .finally(() => {
        this.#pending.delete(projectId)
      })
    this.#pending.set(projectId, task)
    return task
  }

  /** Drop a project's cached answer, e.g. when it is removed. */
  forget(projectId: string): void {
    this.#focused.delete(`${projectId}:design`)
    this.#focused.delete(`${projectId}:video`)
    this.#states.delete(projectId)
    this.#pending.delete(projectId)
  }
}

export const projectWorkState = new ProjectWorkStore()
