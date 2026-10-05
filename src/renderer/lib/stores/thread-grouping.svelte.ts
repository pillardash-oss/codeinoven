import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.threadGrouping.v1`

export type ThreadGroup = 'Attention' | 'Unread' | 'Errors' | 'Spec' | 'Working' | 'Done'

/** Every group key, used to validate a stored fold map. Display order lives in
 *  `groupThreadsByStatus` in `workspace-thread-helpers.ts`. */
const GROUP_KEYS: ThreadGroup[] = ['Attention', 'Unread', 'Errors', 'Spec', 'Working', 'Done']

interface StoredGrouping {
  enabled: boolean
  folded: Record<ThreadGroup, boolean>
}

function defaults(): StoredGrouping {
  return {
    enabled: false,
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
    const folded = record.folded
    if (folded !== null && typeof folded === 'object') {
      const stored = folded as Record<string, unknown>
      for (const group of GROUP_KEYS) {
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
 * groups the user folded. Both survive restarts through localStorage,
 * mirroring `thread-project-filter.svelte.ts` and `pinned-fold.svelte.ts`.
 */
class ThreadGroupingState {
  #enabled = $state(restored.enabled)
  #folded = $state<Record<ThreadGroup, boolean>>(restored.folded)

  get enabled(): boolean {
    return this.#enabled
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
        JSON.stringify({ enabled: this.#enabled, folded: this.#folded })
      )
    } catch {
      // The preference is optional; unavailable storage must not break the UI.
    }
  }
}

export const threadGroupingState = new ThreadGroupingState()
