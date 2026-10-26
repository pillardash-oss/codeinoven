import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadGrouping.v1`

export type ThreadGroup = 'Attention' | 'Drafts' | 'Unread' | 'Errors' | 'Spec' | 'Working' | 'Done'

/** Every group key, in the order a fresh install shows them.
 *
 *  This is the shape of the inbox, not just its membership: `groupThreadsByStatus`
 *  reads the display order from `threadGroupingState.order`, which starts here and
 *  only moves when the user drags a status in the inbox menu to where they want it.
 *  Restoring the default puts the statuses back in this order. */
export const THREAD_GROUPS: readonly ThreadGroup[] = [
  'Attention',
  'Drafts',
  'Unread',
  'Errors',
  'Spec',
  'Working',
  'Done'
]

interface StoredGrouping {
  enabled: boolean
  folded: Record<ThreadGroup, boolean>
  hiddenGroups: ThreadGroup[]
  order: ThreadGroup[]
}

function isThreadGroup(value: unknown): value is ThreadGroup {
  return typeof value === 'string' && (THREAD_GROUPS as readonly string[]).includes(value)
}

/**
 * A stored order made whole again.
 *
 * The names this app knows can outlive or outnumber the ones a stored order was
 * written with: a group added in a later version is not in the saved list, and a
 * group that no longer exists may still be in it. Unknown names are dropped and
 * missing ones are appended in their default order, so the inbox always draws
 * every status exactly once no matter what storage holds.
 */
function normalizeOrder(value: unknown): ThreadGroup[] {
  const order: ThreadGroup[] = []
  if (Array.isArray(value)) {
    for (const candidate of value) {
      if (!isThreadGroup(candidate) || order.includes(candidate)) continue
      order.push(candidate)
    }
  }
  for (const group of THREAD_GROUPS) {
    if (!order.includes(group)) order.push(group)
  }
  return order
}

function defaults(): StoredGrouping {
  return {
    enabled: false,
    hiddenGroups: [],
    order: [...THREAD_GROUPS],
    folded: {
      Attention: false,
      Drafts: false,
      Unread: false,
      Errors: false,
      Spec: false,
      Working: false,
      Done: false
    }
  }
}

function load(): StoredGrouping {
  const state = defaults()
  if (typeof window === 'undefined') return state
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return state
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return state
    const record = parsed as Record<string, unknown>
    if (typeof record.enabled === 'boolean') state.enabled = record.enabled
    const hiddenGroups = record.hiddenGroups
    if (Array.isArray(hiddenGroups)) {
      state.hiddenGroups = THREAD_GROUPS.filter((group) => hiddenGroups.includes(group))
    }
    state.order = normalizeOrder(record.order)
    const folded = record.folded
    if (folded !== null && typeof folded === 'object') {
      const stored = folded as Record<string, unknown>
      for (const group of THREAD_GROUPS) {
        if (typeof stored[group] === 'boolean') state.folded[group] = stored[group]
      }
    }
  } catch {
    // A corrupt or unavailable preference must not break the threads view.
  }
  return state
}

const restored = load()

/**
 * Threads-view status grouping: whether the inbox toggle is on, which groups the
 * user folded or hid, and the order the user arranged the statuses in. These
 * preferences survive restarts through localStorage, mirroring
 * `thread-project-filter.svelte.ts` and `pinned-fold.svelte.ts`.
 */
class ThreadGroupingState {
  #hiddenGroups = $state.raw<ThreadGroup[]>(restored.hiddenGroups)
  #enabled = $state(restored.enabled)
  #folded = $state<Record<ThreadGroup, boolean>>(restored.folded)
  #order = $state.raw<ThreadGroup[]>(restored.order)

  get enabled(): boolean {
    return this.#enabled
  }

  /**
   * The order the status groups are drawn in, everywhere they are drawn.
   *
   * One list answers for the sidebar's sections and for the drop resolution that
   * writes a dragged row's anchor, so a status the user moved cannot be drawn in
   * one order and resolved against another.
   */
  get order(): readonly ThreadGroup[] {
    return this.#order
  }

  /** Whether the statuses still sit in the order a fresh install shows them. */
  get isDefaultOrder(): boolean {
    return this.#order.every((group, index) => group === THREAD_GROUPS[index])
  }

  get isAll(): boolean {
    return this.#hiddenGroups.length === 0
  }

  get selectedCount(): number {
    return THREAD_GROUPS.length - this.#hiddenGroups.length
  }

  isVisible(group: ThreadGroup): boolean {
    return !this.#hiddenGroups.includes(group)
  }

  setAllVisible(visible: boolean): void {
    this.#hiddenGroups = visible ? [] : [...THREAD_GROUPS]
    this.persist()
  }

  setVisible(group: ThreadGroup, visible: boolean): void {
    this.#hiddenGroups = visible
      ? this.#hiddenGroups.filter((candidate) => candidate !== group)
      : THREAD_GROUPS.filter(
          (candidate) => candidate === group || this.#hiddenGroups.includes(candidate)
        )
    this.persist()
  }

  /** Whether the given group is folded (its threads hidden). */
  isFolded(group: ThreadGroup): boolean {
    return this.#folded[group]
  }

  toggleEnabled(): void {
    this.#enabled = !this.#enabled
    this.persist()
  }

  toggleFold(group: ThreadGroup): void {
    this.#folded[group] = !this.#folded[group]
    this.persist()
  }

  /**
   * Move one status beside another, the arrangement a drag produces.
   *
   * The dragged status is lifted out of the list and reinserted on the side of the
   * target the pointer came from, exactly as the drop indicator promised. A move
   * that changes nothing writes nothing, so a drag that lands a row where it
   * already was cannot push a redundant write through to every screen.
   */
  moveGroup(dragged: ThreadGroup, target: ThreadGroup, position: 'before' | 'after'): void {
    if (dragged === target) return
    const next = this.#order.filter((group) => group !== dragged)
    const at = next.indexOf(target)
    if (at === -1) return
    next.splice(position === 'before' ? at : at + 1, 0, dragged)
    if (next.every((group, index) => group === this.#order[index])) return
    this.#order = next
    this.persist()
  }

  /** Put every status back where a fresh install shows it. */
  restoreDefaultOrder(): void {
    if (this.isDefaultOrder) return
    this.#order = [...THREAD_GROUPS]
    this.persist()
  }

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          enabled: this.#enabled,
          folded: this.#folded,
          hiddenGroups: this.#hiddenGroups,
          order: this.#order
        })
      )
    } catch {
      // The preference is optional; unavailable storage must not break the UI.
    }
  }
}

export const threadGroupingState = new ThreadGroupingState()
