import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  AuthoredWorkKind,
  WorkGroupMove,
  WorkGroupState,
  WorkGroupView
} from '$shared/ipc-contract'

/**
 * How a project's board is organised, read once and shared by everything drawing it.
 *
 * The organisation is a record in the database rather than one window's memory, so
 * it is read per project and kind and kept fresh from main's own announcement: a
 * drop made here, a rename made in another window and an agent grouping designs on
 * the user's request all arrive the same way, which is what keeps two boards from
 * disagreeing about where a design lives.
 *
 * Every mutation answers with the whole state, so a gesture is one round trip and
 * the caller never follows a write with a read. A change that lands while a read is
 * in flight is not lost either: the stamp decides, and a state older than the one
 * held is dropped.
 */
function scopeKey(projectId: string, kind: AuthoredWorkKind): string {
  return `${projectId}\u0000${kind}`
}

class WorkGroupStore {
  constructor() {
    if (typeof window === 'undefined') return
    subscribe('design:workGroupsChanged', (projectId, kind, updatedAt) => {
      this.#announce(projectId, kind, updatedAt)
    })
  }

  /** Last answer per board, so the panel paints before its own read settles. */
  #states = new SvelteMap<string, WorkGroupState>()
  /** Boards whose read is in flight, so two surfaces share one request. */
  #pending = new Map<string, Promise<void>>()

  /** The last answer for a board, or null before the first one arrives. */
  stateFor(projectId: string, kind: AuthoredWorkKind): WorkGroupState | null {
    return this.#states.get(scopeKey(projectId, kind)) ?? null
  }

  /** A board's groups, in order, or an empty list before the read. */
  groupsFor(projectId: string, kind: AuthoredWorkKind) {
    return this.stateFor(projectId, kind)?.groups ?? []
  }

  /** Read a board once, unless it has been read or a read is already in flight. */
  ensure(projectId: string, kind: AuthoredWorkKind): Promise<void> {
    return this.#states.has(scopeKey(projectId, kind))
      ? Promise.resolve()
      : this.refresh(projectId, kind)
  }

  /** Read a board again, which a change elsewhere has asked for. */
  refresh(projectId: string, kind: AuthoredWorkKind): Promise<void> {
    const key = scopeKey(projectId, kind)
    const pending = this.#pending.get(key)
    if (pending) return pending
    const task = invoke('design:workGroups', projectId, kind)
      .then((state) => this.#apply(state))
      .catch(() => {
        // A board that cannot be read keeps the answer it has rather than blanking
        // the groups the user is looking at.
      })
      .finally(() => {
        this.#pending.delete(key)
      })
    this.#pending.set(key, task)
    return task
  }

  /** Make a group at the end of the board. */
  create(projectId: string, kind: AuthoredWorkKind, name: string): Promise<void> {
    return this.#mutate(invoke('design:workGroupsCreate', projectId, kind, name))
  }

  rename(projectId: string, kind: AuthoredWorkKind, groupId: string, name: string): Promise<void> {
    return this.#mutate(invoke('design:workGroupsRename', projectId, groupId, name))
  }

  /** Delete a group: its designs go back to the ungrouped list; no folder moves. */
  remove(projectId: string, kind: AuthoredWorkKind, groupId: string): Promise<void> {
    return this.#mutate(invoke('design:workGroupsRemove', projectId, groupId))
  }

  /** Fold a group away, or open it, which the database remembers with it. */
  setCollapsed(
    projectId: string,
    kind: AuthoredWorkKind,
    groupId: string,
    collapsed: boolean
  ): Promise<void> {
    return this.#mutate(invoke('design:workGroupsCollapse', projectId, groupId, collapsed))
  }

  reorder(projectId: string, kind: AuthoredWorkKind, groupIds: string[]): Promise<void> {
    return this.#mutate(invoke('design:workGroupsReorder', projectId, kind, groupIds))
  }

  /** Drop designs into a group, out of one, or to a new place inside one. */
  move(projectId: string, kind: AuthoredWorkKind, moves: WorkGroupMove[]): Promise<void> {
    return this.#mutate(invoke('design:workGroupsMove', projectId, kind, moves))
  }

  /** Switch the board between pictures of the designs and the folded list. */
  setView(projectId: string, kind: AuthoredWorkKind, view: WorkGroupView): Promise<void> {
    return this.#mutate(invoke('design:workGroupsView', projectId, kind, view))
  }

  /** Drop a removed project's board, so nothing draws work that is gone. */
  forget(projectId: string): void {
    for (const key of [...this.#states.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) this.#states.delete(key)
    }
    for (const key of [...this.#pending.keys()]) {
      if (key.startsWith(`${projectId}\u0000`)) this.#pending.delete(key)
    }
  }

  /**
   * Take a mutation's answer, and re-read the board if it failed.
   *
   * A write can be refused for a reason the user can act on (a name already in
   * use), and the caller shows that error. Whatever the outcome, the board is the
   * server's answer rather than the board's own guess: a refusal leaves the drawn
   * arrangement as it was.
   */
  #mutate(request: Promise<WorkGroupState>): Promise<void> {
    return request.then(
      (state) => {
        this.#apply(state)
      },
      (error: unknown) => {
        throw error
      }
    )
  }

  /** Publish an answer, unless the one held is already newer. */
  #apply(state: WorkGroupState): void {
    const key = scopeKey(state.projectId, state.kind)
    const held = this.#states.get(key)
    if (held && held.updatedAt > state.updatedAt) return
    this.#states.set(key, state)
  }

  /**
   * A board changed somewhere: read it again when the change is newer than the
   * answer held.
   *
   * The comparison is what keeps a window's own mutation from costing a second
   * read: the write already answered with this stamp, so the announcement that
   * follows it finds nothing to do.
   */
  #announce(projectId: string, kind: AuthoredWorkKind, updatedAt: number): void {
    const held = this.#states.get(scopeKey(projectId, kind))
    if (held && held.updatedAt >= updatedAt) return
    void this.refresh(projectId, kind)
  }
}

export const workGroupState = new WorkGroupStore()
