import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type { AuthoredWorkKind, ProjectWorkState } from '$shared/ipc-contract'
import { DEFAULT_WORK_ROOTS, type WorkRoots } from '$shared/design/work-roots'
import { APP_SLUG } from '$shared/brand'
import { usesThreadWorkspaceMount } from '$shared/types'

/**
 * The cache key one read belongs to.
 *
 * A project's designs are the project's: every thread of it lists the same
 * folders, so the project id is the whole key. An assistant task, a chat and a
 * browser tab are the opposite case, because each runs in a workspace of its own
 * while sharing one container id, so the thread has to be part of the key or two
 * assistants would read each other's board.
 */
function workScopeKey(projectId: string, threadId?: string): string {
  return threadId && usesThreadWorkspaceMount(projectId) ? `${projectId}:${threadId}` : projectId
}

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
  /**
   * The folder each project writes new work into.
   *
   * A project's own record, so it is read per project rather than kept as one
   * app-wide value, and cached because the file tree asks about every row it draws.
   * The app default answers until the read lands, which is what a project that
   * never changed its folder would be told anyway.
   */
  #roots = new SvelteMap<string, WorkRoots>()
  /** Projects whose roots are being read, so an explorer asks once per project. */
  #rootsPending = new Map<string, Promise<void>>()

  /** The last answer for a scope, or null before the first one arrives. */
  stateFor(projectId: string, threadId?: string): ProjectWorkState | null {
    return this.#states.get(workScopeKey(projectId, threadId)) ?? null
  }

  /** The folders of one kind a scope holds, or an empty list before the read. */
  itemsFor(
    projectId: string,
    kind: AuthoredWorkKind,
    threadId?: string
  ): ProjectWorkState[AuthoredWorkKind] {
    return this.#states.get(workScopeKey(projectId, threadId))?.[kind] ?? []
  }

  /** The folders a project writes new work into, or the app default before the read. */
  rootsFor(projectId: string): WorkRoots {
    return this.#roots.get(projectId) ?? { ...DEFAULT_WORK_ROOTS }
  }

  /** Read a project's folders once, unless a read is already in flight. */
  ensureRoots(projectId: string): Promise<void> {
    return this.#roots.has(projectId) ? Promise.resolve() : this.refreshRoots(projectId)
  }

  /** Read a project's folders again, which a save-path change asks for. */
  refreshRoots(projectId: string): Promise<void> {
    const pending = this.#rootsPending.get(projectId)
    if (pending) return pending
    const task = invoke('design:workRoots', projectId)
      .then((roots) => {
        this.#roots.set(projectId, roots)
      })
      .catch(() => {
        // A project whose folders cannot be read keeps the answer it has, which
        // at worst names the app default.
      })
      .finally(() => {
        this.#rootsPending.delete(projectId)
      })
    this.#rootsPending.set(projectId, task)
    return task
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
  invalidate(projectId: string, threadId?: string): void {
    this.#states.delete(workScopeKey(projectId, threadId))
  }

  /** Read a scope's work once, unless a read is already in flight. */
  ensure(projectId: string, threadId?: string): Promise<void> {
    const key = workScopeKey(projectId, threadId)
    return this.#states.has(key) ? Promise.resolve() : this.refresh(projectId, threadId)
  }

  /** Read a scope's work again, whether or not it was read before. */
  refresh(projectId: string, threadId?: string): Promise<void> {
    const key = workScopeKey(projectId, threadId)
    const pending = this.#pending.get(key)
    if (pending) return pending
    const task = invoke('design:projectWork', projectId, threadId)
      .then((state) => {
        this.#states.set(key, state)
      })
      .catch(() => {
        // A scope that cannot be read keeps the last answer rather than blanking
        // the rail entries the user is looking at.
      })
      .finally(() => {
        this.#pending.delete(key)
      })
    this.#pending.set(key, task)
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
    for (const key of [...this.#states.keys()]) {
      if (key === projectId || key.startsWith(`${projectId}:`)) this.#states.delete(key)
    }
    for (const key of [...this.#pending.keys()]) {
      if (key === projectId || key.startsWith(`${projectId}:`)) this.#pending.delete(key)
    }
    this.#roots.delete(projectId)
    this.#rootsPending.delete(projectId)
  }
}

export const projectWorkState = new ProjectWorkStore()
