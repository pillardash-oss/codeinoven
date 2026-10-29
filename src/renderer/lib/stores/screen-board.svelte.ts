import { SvelteMap } from 'svelte/reactivity'
import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  ScreenBoardOrder,
  ScreenBoardState,
  WorkGroupView
} from '$shared/ipc-contract'

/**
 * How a design's screens are organised, read once and shared by every board.
 *
 * The arrangement is a record rather than the board's memory: the board that shows
 * a design, the window that reopened on it and the user's own next session all read
 * the same answer, so a group folded here is folded there and a drag lands in the
 * arrangement every surface draws. The cards/list reading is not per design either:
 * it is one answer for the whole app, which is why asking a design for its board
 * also says how the user reads every design.
 */
function boardKey(projectId: string, directory: string): string {
  return `${projectId}\u0000${directory}`
}

class ScreenBoardStore {
  constructor() {
    if (typeof window === 'undefined') return
    subscribe('design:screenBoardChanged', (projectId, directory, updatedAt) => {
      this.#announce(projectId, directory, updatedAt)
    })
  }

  /** Last answer per design, so a board paints before its own read settles. */
  #states = new SvelteMap<string, ScreenBoardState>()
  /** Reads in flight, so two surfaces share one request. */
  #pending = new Map<string, Promise<void>>()

  /** The last answer for a design, or null before the first one arrives. */
  stateFor(projectId: string, directory: string): ScreenBoardState | null {
    return this.#states.get(boardKey(projectId, directory)) ?? null
  }

  /**
   * The app-wide cards/list reading, taken from any board already read.
   *
   * A board answer carries the reading with it, so the panel can draw the right
   * view on its first frame without a second round trip; before any board has been
   * read the answer is the shipped default.
   */
  view(): WorkGroupView {
    for (const state of this.#states.values()) return state.view
    return 'cards'
  }

  /** Read one design's board once, unless a read is already in flight. */
  ensure(projectId: string, directory: string): Promise<void> {
    return this.#states.has(boardKey(projectId, directory))
      ? Promise.resolve()
      : this.refresh(projectId, directory)
  }

  /** Read one design's board again, which a change elsewhere asked for. */
  refresh(projectId: string, directory: string): Promise<void> {
    if (directory === '') return Promise.resolve()
    const key = boardKey(projectId, directory)
    const pending = this.#pending.get(key)
    if (pending) return pending
    const task = invoke('design:screenBoard', projectId, directory)
      .then((state) => this.#apply(state))
      .catch(() => {
        // A board that cannot be read keeps the answer it holds rather than
        // blanking the arrangement the user is looking at.
      })
      .finally(() => {
        this.#pending.delete(key)
      })
    this.#pending.set(key, task)
    return task
  }

  /** Switch every design board between pictures of the screens and rows of them. */
  setView(view: WorkGroupView): Promise<void> {
    // The answer is the view itself, so the local reading follows at once and the
    // boards that are mounted redraw without waiting for the write to settle.
    return invoke('design:screenBoardView', view).then(
      (settled) => {
        for (const [key, state] of this.#states) this.#states.set(key, { ...state, view: settled })
      },
      (error: unknown) => {
        throw error
      }
    )
  }

  setOrder(projectId: string, directory: string, order: ScreenBoardOrder): Promise<void> {
    return this.#mutate(invoke('design:screenBoardSort', projectId, directory, order))
  }

  createGroup(projectId: string, directory: string, name: string): Promise<void> {
    return this.#mutate(invoke('design:screenBoardCreateGroup', projectId, directory, name))
  }

  renameGroup(
    projectId: string,
    directory: string,
    groupId: string,
    name: string
  ): Promise<void> {
    return this.#mutate(invoke('design:screenBoardRenameGroup', projectId, directory, groupId, name))
  }

  /** Delete a group: its screens go back to the ungrouped list; no file moves. */
  removeGroup(projectId: string, directory: string, groupId: string): Promise<void> {
    return this.#mutate(invoke('design:screenBoardRemoveGroup', projectId, directory, groupId))
  }

  /** Set the order of a design's groups, which a drag on a group expresses. */
  reorderGroups(projectId: string, directory: string, groupIds: string[]): Promise<void> {
    return this.#mutate(
      invoke('design:screenBoardReorderGroups', projectId, directory, groupIds)
    )
  }

  /** Fold a group away, or open it, which the record remembers with it. */
  setCollapsed(
    projectId: string,
    directory: string,
    groupId: string,
    collapsed: boolean
  ): Promise<void> {
    return this.#mutate(
      invoke('design:screenBoardCollapseGroup', projectId, directory, groupId, collapsed)
    )
  }

  /**
   * Set one group's screens, in the order given: a drop and a reorder are the same
   * gesture, and the record's order becomes the user's own.
   */
  place(
    projectId: string,
    directory: string,
    groupId: string | null,
    entries: string[]
  ): Promise<void> {
    return this.#mutate(
      invoke('design:screenBoardPlace', projectId, directory, groupId, entries)
    )
  }

  /** Publish an answer, unless the one held is already newer. */
  #apply(state: ScreenBoardState): void {
    const key = boardKey(state.projectId, state.directory)
    const held = this.#states.get(key)
    if (held && held.updatedAt > state.updatedAt) return
    this.#states.set(key, state)
  }

  #mutate(request: Promise<ScreenBoardState>): Promise<void> {
    return request.then((state) => this.#apply(state))
  }

  #announce(projectId: string, directory: string, updatedAt: number): void {
    const held = this.#states.get(boardKey(projectId, directory))
    if (held && held.updatedAt >= updatedAt) return
    void this.refresh(projectId, directory)
  }
}

export const screenBoardState = new ScreenBoardStore()
