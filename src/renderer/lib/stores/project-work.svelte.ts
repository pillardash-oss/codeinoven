import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { AuthoredWorkKind, ProjectWorkState } from '$shared/ipc-contract'
import { APP_SLUG } from '$shared/brand'

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
  constructor() {
    if (typeof window !== 'undefined') {
      subscribe('design:relocated', (projectId, moves) => {
        const relocated = new Map(moves.map(({ from, to }) => [from, to]))
        for (const [key, directory] of this.#selected) {
          const destination = relocated.get(directory)
          if (key.startsWith(`${projectId}:`) && destination) this.#selected.set(key, destination)
        }
        for (const kind of ['design', 'video'] as const) {
          const destination = relocated.get(this.focusedDirectory(projectId, kind))
          if (destination) this.focusDirectory(projectId, kind, destination)
        }
        if (this.#states.has(projectId)) void this.refresh(projectId)
      })
    }
  }
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
  /** Explicit per-thread choices last for this renderer session only. */
  #selected = new SvelteMap<string, string>()

  selectedDirectory(projectId: string, kind: AuthoredWorkKind, threadId: string): string {
    return this.#selected.get(`${projectId}:${kind}:${threadId}`) ?? ''
  }

  hasSelection(projectId: string, threadId: string): boolean {
    return (['design', 'video'] as const).some((kind) =>
      this.#selected.has(`${projectId}:${kind}:${threadId}`)
    )
  }

  selectDirectory(
    projectId: string,
    kind: AuthoredWorkKind,
    threadId: string,
    directory: string
  ): void {
    const key = `${projectId}:${kind}:${threadId}`
    if (directory) this.#selected.set(key, directory)
    else this.#selected.delete(key)
    this.focusDirectory(projectId, kind, directory)
  }

  focusedDirectory(projectId: string, kind: AuthoredWorkKind): string {
    const key = `${projectId}:${kind}`
    const focused = this.#focused.get(key)
    if (focused !== undefined) return focused
    try {
      return typeof window === 'undefined'
        ? ''
        : (window.localStorage.getItem(`${APP_SLUG}.work-focus.${key}`) ?? '')
    } catch {
      return ''
    }
  }

  focusDirectory(projectId: string, kind: AuthoredWorkKind, directory: string): void {
    this.#focused.set(`${projectId}:${kind}`, directory)
    try {
      if (typeof window !== 'undefined')
        window.localStorage.setItem(`${APP_SLUG}.work-focus.${projectId}:${kind}`, directory)
    } catch {
      // A disabled storage area still leaves session choices available.
    }
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
    for (const key of this.#selected.keys()) {
      if (key.startsWith(`${projectId}:`)) this.#selected.delete(key)
    }
    for (const kind of ['design', 'video'] as const) {
      try {
        if (typeof window !== 'undefined')
          window.localStorage.removeItem(`${APP_SLUG}.work-focus.${projectId}:${kind}`)
      } catch {
        /* Storage can be unavailable. */
      }
    }
    this.#focused.delete(`${projectId}:design`)
    this.#focused.delete(`${projectId}:video`)
    this.#states.delete(projectId)
    this.#pending.delete(projectId)
  }
}

export const projectWorkState = new ProjectWorkStore()
