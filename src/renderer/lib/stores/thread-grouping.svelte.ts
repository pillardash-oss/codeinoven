import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadGrouping.v1`

export type ThreadGroup = 'Attention' | 'Unread' | 'Errors' | 'Spec' | 'Working' | 'Done'

/** Every group key, used to validate a stored fold map. Display order lives in
 *  `groupThreadsByStatus` in `workspace-thread-helpers.ts`. */
export const THREAD_GROUPS: readonly ThreadGroup[] = [
  'Attention',
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
}

function defaults(): StoredGrouping {
  return {
    enabled: false,
    hiddenGroups: [],
    folded: {
      Attention: false,
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
 * Threads-view status grouping: whether the inbox toggle is on, and which
 * groups the user folded or hid. These preferences survive restarts through localStorage,
 * mirroring `thread-project-filter.svelte.ts` and `pinned-fold.svelte.ts`.
 */
class ThreadGroupingState {
  #hiddenGroups = $state.raw<ThreadGroup[]>(restored.hiddenGroups)
  #enabled = $state(restored.enabled)
  #folded = $state<Record<ThreadGroup, boolean>>(restored.folded)

  get enabled(): boolean {
    return this.#enabled
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

  private persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          enabled: this.#enabled,
          folded: this.#folded,
          hiddenGroups: this.#hiddenGroups
        })
      )
    } catch {
      // The preference is optional; unavailable storage must not break the UI.
    }
  }
}

export const threadGroupingState = new ThreadGroupingState()
