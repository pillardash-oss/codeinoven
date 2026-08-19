import { APP_SLUG } from '$shared/brand'
import type { ThreadSortMode } from './workspace.svelte'

const STORAGE_KEY = `${APP_SLUG}.threadSortMode.v1`

function load(): ThreadSortMode {
  if (typeof window === 'undefined') return 'default'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'status' || raw === 'time') return raw
  } catch {
    // Storage unavailable — fall back to the default order.
  }
  return 'default'
}

/**
 * Persisted sort mode for the Threads view.
 *
 * `default` keeps the normal ordering, `status` groups threads by attention
 * (todo → unread → need attention → done), `time` orders purely by the last
 * activity timestamp.
 */
class ThreadSortStore {
  mode = $state<ThreadSortMode>(load())

  setMode(mode: ThreadSortMode): void {
    this.mode = mode
    this.persist()
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, this.mode)
    } catch {
      // Sort preference is optional; unavailable storage must not break the app.
    }
  }
}

export const threadSortState = new ThreadSortStore()
